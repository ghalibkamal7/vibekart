import { corsHeaders, isAllowedOrigin, jsonResponse } from './cors';
import {
  createUserProfileDoc,
  commitFirestoreWrites,
  getOrderDoc,
  getProductDoc,
  getProductPrivateDoc,
  getVersionedDocument,
  saveOrderTwoDoc,
  toFirestoreFields,
  updateOrderPaymentDoc,
  userProfileExists,
} from './firestore';
import { createFirebaseCustomToken, createUserWithPhone, findUserByPhone, getGoogleAccessToken, parseServiceAccount, verifyFirebaseIdToken } from './google';
import { sendOtpSms } from './msg91';
import {
  checkIpRateLimit,
  deleteOtpRecord,
  generateOtp,
  getOtpRecord,
  hashOtp,
  MAX_VERIFY_ATTEMPTS,
  normalizePhone,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_SECONDS,
  setOtpRecord,
} from './otp-store';

export interface Env {
  OTP_KV: KVNamespace;
  /** Non-secret config (wrangler.toml [vars]) — the DLT-approved MSG91
   * template id this Worker sends the OTP through. See README.md. */
  MSG91_TEMPLATE_ID: string;
  /** Cloudflare Worker secret — set with `wrangler secret put MSG91_AUTH_KEY`. */
  MSG91_AUTH_KEY: string;
  /** Cloudflare Worker secret — the full Firebase service-account JSON, as
   * one string. Set with `wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON`. */
  FIREBASE_SERVICE_ACCOUNT_JSON: string;

  // Direct Google Pay India UPI & Acquiring Bank Configuration (optional until onboarding)
  MERCHANT_NAME?: string;
  MERCHANT_VPA?: string;
  MERCHANT_MCC?: string;
  GPAY_ENV?: string; // 'TEST' | 'PRODUCTION'
  BANK_PSP_API_URL?: string;
  BANK_PSP_API_KEY?: string;
  BANK_PSP_MERCHANT_ID?: string;
}

async function handleSendOtp(request: Request, env: Env, origin: string | null): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const withinLimit = await checkIpRateLimit(env.OTP_KV, ip, 10, 60 * 60); // 10 sends/hour/IP
  if (!withinLimit) {
    return jsonResponse({ error: 'Too many requests. Please try again later.' }, 429, origin);
  }

  const body = await request.json().catch(() => null);
  const phone = normalizePhone((body as { phone?: string } | null)?.phone);
  if (!phone) {
    return jsonResponse({ error: 'Enter a valid 10-digit mobile number.' }, 400, origin);
  }

  const existing = await getOtpRecord(env.OTP_KV, phone.local);
  if (existing && Date.now() - existing.createdAt < OTP_RESEND_COOLDOWN_MS) {
    return jsonResponse({ error: 'Please wait a moment before requesting another OTP.' }, 429, origin);
  }

  const otp = generateOtp(); // Web Crypto CSPRNG — see otp-store.ts
  await setOtpRecord(env.OTP_KV, phone.local, {
    otpHash: await hashOtp(otp, phone.local),
    expiresAt: Date.now() + OTP_TTL_SECONDS * 1000,
    attempts: 0,
    createdAt: Date.now(),
  });

  try {
    await sendOtpSms({
      authKey: env.MSG91_AUTH_KEY,
      templateId: env.MSG91_TEMPLATE_ID,
      phoneE164: phone.e164,
      otp,
      otpExpiryMinutes: Math.ceil(OTP_TTL_SECONDS / 60),
    });
  } catch (error) {
    console.error('[otp] sendOtpSms failed', error);
    // The OTP is already stored — delete it so a failed-to-deliver code
    // can't later be "verified" by someone who never received it.
    await deleteOtpRecord(env.OTP_KV, phone.local);
    return jsonResponse({ error: "We couldn't send the OTP. Please try again." }, 502, origin);
  }

  return jsonResponse({ success: true }, 200, origin);
}

async function handleVerifyOtp(request: Request, env: Env, origin: string | null): Promise<Response> {
  const body = await request.json().catch(() => null);
  const phone = normalizePhone((body as { phone?: string } | null)?.phone);
  const otp = String((body as { otp?: string } | null)?.otp ?? '');
  if (!phone || !otp) {
    return jsonResponse({ error: 'Phone number and OTP are both required.' }, 400, origin);
  }

  const record = await getOtpRecord(env.OTP_KV, phone.local);
  if (!record) {
    return jsonResponse({ error: 'Request an OTP first.' }, 400, origin);
  }
  if (Date.now() > record.expiresAt) {
    await deleteOtpRecord(env.OTP_KV, phone.local);
    return jsonResponse({ error: 'This OTP has expired. Please request a new one.' }, 400, origin);
  }
  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    await deleteOtpRecord(env.OTP_KV, phone.local);
    return jsonResponse({ error: 'Too many incorrect attempts. Please request a new OTP.' }, 429, origin);
  }
  // The client's claim of "verified" is never trusted on its own — this
  // hash comparison against the server-held record is the actual check.
  if (record.otpHash !== (await hashOtp(otp, phone.local))) {
    await setOtpRecord(env.OTP_KV, phone.local, { ...record, attempts: record.attempts + 1 });
    return jsonResponse({ error: 'Incorrect OTP.' }, 401, origin);
  }

  // Correct OTP — invalidate it immediately so it can't be replayed.
  await deleteOtpRecord(env.OTP_KV, phone.local);

  try {
    const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const accessToken = await getGoogleAccessToken(sa);

    let uid = await findUserByPhone(sa, accessToken, phone.e164);
    if (!uid) {
      // Brand-new user: create the Auth user and their Firestore profile together.
      uid = await createUserWithPhone(sa, accessToken, phone.e164);
      await createUserProfileDoc(sa, accessToken, uid, phone.e164);
    } else {
      // Existing Auth user — still verify their Firestore profile actually
      // exists. An Auth user with no profile doc (e.g. a previous sign-in
      // that failed partway through) must be repaired here, not just on
      // first-ever sign-in.
      const hasProfile = await userProfileExists(sa, accessToken, uid);
      if (!hasProfile) {
        await createUserProfileDoc(sa, accessToken, uid, phone.e164);
      }
    }

    const token = await createFirebaseCustomToken(sa, uid);
    return jsonResponse({ success: true, token }, 200, origin);
  } catch (error) {
    console.error('[otp] Firebase sign-in step failed', error);
    return jsonResponse({ error: "We couldn't verify that OTP. Please try again." }, 500, origin);
  }
}

async function handleCreateOrder(request: Request, env: Env, origin: string | null): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing or invalid Authorization header.' }, 401, origin);
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    return jsonResponse({ error: 'Authentication token required.' }, 401, origin);
  }

  let sa;
  try {
    sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    return jsonResponse({ error: 'Server authentication configuration is missing.' }, 503, origin);
  }

  const accessToken = await getGoogleAccessToken(sa);
  const user = await verifyFirebaseIdToken(sa, accessToken, idToken);
  if (!user) {
    return jsonResponse({ error: 'Invalid or expired authentication token.' }, 401, origin);
  }

  const body = (await request.json().catch(() => null)) as {
    items?: Array<{ productId: string; quantity: number; option?: string }>;
    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;
    paymentMethod?: string;
    idempotencyKey?: string;
    customerUtr?: string;
  } | null;

  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return jsonResponse({ error: 'Order must contain at least one item.' }, 400, origin);
  }

  const customerName = String(body.customerName || '').trim();
  const customerPhone = String(body.customerPhone || '').trim();
  const customerAddress = String(body.customerAddress || '').trim();
  const paymentMethod = String(body.paymentMethod || '').trim();
  const customerUtr = body.customerUtr ? String(body.customerUtr).trim().slice(0, 100) : undefined;

  // COD is no longer accepted — online payment only
  if (paymentMethod !== 'UPI') {
    return jsonResponse({ error: 'Only online payment (UPI) is accepted. Cash on delivery is no longer available.' }, 400, origin);
  }

  if (!customerName || !customerPhone || !customerAddress) {
    return jsonResponse({ error: 'Customer name, phone, and delivery address are required.' }, 400, origin);
  }

  // Idempotency protection against duplicate taps / network retries
  const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey).trim() : null;
  if (idempotencyKey) {
    const cached = await env.OTP_KV.get(`idemp:${idempotencyKey}`);
    if (cached) {
      try {
        const cachedOrder = JSON.parse(cached);
        return jsonResponse({ success: true, order: cachedOrder }, 200, origin);
      } catch {
        // Fall through to fresh creation
      }
    }
  }

  const publicItems: Array<{
    productId: string;
    name: string;
    option?: string;
    quantity: number;
    unitPrice: number;
    itemTotal: number;
  }> = [];

  const privateItems: Array<{
    productId: string;
    unitCost: number;
    sourceUrl?: string;
    sourceCode?: string;
  }> = [];

  let total = 0;
  let costTotal = 0;

  for (const item of body.items) {
    if (!item.productId || typeof item.productId !== 'string') {
      return jsonResponse({ error: 'Invalid product item format.' }, 400, origin);
    }
    const qty = Math.floor(Number(item.quantity));
    if (!Number.isFinite(qty) || qty < 1 || qty > 50) {
      return jsonResponse({ error: 'Item quantity must be an integer between 1 and 50.' }, 400, origin);
    }

    const productSnap = await getProductDoc(sa, accessToken, item.productId);
    if (!productSnap.exists || !productSnap.data) {
      return jsonResponse({ error: `Product with ID ${item.productId} was not found.` }, 400, origin);
    }
    const pData = productSnap.data;
    if (pData.enabled === false) {
      return jsonResponse({ error: `Product "${pData.name || item.productId}" is currently not available.` }, 400, origin);
    }
    if (pData.inStock === false) {
      return jsonResponse({ error: `Product "${pData.name || item.productId}" is out of stock.` }, 400, origin);
    }

    // Never trust client price: always read authoritatively from public product document
    const serverPrice = Math.max(0, Math.round(Number(pData.price) || 0));
    const itemTotal = serverPrice * qty;
    total += itemTotal;

    publicItems.push({
      productId: item.productId,
      name: String(pData.name || 'Product'),
      option: item.option ? String(item.option) : undefined,
      quantity: qty,
      unitPrice: serverPrice,
      itemTotal,
    });

    const privSnap = await getProductPrivateDoc(sa, accessToken, item.productId);
    const privData = privSnap.data || {};
    const baseCost = Math.max(0, Math.round(Number(privData.baseCost) || 0));
    costTotal += baseCost * qty;

    privateItems.push({
      productId: item.productId,
      unitCost: baseCost,
      sourceUrl: privData.sourceUrl ? String(privData.sourceUrl) : undefined,
      sourceCode: privData.sourceCode ? String(privData.sourceCode) : undefined,
    });
  }

  const profitTotal = total - costTotal;
  const orderId = `ord-${Date.now().toString().slice(-6)}-${crypto.randomUUID().slice(0, 6)}`;
  // Alphanumeric UPI transaction reference (max 35 chars): e.g. VKUPI1729000000000ABCDEF12
  const paymentReference = `VKUPI${Date.now()}${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const nowIso = new Date().toISOString();

  const publicOrderDoc = {
    id: orderId,
    customerUid: user.uid,
    customerName,
    customerPhone,
    customerAddress,
    paymentMethod,
    paymentStatus: 'Pending',
    paymentReference,
    ...(customerUtr ? { customerUtr } : {}),
    amountPaise: Math.round(total * 100),
    currency: 'INR',
    paymentInitiatedAt: nowIso,
    status: 'Placed',
    items: publicItems,
    total,
    costReconciled: true,
    date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    createdAt: nowIso,
  };

  const privateOrderDoc = {
    costTotal,
    profitTotal,
    items: privateItems,
    reconciled: true,
    createdAt: nowIso,
  };

  try {
    await saveOrderTwoDoc(sa, accessToken, orderId, publicOrderDoc, privateOrderDoc);
  } catch (err) {
    console.error('[order] Failed to save order docs', err);
    return jsonResponse({ error: 'Failed to record order. Please try again.' }, 500, origin);
  }

  if (idempotencyKey) {
    await env.OTP_KV.put(`idemp:${idempotencyKey}`, JSON.stringify(publicOrderDoc), { expirationTtl: 600 });
  }

  return jsonResponse({ success: true, order: publicOrderDoc }, 201, origin);
}

async function handlePaymentConfig(request: Request, env: Env, origin: string | null): Promise<Response> {
  const isMerchantConfigured = Boolean(env.MERCHANT_VPA && env.MERCHANT_NAME);
  const isBankConfigured = Boolean(env.BANK_PSP_API_URL);

  const missing: string[] = [];
  if (!env.MERCHANT_VPA) missing.push('MERCHANT_VPA');
  if (!env.MERCHANT_NAME) missing.push('MERCHANT_NAME');
  if (!env.BANK_PSP_API_URL) missing.push('BANK_PSP_API_URL');

  return jsonResponse({
    gpayEnabled: isMerchantConfigured && isBankConfigured,
    status: (isMerchantConfigured && isBankConfigured) ? 'CONFIGURED' : 'SETUP_PENDING',
    merchantName: env.MERCHANT_NAME || 'VibeKart',
    merchantVpa: env.MERCHANT_VPA || null,
    merchantMcc: env.MERCHANT_MCC || '5399',
    environment: env.GPAY_ENV || 'TEST',
    missing: missing.length > 0 ? missing : undefined,
    message: (isMerchantConfigured && isBankConfigured)
      ? 'Payment gateway configured.'
      : 'Direct Google Pay India UPI setup is pending merchant onboarding and bank PSP verification credentials.',
  }, 200, origin);
}

async function handlePaymentVerify(request: Request, env: Env, origin: string | null): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing or invalid Authorization header.' }, 401, origin);
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    return jsonResponse({ error: 'Authentication token required.' }, 401, origin);
  }

  let sa;
  try {
    sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    return jsonResponse({ error: 'Server authentication configuration is missing.' }, 503, origin);
  }

  const accessToken = await getGoogleAccessToken(sa);
  const user = await verifyFirebaseIdToken(sa, accessToken, idToken);
  if (!user) {
    return jsonResponse({ error: 'Invalid or expired authentication token.' }, 401, origin);
  }

  const body = (await request.json().catch(() => null)) as {
    orderId?: string;
    paymentReference?: string;
    bankRrn?: string;
  } | null;

  const orderId = body?.orderId ? String(body.orderId).trim() : null;
  if (!orderId) {
    return jsonResponse({ error: 'Order ID is required for payment verification.' }, 400, origin);
  }

  // Retrieve authoritative order document from Firestore
  const orderSnap = await getOrderDoc(sa, accessToken, orderId);
  if (!orderSnap.exists || !orderSnap.data) {
    return jsonResponse({ error: `Order with ID ${orderId} was not found.` }, 404, origin);
  }

  const orderData = orderSnap.data;

  // Strict ownership check: only the customer who placed the order can verify
  if (orderData.customerUid !== user.uid) {
    return jsonResponse({ error: 'You are not authorized to access or verify this order.' }, 403, origin);
  }

  // Idempotency: If already verified and marked Paid, return success immediately
  if (orderData.paymentStatus === 'Paid') {
    return jsonResponse({
      success: true,
      verified: true,
      paymentStatus: 'Paid',
      message: 'Order payment is already verified.',
      orderId,
    }, 200, origin);
  }

  // Server-authoritative check: Bank PSP status inquiry API
  // Google Pay is a payment orchestrator / UPI app, not an acquiring bank.
  // Direct integration requires bank PSP inquiry API to confirm settlement.
  if (!env.BANK_PSP_API_URL) {
    return jsonResponse({
      success: false,
      verified: false,
      error: 'Direct Google Pay UPI verification is currently pending merchant onboarding and Bank PSP API configuration on the server. Your payment remains in Pending status.',
      paymentStatus: orderData.paymentStatus || 'Pending',
      orderId,
    }, 400, origin);
  }

  try {
    const bankResp = await fetch(`${env.BANK_PSP_API_URL}/upi/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.BANK_PSP_API_KEY ? { 'Authorization': `Bearer ${env.BANK_PSP_API_KEY}` } : {}),
        ...(env.BANK_PSP_MERCHANT_ID ? { 'X-Merchant-ID': env.BANK_PSP_MERCHANT_ID } : {}),
      },
      body: JSON.stringify({
        merchantTranId: orderData.paymentReference || body?.paymentReference,
        orderId,
        amount: orderData.total,
      }),
    });

    if (!bankResp.ok) {
      return jsonResponse({
        success: false,
        verified: false,
        error: 'Bank PSP status inquiry failed or returned an error.',
        paymentStatus: orderData.paymentStatus || 'Pending',
      }, 502, origin);
    }

    const bankResult = (await bankResp.json().catch(() => null)) as {
      status?: string;
      rrn?: string;
      code?: string;
    } | null;

    if (bankResult && (bankResult.status === 'SUCCESS' || bankResult.status === 'COMPLETED' || bankResult.status === 'PAID')) {
      const verifiedAt = new Date().toISOString();
      const rrn = bankResult.rrn || body?.bankRrn || null;

      await updateOrderPaymentDoc(sa, accessToken, orderId, {
        paymentStatus: 'Paid',
        paymentVerifiedAt: verifiedAt,
        ...(rrn ? { bankRrn: String(rrn) } : {}),
      });

      return jsonResponse({
        success: true,
        verified: true,
        paymentStatus: 'Paid',
        paymentVerifiedAt: verifiedAt,
        bankRrn: rrn,
        orderId,
      }, 200, origin);
    }

    return jsonResponse({
      success: false,
      verified: false,
      paymentStatus: orderData.paymentStatus || 'Pending',
      message: 'Payment has not been confirmed by the bank.',
      bankResponse: bankResult?.status || 'UNCONFIRMED',
    }, 200, origin);
  } catch (bankErr) {
    console.error('[payment-verify] Bank PSP inquiry failed:', bankErr);
    return jsonResponse({
      error: 'Failed to communicate with acquiring bank PSP.',
      paymentStatus: orderData.paymentStatus || 'Pending',
    }, 502, origin);
  }
}

type AuthenticatedCaller = {
  sa: ReturnType<typeof parseServiceAccount>;
  accessToken: string;
  uid: string;
  email?: string;
  profile: Record<string, any>;
};

async function authenticateCaller(
  request: Request,
  env: Env,
  origin: string | null,
): Promise<AuthenticatedCaller | Response> {
  const authorization = request.headers.get('Authorization') ?? '';
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!idToken) return jsonResponse({ error: 'Authentication token required.' }, 401, origin);

  try {
    const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const accessToken = await getGoogleAccessToken(sa);
    const user = await verifyFirebaseIdToken(sa, accessToken, idToken);
    if (!user) return jsonResponse({ error: 'Invalid or expired authentication token.' }, 401, origin);

    const profile = await getVersionedDocument(sa, accessToken, `users/${user.uid}`);
    if (!profile.exists || !profile.data || profile.data.status === 'suspended') {
      return jsonResponse({ error: 'This account is not authorized to use payment features.' }, 403, origin);
    }
    return { sa, accessToken, uid: user.uid, email: user.email, profile: profile.data };
  } catch (error) {
    console.error('[payment] Caller authentication failed', error);
    return jsonResponse({ error: 'Payment service authentication is temporarily unavailable.' }, 503, origin);
  }
}

function isAuthenticatedCaller(value: AuthenticatedCaller | Response): value is AuthenticatedCaller {
  return !(value instanceof Response);
}

function firestoreDocumentName(sa: ReturnType<typeof parseServiceAccount>, path: string): string {
  return `projects/${sa.project_id}/databases/(default)/documents/${path}`;
}

async function hashValue(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashReference(value: string): Promise<string> {
  return hashValue(value.trim().toLocaleUpperCase('en-US'));
}

async function handleCreatePaymentAttempt(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;

  const body = (await request.json().catch(() => null)) as {
    items?: Array<{ productId: string; quantity: number; option?: string }>;
    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;
    paymentMethod?: string;
    idempotencyKey?: string;
  } | null;
  if (!body || body.paymentMethod !== 'UPI') {
    return jsonResponse({ error: 'Only UPI payment attempts are accepted.' }, 400, origin);
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    return jsonResponse({ error: 'Payment attempt must contain between 1 and 50 items.' }, 400, origin);
  }

  const customerName = String(body.customerName ?? '').trim();
  const customerPhone = String(body.customerPhone ?? '').trim();
  const customerAddress = String(body.customerAddress ?? '').trim();
  const idempotencyKey = String(body.idempotencyKey ?? '').trim();
  if (
    !customerName || customerName.length > 120 ||
    !customerPhone || customerPhone.length > 40 ||
    !customerAddress || customerAddress.length > 1000
  ) {
    return jsonResponse({ error: 'Enter a valid name, phone number, and delivery address.' }, 400, origin);
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    return jsonResponse({ error: 'A valid payment attempt idempotency key is required.' }, 400, origin);
  }

  const attemptKey = await hashValue(`${caller.uid}:${idempotencyKey}`);
  const attemptId = `pay-${attemptKey}`;
  const existing = await getVersionedDocument(caller.sa, caller.accessToken, `payment_attempts/${attemptId}`);
  if (existing.exists) {
    if (existing.data?.customerUid !== caller.uid) {
      return jsonResponse({ error: 'Payment attempt could not be loaded.' }, 409, origin);
    }
    return jsonResponse({ success: true, attempt: existing.data }, 200, origin);
  }

  const publicItems: Array<Record<string, unknown>> = [];
  const privateItems: Array<Record<string, unknown>> = [];
  let total = 0;
  let costTotal = 0;
  for (const item of body.items) {
    if (!item || typeof item.productId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(item.productId)) {
      return jsonResponse({ error: 'Invalid product item format.' }, 400, origin);
    }
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      return jsonResponse({ error: 'Item quantity must be an integer between 1 and 50.' }, 400, origin);
    }

    const product = await getProductDoc(caller.sa, caller.accessToken, item.productId);
    if (!product.exists || !product.data) {
      return jsonResponse({ error: `Product ${item.productId} is no longer available.` }, 400, origin);
    }
    if (product.data.enabled === false || product.data.inStock === false) {
      return jsonResponse({ error: `Product "${product.data.name || item.productId}" is unavailable or out of stock.` }, 409, origin);
    }
    const unitPrice = Number(product.data.price);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      return jsonResponse({ error: `Product "${product.data.name || item.productId}" has an invalid price.` }, 409, origin);
    }
    const itemTotal = unitPrice * quantity;
    total += itemTotal;
    publicItems.push({
      productId: item.productId,
      name: String(product.data.name || 'Product').slice(0, 200),
      ...(typeof item.option === 'string' && item.option.trim()
        ? { option: item.option.trim().slice(0, 100) }
        : {}),
      quantity,
      unitPrice,
      itemTotal,
    });

    const privateProduct = await getProductPrivateDoc(caller.sa, caller.accessToken, item.productId);
    const privateData = privateProduct.data || {};
    const unitCost = Math.max(0, Math.round(Number(privateData.baseCost) || 0));
    costTotal += unitCost * quantity;
    privateItems.push({
      productId: item.productId,
      unitCost,
      ...(privateData.sourceUrl ? { sourceUrl: String(privateData.sourceUrl) } : {}),
      ...(privateData.sourceCode ? { sourceCode: String(privateData.sourceCode) } : {}),
    });
  }
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(total * 100) || total <= 0) {
    return jsonResponse({ error: 'The payable amount must be greater than zero.' }, 400, origin);
  }

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const attempt = {
    id: attemptId,
    customerUid: caller.uid,
    ...(caller.email ? { customerEmail: caller.email } : {}),
    customerName,
    customerPhone,
    customerAddress,
    items: publicItems,
    total,
    amountPaise: total * 100,
    currency: 'INR',
    paymentMethod: 'UPI',
    status: 'Pending',
    createdAt,
    expiresAt,
  };
  const privateAttempt = {
    costTotal,
    profitTotal: total - costTotal,
    items: privateItems,
    createdAt,
  };
  const writes = [
    {
      update: {
        name: firestoreDocumentName(caller.sa, `payment_attempts/${attemptId}`),
        fields: toFirestoreFields(attempt),
      },
      currentDocument: { exists: false },
    },
    {
      update: {
        name: firestoreDocumentName(caller.sa, `payment_attempts/${attemptId}/private/data`),
        fields: toFirestoreFields(privateAttempt),
      },
      currentDocument: { exists: false },
    },
  ];
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, writes);
    return jsonResponse({ success: true, attempt }, 201, origin);
  } catch (error) {
    // A retry with the same idempotency key may race the first commit.
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, `payment_attempts/${attemptId}`);
    if (retry.exists && retry.data?.customerUid === caller.uid) {
      return jsonResponse({ success: true, attempt: retry.data }, 200, origin);
    }
    console.error('[payment] Failed to create payment attempt', error);
    return jsonResponse({ error: 'Could not create the payment attempt. Please try again.' }, 500, origin);
  }
}

async function handleSubmitPaymentDetails(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const body = (await request.json().catch(() => null)) as { attemptId?: string; customerUtr?: string } | null;
  const attemptId = String(body?.attemptId ?? '').trim();
  const customerUtr = String(body?.customerUtr ?? '').trim();
  if (!/^pay-[a-f0-9]{64}$/.test(attemptId) || !customerUtr || customerUtr.length > 100) {
    return jsonResponse({ error: 'Enter the UTR/reference number from your payment app.' }, 400, origin);
  }

  const attempt = await getVersionedDocument(caller.sa, caller.accessToken, `payment_attempts/${attemptId}`);
  if (!attempt.exists || !attempt.data) return jsonResponse({ error: 'Payment attempt not found.' }, 404, origin);
  if (attempt.data.customerUid !== caller.uid) return jsonResponse({ error: 'You cannot update this payment attempt.' }, 403, origin);
  if (attempt.data.status === 'Submitted' && attempt.data.customerUtr === customerUtr) {
    return jsonResponse({ success: true, status: 'Submitted', message: 'Payment details were already submitted.' }, 200, origin);
  }
  if (!['Pending', 'Submitted'].includes(String(attempt.data.status))) {
    return jsonResponse({ error: 'This payment attempt is no longer accepting payment details.' }, 409, origin);
  }
  if (!attempt.updateTime) return jsonResponse({ error: 'Payment attempt version is unavailable.' }, 503, origin);

  const submittedAt = new Date().toISOString();
  const path = `payment_attempts/${attemptId}`;
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, [{
      update: {
        name: firestoreDocumentName(caller.sa, path),
        fields: toFirestoreFields({ customerUtr, submittedAt, status: 'Submitted' }),
      },
      updateMask: { fieldPaths: ['customerUtr', 'submittedAt', 'status'] },
      currentDocument: { updateTime: attempt.updateTime },
    }]);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, path);
    if (retry.data?.customerUid === caller.uid && retry.data.status === 'Submitted' && retry.data.customerUtr === customerUtr) {
      return jsonResponse({ success: true, status: 'Submitted', message: 'Payment details were already submitted.' }, 200, origin);
    }
    console.error('[payment] Failed to submit payment details', error);
    return jsonResponse({ error: 'Could not submit payment details. Please retry.' }, 409, origin);
  }
  return jsonResponse({
    success: true,
    status: 'Submitted',
    message: 'Payment details submitted. Your payment is awaiting verification.',
  }, 200, origin);
}

async function requireAdmin(
  caller: AuthenticatedCaller,
  origin: string | null,
): Promise<Response | null> {
  if (caller.profile.role !== 'admin' || caller.profile.status === 'suspended') {
    return jsonResponse({ error: 'Only an active administrator can review payments.' }, 403, origin);
  }
  return null;
}

async function handleConfirmPaymentAttempt(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const denied = await requireAdmin(caller, origin);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    attemptId?: string;
    actualCreditConfirmed?: boolean;
  } | null;
  const attemptId = String(body?.attemptId ?? '').trim();
  if (!/^pay-[a-f0-9]{64}$/.test(attemptId) || body?.actualCreditConfirmed !== true) {
    return jsonResponse({ error: 'Confirm that you checked the merchant account credit before verifying.' }, 400, origin);
  }

  const attemptPath = `payment_attempts/${attemptId}`;
  const attempt = await getVersionedDocument(caller.sa, caller.accessToken, attemptPath);
  if (!attempt.exists || !attempt.data) return jsonResponse({ error: 'Payment attempt not found.' }, 404, origin);
  if (attempt.data.status === 'Paid' && typeof attempt.data.orderId === 'string') {
    return jsonResponse({ success: true, orderId: attempt.data.orderId, status: 'Paid' }, 200, origin);
  }
  if (attempt.data.status !== 'Submitted' || !String(attempt.data.customerUtr ?? '').trim()) {
    return jsonResponse({ error: 'A submitted UTR is required before payment verification.' }, 409, origin);
  }
  if (!attempt.updateTime) return jsonResponse({ error: 'Payment attempt version is unavailable.' }, 503, origin);

  const reference = String(attempt.data.customerUtr).trim();
  const referenceHash = await hashReference(reference);
  const claimPath = `payment_reference_claims/${referenceHash}`;
  const claim = await getVersionedDocument(caller.sa, caller.accessToken, claimPath);
  const orderId = `ord-${attemptId.slice(4)}`;
  if (claim.exists && claim.data?.attemptId !== attemptId) {
    return jsonResponse({ error: 'This transaction reference has already been used for another payment.' }, 409, origin);
  }

  const privateAttempt = await getVersionedDocument(caller.sa, caller.accessToken, `${attemptPath}/private/data`);
  const privateData = privateAttempt.data || {};
  const now = new Date().toISOString();
  const order = {
    id: orderId,
    customerUid: attempt.data.customerUid,
    ...(attempt.data.customerEmail ? { customerEmail: attempt.data.customerEmail } : {}),
    customerName: attempt.data.customerName,
    customerPhone: attempt.data.customerPhone,
    customerAddress: attempt.data.customerAddress,
    paymentMethod: 'UPI',
    paymentStatus: 'Paid',
    customerUtr: reference,
    paymentVerifiedAt: now,
    amountPaise: attempt.data.amountPaise,
    currency: 'INR',
    paymentInitiatedAt: attempt.data.createdAt,
    status: 'Placed',
    items: attempt.data.items,
    total: attempt.data.total,
    costReconciled: true,
    date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    createdAt: attempt.data.createdAt,
  };
  const privateOrder = {
    costTotal: Number(privateData.costTotal) || 0,
    profitTotal: Number(privateData.profitTotal) || 0,
    items: Array.isArray(privateData.items) ? privateData.items : [],
    reconciled: true,
    createdAt: now,
  };
  const attemptUpdates = {
    status: 'Paid',
    orderId,
    paymentVerifiedAt: now,
    verifiedByUid: caller.uid,
  };
  const writes: Record<string, unknown>[] = [
    {
      update: {
        name: firestoreDocumentName(caller.sa, attemptPath),
        fields: toFirestoreFields(attemptUpdates),
      },
      updateMask: { fieldPaths: Object.keys(attemptUpdates) },
      currentDocument: { updateTime: attempt.updateTime },
    },
    {
      update: {
        name: firestoreDocumentName(caller.sa, `orders/${orderId}`),
        fields: toFirestoreFields(order),
      },
      currentDocument: { exists: false },
    },
    {
      update: {
        name: firestoreDocumentName(caller.sa, `orders/${orderId}/private/data`),
        fields: toFirestoreFields(privateOrder),
      },
      currentDocument: { exists: false },
    },
  ];
  if (!claim.exists) {
    writes.push({
      update: {
        name: firestoreDocumentName(caller.sa, claimPath),
        fields: toFirestoreFields({ reference, attemptId, orderId, claimedAt: now }),
      },
      currentDocument: { exists: false },
    });
  }

  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, writes);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, attemptPath);
    if (retry.data?.status === 'Paid' && typeof retry.data.orderId === 'string') {
      return jsonResponse({ success: true, orderId: retry.data.orderId, status: 'Paid' }, 200, origin);
    }
    const claimed = await getVersionedDocument(caller.sa, caller.accessToken, claimPath);
    if (claimed.exists && claimed.data?.attemptId !== attemptId) {
      return jsonResponse({ error: 'This transaction reference has already been used for another payment.' }, 409, origin);
    }
    console.error('[payment] Atomic payment confirmation failed', error);
    return jsonResponse({ error: 'Payment confirmation could not be saved. No order was finalized.' }, 409, origin);
  }
  return jsonResponse({ success: true, orderId, status: 'Paid' }, 200, origin);
}

async function handlePaymentAttemptAction(
  request: Request,
  env: Env,
  origin: string | null,
  action: 'reject' | 'cancel' | 'expire',
): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const denied = await requireAdmin(caller, origin);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    attemptId?: string;
    reason?: string;
    adminReviewed?: boolean;
  } | null;
  const attemptId = String(body?.attemptId ?? '').trim();
  const reason = String(body?.reason ?? '').trim();
  if (!/^pay-[a-f0-9]{64}$/.test(attemptId) || !reason || reason.length > 300 || body?.adminReviewed !== true) {
    return jsonResponse({ error: 'A review confirmation and reason are required.' }, 400, origin);
  }
  const path = `payment_attempts/${attemptId}`;
  const attempt = await getVersionedDocument(caller.sa, caller.accessToken, path);
  if (!attempt.exists || !attempt.data) return jsonResponse({ error: 'Payment attempt not found.' }, 404, origin);
  if (['Paid', 'Rejected', 'Cancelled', 'Expired'].includes(String(attempt.data.status))) {
    return jsonResponse({ success: true, status: attempt.data.status }, 200, origin);
  }
  if (action === 'reject' && attempt.data.status !== 'Submitted') {
    return jsonResponse({ error: 'Only submitted payment details can be rejected.' }, 409, origin);
  }
  if (action === 'expire' && Date.parse(String(attempt.data.expiresAt)) > Date.now()) {
    return jsonResponse({ error: 'This payment attempt has not reached its expiry time.' }, 409, origin);
  }
  if (!attempt.updateTime) return jsonResponse({ error: 'Payment attempt version is unavailable.' }, 503, origin);

  const status = action === 'reject' ? 'Rejected' : action === 'expire' ? 'Expired' : 'Cancelled';
  const now = new Date().toISOString();
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, [{
      update: {
        name: firestoreDocumentName(caller.sa, path),
        fields: toFirestoreFields({
          status,
          rejectionReason: reason,
          reviewedAt: now,
          reviewedByUid: caller.uid,
        }),
      },
      updateMask: { fieldPaths: ['status', 'rejectionReason', 'reviewedAt', 'reviewedByUid'] },
      currentDocument: { updateTime: attempt.updateTime },
    }]);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, path);
    if (retry.data?.status === status) return jsonResponse({ success: true, status }, 200, origin);
    console.error('[payment] Failed to update payment attempt status', error);
    return jsonResponse({ error: 'Could not update payment attempt. Please refresh and retry.' }, 409, origin);
  }
  return jsonResponse({ success: true, status }, 200, origin);
}

async function handleConfirmLegacyOrderPayment(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const denied = await requireAdmin(caller, origin);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    orderId?: string;
    customerUtr?: string;
    actualCreditConfirmed?: boolean;
  } | null;
  const orderId = String(body?.orderId ?? '').trim();
  const reference = String(body?.customerUtr ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId) || !reference || reference.length > 100 || body?.actualCreditConfirmed !== true) {
    return jsonResponse({ error: 'A transaction reference and actual-credit confirmation are required.' }, 400, origin);
  }
  const orderPath = `orders/${orderId}`;
  const order = await getVersionedDocument(caller.sa, caller.accessToken, orderPath);
  if (!order.exists || !order.data) return jsonResponse({ error: 'Order not found.' }, 404, origin);
  if (order.data.paymentStatus === 'Paid') return jsonResponse({ success: true, orderId, status: 'Paid' }, 200, origin);
  if (order.data.paymentMethod !== 'UPI' || order.data.paymentStatus === 'Failed' || order.data.status === 'Cancelled') {
    return jsonResponse({ error: 'This legacy order is not eligible for payment confirmation.' }, 409, origin);
  }
  if (!order.updateTime) return jsonResponse({ error: 'Order version is unavailable.' }, 503, origin);

  const referenceHash = await hashReference(reference);
  const claimPath = `payment_reference_claims/${referenceHash}`;
  const claim = await getVersionedDocument(caller.sa, caller.accessToken, claimPath);
  if (claim.exists && claim.data?.orderId !== orderId) {
    return jsonResponse({ error: 'This transaction reference has already been used for another payment.' }, 409, origin);
  }
  const now = new Date().toISOString();
  const updates = {
    paymentStatus: 'Paid',
    customerUtr: reference,
    paymentVerifiedAt: now,
  };
  const writes: Record<string, unknown>[] = [{
    update: {
      name: firestoreDocumentName(caller.sa, orderPath),
      fields: toFirestoreFields(updates),
    },
    updateMask: { fieldPaths: Object.keys(updates) },
    currentDocument: { updateTime: order.updateTime },
  }];
  if (!claim.exists) {
    writes.push({
      update: {
        name: firestoreDocumentName(caller.sa, claimPath),
        fields: toFirestoreFields({ reference, orderId, claimedAt: now }),
      },
      currentDocument: { exists: false },
    });
  }
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, writes);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, orderPath);
    if (retry.data?.paymentStatus === 'Paid') return jsonResponse({ success: true, orderId, status: 'Paid' }, 200, origin);
    console.error('[payment] Failed to verify legacy order payment', error);
    return jsonResponse({ error: 'Could not confirm legacy order payment. Please refresh and retry.' }, 409, origin);
  }
  return jsonResponse({ success: true, orderId, status: 'Paid' }, 200, origin);
}

async function handleRejectLegacyOrderPayment(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const denied = await requireAdmin(caller, origin);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    orderId?: string;
    reason?: string;
    adminReviewed?: boolean;
  } | null;
  const orderId = String(body?.orderId ?? '').trim();
  const reason = String(body?.reason ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId) || !reason || reason.length > 300 || body?.adminReviewed !== true) {
    return jsonResponse({ error: 'A review confirmation and reason are required.' }, 400, origin);
  }
  const path = `orders/${orderId}`;
  const order = await getVersionedDocument(caller.sa, caller.accessToken, path);
  if (!order.exists || !order.data) return jsonResponse({ error: 'Order not found.' }, 404, origin);
  if (order.data.paymentStatus === 'Paid') {
    return jsonResponse({ error: 'A paid order cannot be rejected from payment review.' }, 409, origin);
  }
  if (!order.updateTime) return jsonResponse({ error: 'Order version is unavailable.' }, 503, origin);
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, [{
      update: {
        name: firestoreDocumentName(caller.sa, path),
        fields: toFirestoreFields({ paymentStatus: 'Failed', status: 'Cancelled', paymentReviewReason: reason }),
      },
      updateMask: { fieldPaths: ['paymentStatus', 'status', 'paymentReviewReason'] },
      currentDocument: { updateTime: order.updateTime },
    }]);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, path);
    if (retry.data?.paymentStatus === 'Failed' && retry.data.status === 'Cancelled') {
      return jsonResponse({ success: true, orderId, status: 'Rejected' }, 200, origin);
    }
    console.error('[payment] Failed to reject legacy order payment', error);
    return jsonResponse({ error: 'Could not reject legacy order payment. Please refresh and retry.' }, 409, origin);
  }
  return jsonResponse({ success: true, orderId, status: 'Rejected' }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (origin && !isAllowedOrigin(origin)) {
      return jsonResponse({ error: 'Origin not allowed.' }, 403, null);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/payment/config') {
        return handlePaymentConfig(request, env, origin);
      }

      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed.' }, 405, origin);
      }

      if (url.pathname === '/send-otp') return handleSendOtp(request, env, origin);
      if (url.pathname === '/verify-otp') return handleVerifyOtp(request, env, origin);
      if (url.pathname === '/payment-attempts/create') return handleCreatePaymentAttempt(request, env, origin);
      if (url.pathname === '/create-order') {
        return jsonResponse({ error: 'Direct order creation is disabled. Create a payment attempt instead.' }, 410, origin);
      }
      if (url.pathname === '/payment-attempts/submit') return handleSubmitPaymentDetails(request, env, origin);
      if (url.pathname === '/admin/payment-attempts/confirm') return handleConfirmPaymentAttempt(request, env, origin);
      if (url.pathname === '/admin/payment-attempts/reject') return handlePaymentAttemptAction(request, env, origin, 'reject');
      if (url.pathname === '/admin/payment-attempts/cancel') return handlePaymentAttemptAction(request, env, origin, 'cancel');
      if (url.pathname === '/admin/payment-attempts/expire') return handlePaymentAttemptAction(request, env, origin, 'expire');
      if (url.pathname === '/admin/legacy-orders/confirm-payment') return handleConfirmLegacyOrderPayment(request, env, origin);
      if (url.pathname === '/admin/legacy-orders/reject-payment') return handleRejectLegacyOrderPayment(request, env, origin);
      return jsonResponse({ error: 'Not found.' }, 404, origin);
    } catch (error) {
      console.error('[worker] Unhandled request failure', error);
      return jsonResponse({ error: 'The request could not be completed. Please retry.' }, 500, origin);
    }
  },
};