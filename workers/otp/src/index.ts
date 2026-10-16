import { corsHeaders, isAllowedOrigin, jsonResponse } from './cors';
import {
  createUserProfileDoc,
  commitFirestoreWrites,
  fromFirestoreFields,
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
  /** Optional future-only configuration for reactivating phone OTP via MSG91. */
  MSG91_TEMPLATE_ID?: string;
  /** Optional future-only secret for reactivating phone OTP via MSG91. */
  MSG91_AUTH_KEY?: string;
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
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
}

type CloudinaryAssetType = 'product' | 'payment-qr';
const MAX_CLOUDINARY_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_CLOUDINARY_REQUEST_BYTES = MAX_CLOUDINARY_UPLOAD_BYTES + 64 * 1024;
const MAX_CLEANUP_ASSETS_PER_RUN = 25;
const STALE_CLOUDINARY_UPLOAD_MS = 30 * 60 * 1000;
const STALE_UNATTACHED_CLOUDINARY_ASSET_MS = 24 * 60 * 60 * 1000;
const PHONE_OTP_UNAVAILABLE_MESSAGE = 'Phone OTP sign-in is currently unavailable. Use Google or email and password.';

function phoneOtpUnavailableResponse(origin: string | null): Response {
  return jsonResponse({
    error: PHONE_OTP_UNAVAILABLE_MESSAGE,
    code: 'PHONE_OTP_UNAVAILABLE',
  }, 410, origin);
}

async function cloudinaryAssetPath(publicId: string): Promise<string> {
  return `cloudinary_assets/${await hashValue(publicId)}`;
}

function cloudinaryCleanupJobPath(assetType: CloudinaryAssetType, targetId: string): string {
  return `cloudinary_cleanup_jobs/${assetType === 'product' ? `product-${targetId}` : 'payment-settings-qr'}`;
}

function cloudinaryConfigError(env: Env): string | null {
  return env.CLOUDINARY_CLOUD_NAME?.trim() &&
    env.CLOUDINARY_API_KEY?.trim() &&
    env.CLOUDINARY_API_SECRET?.trim()
    ? null
    : 'Cloudinary Worker bindings are incomplete. Configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.';
}

async function cloudinarySignature(params: Record<string, string>, apiSecret: string): Promise<string> {
  const signatureBase = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${signatureBase}${apiSecret}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function detectedImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp' &&
    ['avif', 'avis'].includes(String.fromCharCode(...bytes.subarray(8, 12)))
  ) {
    return 'image/avif';
  }
  return null;
}

async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<{ bytes: Uint8Array | null; tooLarge: boolean }> {
  if (!request.body) return { bytes: new Uint8Array(), tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { bytes: null, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false };
}

async function handleSendOtp(request: Request, env: Env, origin: string | null): Promise<Response> {
  if (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID) {
    return jsonResponse({ error: 'Phone OTP provider configuration is unavailable.' }, 503, origin);
  }
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

async function handleCreateManualUpiOrder(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;

  const body = (await request.json().catch(() => null)) as {
    items?: Array<{ productId: string; quantity: number; option?: string }>;
    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;
    idempotencyKey?: string;
  } | null;
  if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    return jsonResponse({ error: 'An order must contain between 1 and 50 items.' }, 400, origin);
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
    return jsonResponse({ error: 'A valid order idempotency key is required.' }, 400, origin);
  }

  const orderId = `ord-${await hashValue(`${caller.uid}:${idempotencyKey}`)}`;
  const orderPath = `orders/${orderId}`;
  const existing = await getVersionedDocument(caller.sa, caller.accessToken, orderPath);
  if (existing.exists) {
    if (existing.data?.customerUid !== caller.uid) {
      return jsonResponse({ error: 'Order request could not be loaded.' }, 409, origin);
    }
    return jsonResponse({ success: true, order: existing.data }, 200, origin);
  }

  const paymentSettings = await getVersionedDocument(caller.sa, caller.accessToken, 'settings/payment');
  if (
    paymentSettings.data?.enabled !== true ||
    typeof paymentSettings.data.merchantVpa !== 'string' ||
    !paymentSettings.data.merchantVpa.trim()
  ) {
    return jsonResponse({ error: 'Manual UPI checkout is not enabled or merchant details are incomplete.' }, 409, origin);
  }

  const publicItems: Array<Record<string, unknown>> = [];
  const privateItems: Array<Record<string, unknown>> = [];
  let itemSubtotal = 0;
  let costTotal = 0;
  for (const item of body.items) {
    if (!item || typeof item.productId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(item.productId)) {
      return jsonResponse({ error: 'Invalid product item format.' }, 400, origin);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      return jsonResponse({ error: 'Order quantities must be between 1 and 99.' }, 400, origin);
    }

    const product = await getProductDoc(caller.sa, caller.accessToken, item.productId);
    if (!product.exists || !product.data) {
      return jsonResponse({ error: `Product ${item.productId} is no longer available.` }, 409, origin);
    }
    if (product.data.enabled === false || product.data.inStock === false) {
      return jsonResponse({ error: `Product "${product.data.name || item.productId}" is unavailable or out of stock.` }, 409, origin);
    }
    const unitPrice = Number(product.data.price);
    if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0) {
      return jsonResponse({ error: `Product "${product.data.name || item.productId}" has an invalid price.` }, 409, origin);
    }
    const itemTotal = unitPrice * item.quantity;
    itemSubtotal += itemTotal;
    if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(itemSubtotal)) {
      return jsonResponse({ error: 'The order subtotal is outside the supported range.' }, 400, origin);
    }
    publicItems.push({
      productId: item.productId,
      name: String(product.data.name || 'Product').slice(0, 200),
      ...(typeof item.option === 'string' && item.option.trim()
        ? { option: item.option.trim().slice(0, 100) }
        : {}),
      quantity: item.quantity,
      unitPrice,
      itemTotal,
    });

    const privateProduct = await getProductPrivateDoc(caller.sa, caller.accessToken, item.productId);
    const privateData = privateProduct.data || {};
    const unitCost = Number.isSafeInteger(privateData.baseCost) && privateData.baseCost >= 0
      ? privateData.baseCost
      : 0;
    costTotal += unitCost * item.quantity;
    if (!Number.isSafeInteger(costTotal)) {
      return jsonResponse({ error: 'The order cost is outside the supported range.' }, 400, origin);
    }
    privateItems.push({
      productId: item.productId,
      unitCost,
      ...(typeof privateData.sourceUrl === 'string' ? { sourceUrl: privateData.sourceUrl.slice(0, 2000) } : {}),
      ...(typeof privateData.sourceCode === 'string' ? { sourceCode: privateData.sourceCode.slice(0, 500) } : {}),
    });
  }
  if (itemSubtotal <= 0) {
    return jsonResponse({ error: 'The order subtotal must be greater than zero.' }, 400, origin);
  }

  const settingsSnapshot = await getVersionedDocument(caller.sa, caller.accessToken, 'settings/store');
  const settings = settingsSnapshot.data || {};
  const threshold = Number.isSafeInteger(settings.freeDeliveryThreshold) && settings.freeDeliveryThreshold >= 0
    ? settings.freeDeliveryThreshold
    : 499;
  const configuredCharge = Number.isSafeInteger(settings.deliveryCharge) && settings.deliveryCharge >= 0
    ? settings.deliveryCharge
    : 0;
  const deliveryMinDays = Number.isInteger(settings.deliveryMinDays) &&
    settings.deliveryMinDays >= 1 && settings.deliveryMinDays <= 60
    ? settings.deliveryMinDays
    : 4;
  const deliveryMaxDays = Number.isInteger(settings.deliveryMaxDays) &&
    settings.deliveryMaxDays >= deliveryMinDays && settings.deliveryMaxDays <= 60
    ? settings.deliveryMaxDays
    : Math.max(deliveryMinDays, 6);
  const deliveryCharge = settings.freeDeliveryEnabled === true && itemSubtotal >= threshold
    ? 0
    : configuredCharge;
  const total = itemSubtotal + deliveryCharge;
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(total * 100)) {
    return jsonResponse({ error: 'The payable amount is outside the supported range.' }, 400, origin);
  }

  const now = new Date().toISOString();
  const order = {
    id: orderId,
    customerUid: caller.uid,
    items: publicItems,
    itemSubtotal,
    deliveryCharge,
    deliveryMinDays,
    deliveryMaxDays,
    total,
    amountPaise: total * 100,
    currency: 'INR',
    paymentMethod: 'UPI',
    paymentStatus: 'Pending',
    paymentInitiatedAt: now,
    status: 'Placed',
    date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    customerName,
    customerPhone,
    customerAddress,
    createdAt: now,
  };
  const privateOrder = {
    costTotal,
    profitTotal: total - costTotal,
    items: privateItems,
    reconciled: true,
    createdAt: now,
  };
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, [
      {
        update: {
          name: firestoreDocumentName(caller.sa, orderPath),
          fields: toFirestoreFields(order),
        },
        currentDocument: { exists: false },
      },
      {
        update: {
          name: firestoreDocumentName(caller.sa, `${orderPath}/private/data`),
          fields: toFirestoreFields(privateOrder),
        },
        currentDocument: { exists: false },
      },
    ]);
    return jsonResponse({ success: true, order }, 201, origin);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, orderPath);
    if (retry.exists && retry.data?.customerUid === caller.uid) {
      return jsonResponse({ success: true, order: retry.data }, 200, origin);
    }
    console.error('[order] Failed to create manual UPI order', error);
    return jsonResponse({ error: 'Could not create the order. Please retry.' }, 500, origin);
  }
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

  let sa: ReturnType<typeof parseServiceAccount>;
  try {
    sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    return jsonResponse({ error: 'Firebase Worker authentication is not configured correctly.' }, 503, origin);
  }

  try {
    const accessToken = await getGoogleAccessToken(sa);
    const user = await verifyFirebaseIdToken(sa, accessToken, idToken);
    if (!user) return jsonResponse({ error: 'Invalid or expired authentication token.' }, 401, origin);

    const profile = await getVersionedDocument(sa, accessToken, `users/${user.uid}`);
    if (!profile.exists || !profile.data || profile.data.status === 'suspended') {
      return jsonResponse({ error: 'This account is not authorized to use payment features.' }, 403, origin);
    }
    return { sa, accessToken, uid: user.uid, email: user.email, profile: profile.data };
  } catch (error) {
    console.error('[auth] Firebase caller authentication failed', error);
    return jsonResponse({ error: 'Firebase caller authentication is temporarily unavailable.' }, 503, origin);
  }
}

function isAuthenticatedCaller(value: AuthenticatedCaller | Response): value is AuthenticatedCaller {
  return !(value instanceof Response);
}

function firestoreDocumentName(sa: ReturnType<typeof parseServiceAccount>, path: string): string {
  return `projects/${sa.project_id}/databases/(default)/documents/${path}`;
}

async function queueCloudinaryCleanup(
  sa: ReturnType<typeof parseServiceAccount>,
  accessToken: string,
  assetType: CloudinaryAssetType,
  targetId: string,
  ownerUid: string,
  publicIds: string[],
  unattachedOnly = false,
): Promise<Record<string, unknown>[]> {
  const jobPath = cloudinaryCleanupJobPath(assetType, targetId);
  const currentJob = await getVersionedDocument(sa, accessToken, jobPath);
  const queuedIds = [...new Set([
    ...(Array.isArray(currentJob.data?.publicIds) ? currentJob.data.publicIds : []),
    ...publicIds,
  ])];
  if (!queuedIds.length) return [];

  const writes: Record<string, unknown>[] = [];
  for (const publicId of queuedIds) {
    if (typeof publicId !== 'string' || !publicId || publicId.length > 255) {
      throw new Error('Product contains an invalid Cloudinary public ID.');
    }
    const assetPath = await cloudinaryAssetPath(publicId);
    const asset = await getVersionedDocument(sa, accessToken, assetPath);
    if (
      !asset.exists ||
      asset.data?.publicId !== publicId ||
      asset.data?.assetType !== assetType ||
      asset.data?.targetId !== targetId ||
      (unattachedOnly && publicIds.includes(publicId) &&
        !['uploading', 'uploaded', 'cleanup_pending'].includes(String(asset.data?.status)))
    ) {
      throw new Error('A legacy Cloudinary image has no verified ownership record. Migrate its ownership before removing or deleting it.');
    }
    if (!asset.updateTime) throw new Error('Cloudinary image ownership record version is unavailable.');
    writes.push({
      update: {
        name: firestoreDocumentName(sa, assetPath),
        fields: toFirestoreFields({ ...asset.data, status: 'cleanup_pending' }),
      },
      updateMask: { fieldPaths: [...Object.keys(asset.data), 'status'] },
      currentDocument: { updateTime: asset.updateTime },
    });
  }

  const jobData = {
    assetType,
    targetId,
    ownerUid: currentJob.data?.ownerUid || ownerUid,
    publicIds: queuedIds,
    updatedAt: new Date().toISOString(),
  };
  writes.push({
    update: {
      name: firestoreDocumentName(sa, jobPath),
      fields: toFirestoreFields(jobData),
    },
    updateMask: { fieldPaths: Object.keys(jobData) },
    currentDocument: currentJob.exists
      ? { updateTime: currentJob.updateTime }
      : { exists: false },
  });
  return writes;
}

async function queueUnreferencedCloudinaryAssets(
  sa: ReturnType<typeof parseServiceAccount>,
  accessToken: string,
  assetType: CloudinaryAssetType,
  targetId: string,
  ownerUid: string,
  publicIds: string[],
): Promise<boolean> {
  const ownerPath = assetType === 'product' ? `products/${targetId}` : 'settings/payment';
  const owner = await getVersionedDocument(sa, accessToken, ownerPath);
  const referencedIds = assetType === 'product'
    ? (Array.isArray(owner.data?.imagePublicIds) ? owner.data.imagePublicIds : [])
    : [owner.data?.qrImagePublicId];
  const unreferencedIds = publicIds.filter((publicId) => !referencedIds.includes(publicId));
  if (!unreferencedIds.length) return false;

  const writes = await queueCloudinaryCleanup(
    sa,
    accessToken,
    assetType,
    targetId,
    ownerUid,
    unreferencedIds,
  );
  if (!writes.length) return false;
  await commitFirestoreWrites(sa, accessToken, writes);
  return true;
}

async function queueFailedCloudinaryUpload(
  sa: ReturnType<typeof parseServiceAccount>,
  accessToken: string,
  assetType: CloudinaryAssetType,
  targetId: string,
  ownerUid: string,
  publicId: string,
  stage: 'request-failed' | 'upload-rejected' | 'ownership-finalization-failed',
): Promise<boolean> {
  try {
    const writes = await queueCloudinaryCleanup(sa, accessToken, assetType, targetId, ownerUid, [publicId], true);
    await commitFirestoreWrites(sa, accessToken, writes);
    return true;
  } catch {
    console.error('[cloudinary] Failed to persist upload cleanup; stale-upload recovery remains necessary.', {
      assetType,
      stage,
    });
    return false;
  }
}

async function runCloudinaryCleanup(
  env: Env,
  sa: ReturnType<typeof parseServiceAccount>,
  accessToken: string,
  assetType: CloudinaryAssetType,
  targetId: string,
): Promise<{ pending: boolean; reason?: string }> {
  const configError = cloudinaryConfigError(env);
  if (configError) return { pending: true, reason: configError };

  const jobPath = cloudinaryCleanupJobPath(assetType, targetId);
  const job = await getVersionedDocument(sa, accessToken, jobPath);
  if (!job.exists || !job.data || !job.updateTime) return { pending: false };
  const queuedIds = Array.isArray(job.data.publicIds)
    ? job.data.publicIds.filter((id): id is string => typeof id === 'string')
    : [];
  const publicIds = queuedIds.slice(0, MAX_CLEANUP_ASSETS_PER_RUN);
  const remainingIds = queuedIds.slice(publicIds.length);
  if (!publicIds.length) {
    await commitFirestoreWrites(sa, accessToken, [{
      delete: firestoreDocumentName(sa, jobPath),
      currentDocument: { updateTime: job.updateTime },
    }]);
    return { pending: false };
  }

  const targetPath = assetType === 'product' ? `products/${targetId}` : 'settings/payment';
  const target = await getVersionedDocument(sa, accessToken, targetPath);
  const currentIds = assetType === 'product'
    ? (Array.isArray(target.data?.imagePublicIds) ? target.data.imagePublicIds : [])
    : [target.data?.qrImagePublicId];
  if (publicIds.some((publicId) => currentIds.includes(publicId))) {
    return { pending: true, reason: 'An image queued for cleanup is still referenced by its Firestore record.' };
  }

  for (const publicId of publicIds) {
    const assetPath = await cloudinaryAssetPath(publicId);
    const asset = await getVersionedDocument(sa, accessToken, assetPath);
    if (
      !asset.exists ||
      !asset.updateTime ||
      asset.data?.publicId !== publicId ||
      asset.data?.assetType !== assetType ||
      asset.data?.targetId !== targetId ||
      asset.data?.status !== 'cleanup_pending'
    ) {
      return { pending: true, reason: 'A Cloudinary ownership record needs review before cleanup.' };
    }

    const form = new URLSearchParams();
    form.append('public_ids[]', publicId);
    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.CLOUDINARY_CLOUD_NAME!)}/resources/image/upload`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`)}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        },
      );
    } catch (error) {
      console.error('[cloudinary] Asset cleanup request failed', error);
      return { pending: true, reason: 'Cloudinary could not be reached; cleanup will be retried.' };
    }
    const result = (await response.json().catch(() => null)) as { deleted?: Record<string, string> } | null;
    if (!response.ok || !['deleted', 'not_found'].includes(result?.deleted?.[publicId] ?? '')) {
      console.error('[cloudinary] Asset cleanup was incomplete', { status: response.status });
      return { pending: true, reason: `Cloudinary returned HTTP ${response.status}; cleanup will be retried.` };
    }
  }

  const assetRecords = await Promise.all(publicIds.map(async (publicId) => {
    const path = await cloudinaryAssetPath(publicId);
    return { publicId, path, record: await getVersionedDocument(sa, accessToken, path) };
  }));
  try {
    await commitFirestoreWrites(sa, accessToken, [
      ...assetRecords.map(({ path, record }) => {
        if (!record.exists || !record.updateTime) {
          throw new Error('Cloudinary ownership record disappeared during cleanup.');
        }
        return {
            delete: firestoreDocumentName(sa, path),
            currentDocument: { updateTime: record.updateTime },
          };
      }),
      ...(remainingIds.length
        ? [{
            update: {
              name: firestoreDocumentName(sa, jobPath),
              fields: toFirestoreFields({ ...job.data, publicIds: remainingIds, updatedAt: new Date().toISOString() }),
            },
            updateMask: { fieldPaths: [...Object.keys(job.data), 'publicIds', 'updatedAt'] },
            currentDocument: { updateTime: job.updateTime },
          }]
        : [{
            delete: firestoreDocumentName(sa, jobPath),
            currentDocument: { updateTime: job.updateTime },
          }]),
    ]);
  } catch (error) {
    console.error('[cloudinary] Cleanup finalization failed; the original job remains eligible for idempotent retry.');
    return { pending: true, reason: 'Cleanup finalization was interrupted; retry will reconcile the job.' };
  }
  return remainingIds.length
    ? { pending: true, reason: 'Cleanup is continuing in bounded batches.' }
    : { pending: false };
}

async function handleCloudinaryUpload(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const configError = cloudinaryConfigError(env);
  if (configError) return jsonResponse({ error: configError }, 503, origin);

  try {
    if (!await checkIpRateLimit(env.OTP_KV, `cloudinary:${caller.uid}`, 30, 60 * 60)) {
      return jsonResponse({ error: 'Too many image uploads. Please try again later.' }, 429, origin);
    }
  } catch {
    console.error('[cloudinary] Upload rate-limit check failed.');
    return jsonResponse({ error: 'Image upload is temporarily unavailable. Please retry later.' }, 503, origin);
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    return jsonResponse({ error: 'Image upload request must be multipart form data.' }, 400, origin);
  }
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return jsonResponse({ error: 'Image upload request has an invalid content length.' }, 400, origin);
    }
    if (declaredLength > MAX_CLOUDINARY_REQUEST_BYTES) {
      return jsonResponse({ error: 'Image upload request exceeds the maximum allowed size.' }, 413, origin);
    }
  }
  let bodyBytes: Uint8Array | null;
  try {
    const bounded = await readBoundedRequestBody(request, MAX_CLOUDINARY_REQUEST_BYTES);
    if (bounded.tooLarge) {
      return jsonResponse({ error: 'Image upload request exceeds the maximum allowed size.' }, 413, origin);
    }
    bodyBytes = bounded.bytes;
  } catch {
    return jsonResponse({ error: 'Image upload request body could not be read.' }, 400, origin);
  }
  if (!bodyBytes) return jsonResponse({ error: 'Image upload request body could not be read.' }, 400, origin);

  let form: FormData;
  try {
    const formRequest = new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bodyBytes,
    });
    form = await formRequest.formData();
  } catch {
    return jsonResponse({ error: 'Image upload request must be multipart form data.' }, 400, origin);
  }
  const fileValue: unknown = form.get('file');
  const assetType = form.get('assetType');
  const targetId = form.get('targetId');
  if (!isUploadFile(fileValue)) {
    return jsonResponse({ error: 'Image upload request must include one file.' }, 400, origin);
  }
  if (fileValue.size < 1 || fileValue.size > MAX_CLOUDINARY_UPLOAD_BYTES) {
    return jsonResponse({ error: 'Choose an image smaller than 10 MB.' }, 413, origin);
  }
  const file = fileValue;
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const verifiedMime = detectedImageMime(fileBytes);
  if (!verifiedMime) return jsonResponse({ error: 'The file is not a supported JPEG, PNG, WebP, or AVIF image.' }, 415, origin);

  function isUploadFile(value: unknown): value is File {
    return typeof value === 'object' &&
      value !== null &&
      'size' in value &&
      typeof value.size === 'number' &&
      'type' in value &&
      typeof value.type === 'string' &&
      'name' in value &&
      typeof value.name === 'string';
  }
  if (assetType === 'product') {
    if (typeof targetId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(targetId)) {
      return jsonResponse({ error: 'A valid product ID is required.' }, 400, origin);
    }
    if (!['seller', 'admin'].includes(String(caller.profile.role))) {
      return jsonResponse({ error: 'Only an authorized seller or administrator can upload product images.' }, 403, origin);
    }
    const product = await getVersionedDocument(caller.sa, caller.accessToken, `products/${targetId}`);
    if (
      !product.exists ||
      (caller.profile.role !== 'admin' && product.data?.createdByUid !== caller.uid) ||
      product.data?.cloudinaryDeletionPending === true
    ) {
      return jsonResponse({ error: 'This product is not available for image uploads by your account.' }, 403, origin);
    }
  } else if (assetType === 'payment-qr' && targetId === 'settings/payment') {
    if (caller.profile.role !== 'admin') {
      return jsonResponse({ error: 'Only an administrator can upload the payment QR image.' }, 403, origin);
    }
  } else {
    return jsonResponse({ error: 'A supported image ownership target is required.' }, 400, origin);
  }

  const resolvedType = assetType as CloudinaryAssetType;
  const resolvedTargetId = targetId as string;
  const publicId = resolvedType === 'product'
    ? `vibekart/products/${resolvedTargetId}/${crypto.randomUUID().replace(/-/g, '')}`
    : `vibekart/payment/${crypto.randomUUID().replace(/-/g, '')}`;
  const assetPath = await cloudinaryAssetPath(publicId);
  const now = new Date().toISOString();
  const assetData = {
    publicId,
    assetType: resolvedType,
    targetId: resolvedTargetId,
    ownerUid: caller.uid,
    status: 'uploading',
    createdAt: now,
  };
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, [{
      update: {
        name: firestoreDocumentName(caller.sa, assetPath),
        fields: toFirestoreFields(assetData),
      },
      currentDocument: { exists: false },
    }]);
  } catch (error) {
    console.error('[cloudinary] Could not reserve image ownership record', error);
    return jsonResponse({ error: 'Image ownership could not be recorded; no upload was started.' }, 503, origin);
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedParams = { overwrite: 'false', public_id: publicId, timestamp };
  const signature = await cloudinarySignature(signedParams, env.CLOUDINARY_API_SECRET!);
  const uploadForm = new FormData();
  uploadForm.set('file', new Blob([fileBytes], { type: verifiedMime }), 'vibekart-upload');
  uploadForm.set('api_key', env.CLOUDINARY_API_KEY!);
  uploadForm.set('overwrite', 'false');
  uploadForm.set('public_id', publicId);
  uploadForm.set('timestamp', timestamp);
  uploadForm.set('signature', signature);

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.CLOUDINARY_CLOUD_NAME!)}/image/upload`,
      { method: 'POST', body: uploadForm },
    );
  } catch (error) {
    console.error('[cloudinary] Upload request failed.');
    const cleanupQueued = await queueFailedCloudinaryUpload(
      caller.sa,
      caller.accessToken,
      resolvedType,
      resolvedTargetId,
      caller.uid,
      publicId,
      'request-failed',
    );
    return jsonResponse({
      error: cleanupQueued
        ? 'Cloudinary could not be reached. The reserved asset is queued for cleanup; retry the upload.'
        : 'Cloudinary could not be reached and cleanup could not be recorded. Stale-upload recovery will retry.',
    }, 502, origin);
  }

  const uploadResult = (await uploadResponse.json().catch(() => null)) as {
    secure_url?: string;
    public_id?: string;
  } | null;
  if (!uploadResponse.ok || !uploadResult?.secure_url || uploadResult.public_id !== publicId) {
    console.error('[cloudinary] Upload rejected', { status: uploadResponse.status });
    const cleanupQueued = await queueFailedCloudinaryUpload(
      caller.sa,
      caller.accessToken,
      resolvedType,
      resolvedTargetId,
      caller.uid,
      publicId,
      'upload-rejected',
    );
    return jsonResponse({
      error: cleanupQueued
        ? `Cloudinary rejected the image upload (HTTP ${uploadResponse.status}); cleanup is queued.`
        : `Cloudinary rejected the image upload (HTTP ${uploadResponse.status}); cleanup could not be recorded and stale-upload recovery will retry.`,
    }, 502, origin);
  }

  const reserved = await getVersionedDocument(caller.sa, caller.accessToken, assetPath);
  try {
    if (!reserved.updateTime) throw new Error('Reserved image ownership version is missing.');
    await commitFirestoreWrites(caller.sa, caller.accessToken, [{
      update: {
        name: firestoreDocumentName(caller.sa, assetPath),
        fields: toFirestoreFields({ ...assetData, status: 'uploaded', secureUrl: uploadResult.secure_url }),
      },
      updateMask: { fieldPaths: [...Object.keys(assetData), 'secureUrl'] },
      currentDocument: { updateTime: reserved.updateTime },
    }]);
  } catch (error) {
    console.error('[cloudinary] Upload ownership confirmation failed.');
    const cleanupQueued = await queueFailedCloudinaryUpload(
      caller.sa,
      caller.accessToken,
      resolvedType,
      resolvedTargetId,
      caller.uid,
      publicId,
      'ownership-finalization-failed',
    );
    return jsonResponse({
      error: cleanupQueued
        ? 'The image uploaded but its ownership record could not be finalized; cleanup is queued.'
        : 'The image uploaded but its ownership record could not be finalized or queued; stale-upload recovery will retry.',
    }, 502, origin);
  }
  return jsonResponse({ success: true, url: uploadResult.secure_url, publicId }, 201, origin);
}

async function handleUpdateProductImages(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  if (!['seller', 'admin'].includes(String(caller.profile.role))) {
    return jsonResponse({ error: 'Only an authorized seller or administrator can edit product images.' }, 403, origin);
  }
  const body = (await request.json().catch(() => null)) as {
    productId?: string;
    imageUrls?: unknown;
    imagePublicIds?: unknown;
    removedPublicIds?: unknown;
  } | null;
  const productId = String(body?.productId ?? '').trim();
  if (
    !/^[A-Za-z0-9_-]{1,150}$/.test(productId) ||
    !Array.isArray(body?.imageUrls) ||
    !Array.isArray(body?.imagePublicIds) ||
    body.imageUrls.length !== body.imagePublicIds.length ||
    body.imageUrls.length > 10 ||
    !body.imageUrls.every((url) => typeof url === 'string' && /^https:\/\/res\.cloudinary\.com\//.test(url)) ||
    !body.imagePublicIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 255)
  ) {
    return jsonResponse({ error: 'A valid ordered set of product image URLs and public IDs is required.' }, 400, origin);
  }
  const productPath = `products/${productId}`;
  const product = await getVersionedDocument(caller.sa, caller.accessToken, productPath);
  if (
    !product.exists ||
    !product.data ||
    !product.updateTime ||
    (caller.profile.role !== 'admin' && product.data.createdByUid !== caller.uid)
  ) {
    return jsonResponse({ error: 'This product is not available for image changes by your account.' }, 403, origin);
  }
  const nextIds = body.imagePublicIds as string[];
  const nextUrls = body.imageUrls as string[];
  if (new Set(nextIds).size !== nextIds.length) {
    return jsonResponse({ error: 'Duplicate Cloudinary image IDs are not allowed.' }, 400, origin);
  }
  const oldIds = Array.isArray(product.data.imagePublicIds) ? product.data.imagePublicIds : [];
  const oldUrls = Array.isArray(product.data.imageUrls) ? product.data.imageUrls : [];
  if (oldUrls.length !== oldIds.length) {
    return jsonResponse({ error: 'This product has legacy images without verified ownership IDs. Migrate them before changing its images.' }, 409, origin);
  }
  for (let index = 0; index < nextIds.length; index += 1) {
    const publicId = nextIds[index];
    const oldIndex = oldIds.indexOf(publicId);
    if (oldIndex >= 0) {
      if (oldUrls[oldIndex] !== nextUrls[index]) {
        return jsonResponse({ error: 'Existing image URLs cannot be changed independently of their verified image IDs.' }, 409, origin);
      }
    }
    const asset = await getVersionedDocument(
      caller.sa,
      caller.accessToken,
      await cloudinaryAssetPath(publicId),
    );
    if (!asset.exists && oldIndex >= 0) continue;
    if (
      !asset.exists ||
      asset.data?.assetType !== 'product' ||
      asset.data?.targetId !== productId ||
      (oldIndex >= 0
        ? !['uploaded', 'attached'].includes(String(asset.data?.status))
        : asset.data?.status !== 'uploaded') ||
      asset.data?.secureUrl !== nextUrls[index]
    ) {
      return jsonResponse({ error: 'A new product image has no matching verified upload record.' }, 409, origin);
    }
  }

  const removedFromProduct = oldIds.filter((id) => !nextIds.includes(id));
  const requestedRemoved = Array.isArray(body.removedPublicIds)
    ? body.removedPublicIds.filter((id): id is string => typeof id === 'string')
    : [];
  const cleanupIds = [...new Set([...removedFromProduct, ...requestedRemoved])]
    .filter((id) => !nextIds.includes(id));
  let cleanupWrites: Record<string, unknown>[];
  try {
    cleanupWrites = await queueCloudinaryCleanup(
      caller.sa,
      caller.accessToken,
      'product',
      productId,
      String(product.data.createdByUid || caller.uid),
      cleanupIds,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image ownership could not be verified.';
    return jsonResponse({ error: message }, 409, origin);
  }

  const writes: Record<string, unknown>[] = [
    {
      update: {
        name: firestoreDocumentName(caller.sa, productPath),
        fields: toFirestoreFields({ imageUrls: nextUrls, imagePublicIds: nextIds }),
      },
      updateMask: { fieldPaths: ['imageUrls', 'imagePublicIds'] },
      currentDocument: { updateTime: product.updateTime },
    },
    ...cleanupWrites,
  ];
  for (const publicId of nextIds) {
    if (oldIds.includes(publicId)) continue;
    const assetPath = await cloudinaryAssetPath(publicId);
    const asset = await getVersionedDocument(caller.sa, caller.accessToken, assetPath);
    if (!asset.updateTime || !asset.data) {
      return jsonResponse({ error: 'Image ownership changed; refresh the product and retry.' }, 409, origin);
    }
    writes.push({
      update: {
        name: firestoreDocumentName(caller.sa, assetPath),
        fields: toFirestoreFields({ ...asset.data, status: 'attached' }),
      },
      updateMask: { fieldPaths: [...Object.keys(asset.data), 'status'] },
      currentDocument: { updateTime: asset.updateTime },
    });
  }
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, writes);
  } catch (error) {
    console.error('[product] Image metadata update failed', error);
    let cleanupState = 'Uploaded images remain available for retry.';
    try {
      const queued = await queueUnreferencedCloudinaryAssets(
        caller.sa,
        caller.accessToken,
        'product',
        productId,
        String(product.data.createdByUid || caller.uid),
        nextIds.filter((id) => !oldIds.includes(id)),
      );
      if (queued) {
        cleanupState = 'Unreferenced uploaded images are queued for cleanup retry.';
      }
    } catch (cleanupError) {
      console.error('[product] Could not queue cleanup after metadata failure', cleanupError);
      cleanupState = 'Automatic cleanup could not be queued; retry image cleanup from the app.';
    }
    return jsonResponse({ error: `Product image metadata could not be saved. ${cleanupState}` }, 409, origin);
  }
  const cleanup = await runCloudinaryCleanup(env, caller.sa, caller.accessToken, 'product', productId);
  return jsonResponse({ success: true, cleanupPending: cleanup.pending, cleanupMessage: cleanup.reason }, 200, origin);
}

async function handleUpdatePaymentQrImage(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  if (caller.profile.role !== 'admin') {
    return jsonResponse({ error: 'Only an administrator can update the payment QR image.' }, 403, origin);
  }
  const body = (await request.json().catch(() => null)) as { imageUrl?: unknown; imagePublicId?: unknown } | null;
  const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl : '';
  const imagePublicId = typeof body?.imagePublicId === 'string' ? body.imagePublicId : '';
  if (
    (imageUrl === '') !== (imagePublicId === '') ||
    (imageUrl !== '' && !/^https:\/\/res\.cloudinary\.com\//.test(imageUrl)) ||
    imagePublicId.length > 255
  ) {
    return jsonResponse({ error: 'A valid matching payment QR URL and Cloudinary ID are required.' }, 400, origin);
  }
  const settingsPath = 'settings/payment';
  const settings = await getVersionedDocument(caller.sa, caller.accessToken, settingsPath);
  const oldId = typeof settings.data?.qrImagePublicId === 'string' ? settings.data.qrImagePublicId : '';
  if (settings.data?.qrImageUrl && !oldId) {
    return jsonResponse({ error: 'The existing payment QR has no ownership ID. Migrate it before replacing or clearing the image.' }, 409, origin);
  }
  if (imagePublicId && imagePublicId !== oldId) {
    const asset = await getVersionedDocument(
      caller.sa,
      caller.accessToken,
      await cloudinaryAssetPath(imagePublicId),
    );
    if (
      !asset.exists ||
      asset.data?.assetType !== 'payment-qr' ||
      asset.data?.targetId !== settingsPath ||
      asset.data?.status !== 'uploaded' ||
      asset.data?.secureUrl !== imageUrl
    ) {
      return jsonResponse({ error: 'The payment QR image has no matching verified upload record.' }, 409, origin);
    }
  }
  let cleanupWrites: Record<string, unknown>[];
  try {
    cleanupWrites = await queueCloudinaryCleanup(
      caller.sa,
      caller.accessToken,
      'payment-qr',
      settingsPath,
      caller.uid,
      oldId && oldId !== imagePublicId ? [oldId] : [],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Payment QR ownership could not be verified.';
    return jsonResponse({ error: message }, 409, origin);
  }
  const settingsFields = {
    ...(settings.data || {}),
    qrImageUrl: imageUrl,
    qrImagePublicId: imagePublicId,
    updatedAt: new Date().toISOString(),
  };
  const writes: Record<string, unknown>[] = [
    {
      update: {
        name: firestoreDocumentName(caller.sa, settingsPath),
        fields: toFirestoreFields(settingsFields),
      },
      updateMask: { fieldPaths: Object.keys(settingsFields) },
      currentDocument: settings.exists ? { updateTime: settings.updateTime } : { exists: false },
    },
    ...cleanupWrites,
  ];
  if (imagePublicId && imagePublicId !== oldId) {
    const assetPath = await cloudinaryAssetPath(imagePublicId);
    const asset = await getVersionedDocument(caller.sa, caller.accessToken, assetPath);
    if (!asset.updateTime || !asset.data) {
      return jsonResponse({ error: 'Payment QR ownership changed; retry the save.' }, 409, origin);
    }
    writes.push({
      update: {
        name: firestoreDocumentName(caller.sa, assetPath),
        fields: toFirestoreFields({ ...asset.data, status: 'attached' }),
      },
      updateMask: { fieldPaths: [...Object.keys(asset.data), 'status'] },
      currentDocument: { updateTime: asset.updateTime },
    });
  }
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, writes);
  } catch (error) {
    console.error('[payment-settings] QR metadata update failed', error);
    let cleanupState = 'The uploaded QR image remains available for retry.';
    try {
      if (imagePublicId && imagePublicId !== oldId) {
        const queued = await queueUnreferencedCloudinaryAssets(
          caller.sa,
          caller.accessToken,
          'payment-qr',
          settingsPath,
          caller.uid,
          [imagePublicId],
        );
        if (queued) {
          cleanupState = 'The unreferenced uploaded QR is queued for cleanup retry.';
        }
      }
    } catch (cleanupError) {
      console.error('[payment-settings] Could not queue QR cleanup after metadata failure', cleanupError);
      cleanupState = 'Automatic QR cleanup could not be queued; retry image cleanup from the app.';
    }
    return jsonResponse({ error: `Payment QR settings could not be saved. ${cleanupState}` }, 409, origin);
  }
  const cleanup = await runCloudinaryCleanup(env, caller.sa, caller.accessToken, 'payment-qr', settingsPath);
  return jsonResponse({ success: true, cleanupPending: cleanup.pending, cleanupMessage: cleanup.reason }, 200, origin);
}

async function handleCloudinaryCleanupRequest(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const body = (await request.json().catch(() => null)) as {
    assetType?: string;
    targetId?: string;
    publicIds?: unknown;
  } | null;
  const assetType = body?.assetType;
  const targetId = typeof body?.targetId === 'string' ? body.targetId : '';
  if (!['product', 'payment-qr'].includes(String(assetType))) {
    return jsonResponse({ error: 'A supported Cloudinary asset type is required.' }, 400, origin);
  }
  if (assetType === 'payment-qr') {
    if (caller.profile.role !== 'admin' || targetId !== 'settings/payment') {
      return jsonResponse({ error: 'Only an administrator can clean up payment QR images.' }, 403, origin);
    }
  } else {
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(targetId) || !['seller', 'admin'].includes(String(caller.profile.role))) {
      return jsonResponse({ error: 'A valid product ownership target is required.' }, 400, origin);
    }
    const product = await getVersionedDocument(caller.sa, caller.accessToken, `products/${targetId}`);
    const job = await getVersionedDocument(
      caller.sa,
      caller.accessToken,
      cloudinaryCleanupJobPath('product', targetId),
    );
    const ownerUid = product.data?.createdByUid || job.data?.ownerUid;
    if (
      (product.exists && caller.profile.role !== 'admin' && ownerUid !== caller.uid) ||
      (!product.exists && (!job.exists || (caller.profile.role !== 'admin' && ownerUid !== caller.uid)))
    ) {
      return jsonResponse({ error: 'You are not authorized to clean up this product’s images.' }, 403, origin);
    }
  }

  const ids = Array.isArray(body?.publicIds)
    ? body.publicIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (ids.length) {
    const ownerPath = assetType === 'product' ? `products/${targetId}` : 'settings/payment';
    const owner = await getVersionedDocument(caller.sa, caller.accessToken, ownerPath);
    const referencedIds = assetType === 'product'
      ? (Array.isArray(owner.data?.imagePublicIds) ? owner.data.imagePublicIds : [])
      : [owner.data?.qrImagePublicId];
    if (ids.some((id) => referencedIds.includes(id))) {
      return jsonResponse({ error: 'An image still referenced by its product or payment settings cannot be cleaned up.' }, 409, origin);
    }
    const ownerUid = assetType === 'product'
      ? String(owner.data?.createdByUid || caller.uid)
      : caller.uid;
    let writes: Record<string, unknown>[];
    try {
      writes = await queueCloudinaryCleanup(
        caller.sa,
        caller.accessToken,
        assetType as CloudinaryAssetType,
        targetId,
        ownerUid,
        ids,
        true,
      );
      writes.push({
        verify: firestoreDocumentName(caller.sa, ownerPath),
        currentDocument: owner.exists && owner.updateTime
          ? { updateTime: owner.updateTime }
          : { exists: false },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Image ownership could not be verified.';
      return jsonResponse({ error: message }, 409, origin);
    }
    try {
      await commitFirestoreWrites(caller.sa, caller.accessToken, writes);
    } catch (error) {
      console.error('[cloudinary] Could not queue cleanup', error);
      return jsonResponse({ error: 'Image cleanup could not be queued. Retry the request.' }, 409, origin);
    }
  }

  const cleanup = await runCloudinaryCleanup(
    env,
    caller.sa,
    caller.accessToken,
    assetType as CloudinaryAssetType,
    targetId,
  );
  return cleanup.pending
    ? jsonResponse({ success: true, cleanupPending: true, message: cleanup.reason }, 200, origin)
    : jsonResponse({ success: true, cleanupPending: false }, 200, origin);
}

async function handleDeleteProduct(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  if (!['seller', 'admin'].includes(String(caller.profile.role))) {
    return jsonResponse({ error: 'Only an authorized seller or administrator can delete products.' }, 403, origin);
  }

  const body = (await request.json().catch(() => null)) as { productId?: string } | null;
  const productId = String(body?.productId ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(productId)) {
    return jsonResponse({ error: 'A valid product ID is required.' }, 400, origin);
  }

  const productPath = `products/${productId}`;
  const product = await getVersionedDocument(caller.sa, caller.accessToken, productPath);
  if (!product.exists || !product.data || !product.updateTime) {
    const job = await getVersionedDocument(
      caller.sa,
      caller.accessToken,
      cloudinaryCleanupJobPath('product', productId),
    );
    if (job.exists && (caller.profile.role === 'admin' || job.data?.ownerUid === caller.uid)) {
      const cleanup = await runCloudinaryCleanup(env, caller.sa, caller.accessToken, 'product', productId);
      return jsonResponse({
        success: true,
        productId,
        cleanupPending: cleanup.pending,
        message: cleanup.pending ? cleanup.reason : 'Product is already deleted.',
      }, 200, origin);
    }
    return jsonResponse({ error: 'Product was not found or has already been deleted.' }, 404, origin);
  }
  if (caller.profile.role !== 'admin' && product.data.createdByUid !== caller.uid) {
    return jsonResponse({ error: 'Sellers may delete only products they created.' }, 403, origin);
  }

  const publicIds = Array.isArray(product.data.imagePublicIds)
    ? product.data.imagePublicIds.filter((id): id is string => typeof id === 'string')
    : [];
  const imageUrls = Array.isArray(product.data.imageUrls) ? product.data.imageUrls : [];
  if (
    publicIds.length !== (Array.isArray(product.data.imagePublicIds) ? product.data.imagePublicIds.length : 0) ||
    imageUrls.length !== publicIds.length
  ) {
    return jsonResponse({
      error: 'This product has legacy images without matching verified ownership records. Migrate them before deleting the product.',
    }, 409, origin);
  }
  let cleanupWrites: Record<string, unknown>[];
  try {
    cleanupWrites = await queueCloudinaryCleanup(
      caller.sa,
      caller.accessToken,
      'product',
      productId,
      String(product.data.createdByUid || caller.uid),
      publicIds,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image ownership could not be verified.';
    return jsonResponse({ error: message }, 409, origin);
  }

  const privatePath = `${productPath}/private/data`;
  const privateDocument = await getVersionedDocument(caller.sa, caller.accessToken, privatePath);
  const writes: Record<string, unknown>[] = [
    {
      delete: firestoreDocumentName(caller.sa, productPath),
      currentDocument: { updateTime: product.updateTime },
    },
  ];
  writes.push(...cleanupWrites);
  if (privateDocument.exists && privateDocument.updateTime) {
    writes.push({
      delete: firestoreDocumentName(caller.sa, privatePath),
      currentDocument: { updateTime: privateDocument.updateTime },
    });
  }

  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, writes);
  } catch (error) {
    console.error('[product] Product documents could not be deleted atomically', error);
    return jsonResponse({ error: 'Product record changed before it could be removed. Refresh and retry.' }, 409, origin);
  }
  const cleanup = await runCloudinaryCleanup(env, caller.sa, caller.accessToken, 'product', productId);
  return jsonResponse({
    success: true,
    productId,
    cleanupPending: cleanup.pending,
    message: cleanup.pending ? cleanup.reason : undefined,
  }, 200, origin);
}

async function hashValue(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashReference(value: string): Promise<string> {
  return hashValue(value.trim().toLocaleUpperCase('en-US'));
}

function referenceClaimPath(value: string): string {
  return `payment_reference_claims/ref-${encodeURIComponent(value.trim().toLocaleUpperCase('en-US'))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValidTrustedOrderPricing(order: Record<string, unknown>): boolean {
  const total = order.total;
  if (
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    !Number.isSafeInteger(total * 100)
  ) return false;
  if (order.currency !== undefined && order.currency !== 'INR') return false;
  if (
    order.amountPaise !== undefined &&
    (typeof order.amountPaise !== 'number' || order.amountPaise !== total * 100)
  ) return false;

  const items = order.items;
  if (!Array.isArray(items) || items.length === 0) return false;
  let itemsTotal = 0;
  for (const value of items) {
    if (!isRecord(value)) return false;
    const quantity = value.quantity;
    const unitPrice = value.unitPrice;
    if (
      typeof quantity !== 'number' ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      typeof unitPrice !== 'number' ||
      !Number.isSafeInteger(unitPrice) ||
      unitPrice <= 0
    ) return false;
    const lineTotal = quantity * unitPrice;
    if (!Number.isSafeInteger(lineTotal)) return false;
    if (value.itemTotal !== undefined && value.itemTotal !== lineTotal) return false;
    itemsTotal += lineTotal;
    if (!Number.isSafeInteger(itemsTotal)) return false;
  }
  if (
    order.itemSubtotal !== undefined &&
    (typeof order.itemSubtotal !== 'number' || order.itemSubtotal !== itemsTotal)
  ) return false;

  if (order.itemSubtotal !== undefined || order.deliveryCharge !== undefined) {
    if (
      typeof order.itemSubtotal !== 'number' ||
      !Number.isSafeInteger(order.itemSubtotal) ||
      order.itemSubtotal <= 0 ||
      typeof order.deliveryCharge !== 'number' ||
      !Number.isSafeInteger(order.deliveryCharge) ||
      order.deliveryCharge < 0 ||
      order.itemSubtotal + order.deliveryCharge !== total
    ) return false;
  }
  return true;
}

function adminPaymentReviewAuditWrite(
  sa: ReturnType<typeof parseServiceAccount>,
  caller: AuthenticatedCaller,
  targetId: string,
  targetType: 'order' | 'payment_attempt',
  action:
    | 'Confirm Manual UPI Payment'
    | 'Reject Manual UPI Payment'
    | 'Confirm Payment Attempt'
    | 'Reject Payment Attempt'
    | 'Cancel Payment Attempt'
    | 'Expire Payment Attempt',
  reviewAction: 'Confirmed' | 'Rejected' | 'Cancelled' | 'Expired',
  now: string,
  details: string,
): Record<string, unknown> {
  const logId = crypto.randomUUID();
  return {
    update: {
      name: firestoreDocumentName(sa, `audit_logs/${logId}`),
      fields: toFirestoreFields({
        adminEmail: caller.email || 'admin',
        adminUid: caller.uid,
        action,
        targetId,
        details,
        timestamp: now,
        paymentReviewAction: reviewAction,
        paymentReviewTargetType: targetType,
      }),
    },
    currentDocument: { exists: false },
  };
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
  let itemSubtotal = 0;
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
    itemSubtotal += itemTotal;
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
  if (!Number.isSafeInteger(itemSubtotal) || itemSubtotal <= 0) {
    return jsonResponse({ error: 'The payable amount must be greater than zero.' }, 400, origin);
  }

  const deliverySettings = await getVersionedDocument(caller.sa, caller.accessToken, 'settings/store');
  const settings = deliverySettings.data || {};
  const threshold = Number.isSafeInteger(settings.freeDeliveryThreshold) && settings.freeDeliveryThreshold >= 0
    ? settings.freeDeliveryThreshold
    : 499;
  const configuredCharge = Number.isSafeInteger(settings.deliveryCharge) && settings.deliveryCharge >= 0
    ? settings.deliveryCharge
    : 0;
  const deliveryMinDays = Number.isInteger(settings.deliveryMinDays) &&
    settings.deliveryMinDays >= 1 && settings.deliveryMinDays <= 60
    ? settings.deliveryMinDays
    : 4;
  const deliveryMaxDays = Number.isInteger(settings.deliveryMaxDays) &&
    settings.deliveryMaxDays >= deliveryMinDays && settings.deliveryMaxDays <= 60
    ? settings.deliveryMaxDays
    : Math.max(deliveryMinDays, 6);
  const freeDeliveryEnabled = settings.freeDeliveryEnabled === true;
  const deliveryCharge = freeDeliveryEnabled && itemSubtotal >= threshold ? 0 : configuredCharge;
  const total = itemSubtotal + deliveryCharge;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(total * 100) || total <= 0) {
    return jsonResponse({ error: 'The payable amount is outside the supported range.' }, 400, origin);
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
    itemSubtotal,
    deliveryCharge,
    deliveryMinDays,
    deliveryMaxDays,
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
  const sharedClaimPath = referenceClaimPath(reference);
  const claim = await getVersionedDocument(caller.sa, caller.accessToken, claimPath);
  const sharedClaim = await getVersionedDocument(caller.sa, caller.accessToken, sharedClaimPath);
  const orderId = `ord-${attemptId.slice(4)}`;
  if (
    (claim.exists && claim.data?.attemptId !== attemptId) ||
    (sharedClaim.exists && sharedClaim.data?.orderId !== orderId)
  ) {
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
    itemSubtotal: attempt.data.itemSubtotal ?? attempt.data.total,
    deliveryCharge: attempt.data.deliveryCharge ?? 0,
    ...(attempt.data.deliveryMinDays !== undefined
      ? { deliveryMinDays: attempt.data.deliveryMinDays }
      : {}),
    ...(attempt.data.deliveryMaxDays !== undefined
      ? { deliveryMaxDays: attempt.data.deliveryMaxDays }
      : {}),
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
    adminPaymentReviewAuditWrite(
      caller.sa,
      caller,
      attemptId,
      'payment_attempt',
      'Confirm Payment Attempt',
      'Confirmed',
      now,
      `Verified payment attempt ${attemptId}`,
    ),
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
  if (!sharedClaim.exists) {
    writes.push({
      update: {
        name: firestoreDocumentName(caller.sa, sharedClaimPath),
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
    const sharedClaimed = await getVersionedDocument(caller.sa, caller.accessToken, sharedClaimPath);
    if (
      (claimed.exists && claimed.data?.attemptId !== attemptId) ||
      (sharedClaimed.exists && sharedClaimed.data?.orderId !== orderId)
    ) {
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
    const actionLabel = action === 'reject'
      ? 'Reject Payment Attempt'
      : action === 'expire'
        ? 'Expire Payment Attempt'
        : 'Cancel Payment Attempt';
    await commitFirestoreWrites(caller.sa, caller.accessToken, [
      {
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
      },
      adminPaymentReviewAuditWrite(
        caller.sa,
        caller,
        attemptId,
        'payment_attempt',
        actionLabel,
        status,
        now,
        `${actionLabel} ${attemptId}: ${reason}`,
      ),
    ]);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, path);
    if (retry.data?.status === status) return jsonResponse({ success: true, status }, 200, origin);
    console.error('[payment] Failed to update payment attempt status', error);
    return jsonResponse({ error: 'Could not update payment attempt. Please refresh and retry.' }, 409, origin);
  }
  return jsonResponse({ success: true, status }, 200, origin);
}

async function handleConfirmManualUpiOrderPayment(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const denied = await requireAdmin(caller, origin);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    orderId?: string;
    customerUtr?: string;
  } | null;
  const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : '';
  const reference = typeof body?.customerUtr === 'string' ? body.customerUtr.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId) || !reference || reference.length > 100) {
    return jsonResponse({ error: 'A valid order ID and transaction reference are required.' }, 400, origin);
  }
  const orderPath = `orders/${orderId}`;
  const order = await getVersionedDocument(caller.sa, caller.accessToken, orderPath);
  if (!order.exists || !order.data) return jsonResponse({ error: 'Order not found.' }, 404, origin);
  if (order.data.paymentStatus === 'Paid') {
    const paidReference = String(order.data.paymentReference ?? '').trim();
    if (paidReference.toLocaleUpperCase('en-US') === reference.toLocaleUpperCase('en-US')) {
      return jsonResponse({ success: true, orderId, status: 'Paid' }, 200, origin);
    }
    return jsonResponse({ error: 'This order was already verified with a different transaction reference.' }, 409, origin);
  }
  if (
    order.data.paymentMethod !== 'UPI' ||
    !['Pending', 'Selected', undefined].includes(order.data.paymentStatus) ||
    order.data.status !== 'Placed'
  ) {
    return jsonResponse({ error: 'This UPI order is not eligible for payment confirmation.' }, 409, origin);
  }
  if (!hasValidTrustedOrderPricing(order.data)) {
    return jsonResponse({ error: 'The order pricing data is invalid; no payment status was changed.' }, 409, origin);
  }
  if (!order.updateTime) return jsonResponse({ error: 'Order version is unavailable.' }, 503, origin);

  const referenceHash = await hashReference(reference);
  const claimPath = `payment_reference_claims/${referenceHash}`;
  const sharedClaimPath = referenceClaimPath(reference);
  const claim = await getVersionedDocument(caller.sa, caller.accessToken, claimPath);
  const sharedClaim = await getVersionedDocument(caller.sa, caller.accessToken, sharedClaimPath);
  if (
    (claim.exists && claim.data?.orderId !== orderId) ||
    (sharedClaim.exists && sharedClaim.data?.orderId !== orderId)
  ) {
    return jsonResponse({ error: 'This transaction reference has already been used for another payment.' }, 409, origin);
  }
  const now = new Date().toISOString();
  const updates = {
    paymentStatus: 'Paid',
    paymentReference: reference,
    paymentVerifiedAt: now,
    paymentReviewedByUid: caller.uid,
    paymentReviewedAt: now,
    paymentReviewAction: 'Confirmed',
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
  if (!sharedClaim.exists) {
    writes.push({
      update: {
        name: firestoreDocumentName(caller.sa, sharedClaimPath),
        fields: toFirestoreFields({ reference, orderId, claimedAt: now }),
      },
      currentDocument: { exists: false },
    });
  }
  writes.push(adminPaymentReviewAuditWrite(
    caller.sa,
    caller,
    orderId,
    'order',
    'Confirm Manual UPI Payment',
    'Confirmed',
    now,
    `Verified manual UPI order ${orderId}`,
  ));
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, writes);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, orderPath);
    if (
      retry.data?.paymentStatus === 'Paid' &&
      String(retry.data.paymentReference ?? '').trim().toLocaleUpperCase('en-US') === reference.toLocaleUpperCase('en-US')
    ) return jsonResponse({ success: true, orderId, status: 'Paid' }, 200, origin);
    console.error('[payment] Failed to verify manual UPI order payment', error);
    return jsonResponse({ error: 'Could not confirm UPI order payment. Please refresh and retry.' }, 409, origin);
  }
  return jsonResponse({ success: true, orderId, status: 'Paid' }, 200, origin);
}

async function handleRejectManualUpiOrderPayment(request: Request, env: Env, origin: string | null): Promise<Response> {
  const caller = await authenticateCaller(request, env, origin);
  if (!isAuthenticatedCaller(caller)) return caller;
  const denied = await requireAdmin(caller, origin);
  if (denied) return denied;
  const body = (await request.json().catch(() => null)) as {
    orderId?: string;
    reason?: string;
  } | null;
  const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : '';
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(orderId) || !reason || reason.length > 300) {
    return jsonResponse({ error: 'A valid order ID and review reason are required.' }, 400, origin);
  }
  const path = `orders/${orderId}`;
  const order = await getVersionedDocument(caller.sa, caller.accessToken, path);
  if (!order.exists || !order.data) return jsonResponse({ error: 'Order not found.' }, 404, origin);
  if (
    order.data.paymentStatus === 'Failed' &&
    order.data.status === 'Cancelled' &&
    order.data.paymentReviewReason === reason
  ) {
    return jsonResponse({ success: true, orderId, status: 'Rejected' }, 200, origin);
  }
  if (
    order.data.paymentMethod !== 'UPI' ||
    !['Pending', 'Selected', undefined].includes(order.data.paymentStatus) ||
    order.data.status !== 'Placed'
  ) {
    return jsonResponse({ error: 'This UPI order is not eligible for payment rejection.' }, 409, origin);
  }
  if (!hasValidTrustedOrderPricing(order.data)) {
    return jsonResponse({ error: 'The order pricing data is invalid; no payment status was changed.' }, 409, origin);
  }
  if (!order.updateTime) return jsonResponse({ error: 'Order version is unavailable.' }, 503, origin);
  const now = new Date().toISOString();
  try {
    await commitFirestoreWrites(caller.sa, caller.accessToken, [
      {
        update: {
          name: firestoreDocumentName(caller.sa, path),
          fields: toFirestoreFields({
            paymentStatus: 'Failed',
            status: 'Cancelled',
            paymentReviewReason: reason,
            paymentReviewedByUid: caller.uid,
            paymentReviewedAt: now,
            paymentReviewAction: 'Rejected',
          }),
        },
        updateMask: {
          fieldPaths: [
            'paymentStatus',
            'status',
            'paymentReviewReason',
            'paymentReviewedByUid',
            'paymentReviewedAt',
            'paymentReviewAction',
          ],
        },
        currentDocument: { updateTime: order.updateTime },
      },
      adminPaymentReviewAuditWrite(
        caller.sa,
        caller,
        orderId,
        'order',
        'Reject Manual UPI Payment',
        'Rejected',
        now,
        `Rejected manual UPI order ${orderId}: ${reason}`,
      ),
    ]);
  } catch (error) {
    const retry = await getVersionedDocument(caller.sa, caller.accessToken, path);
    if (
      retry.data?.paymentStatus === 'Failed' &&
      retry.data.status === 'Cancelled' &&
      retry.data.paymentReviewReason === reason
    ) {
      return jsonResponse({ success: true, orderId, status: 'Rejected' }, 200, origin);
    }
    console.error('[payment] Failed to reject manual UPI order payment', error);
    return jsonResponse({ error: 'Could not reject UPI order payment. Please refresh and retry.' }, 409, origin);
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

      if (url.pathname === '/send-otp' || url.pathname === '/verify-otp') {
        return phoneOtpUnavailableResponse(origin);
      }
      if (url.pathname === '/cloudinary/upload') return handleCloudinaryUpload(request, env, origin);
      if (url.pathname === '/cloudinary/cleanup') return handleCloudinaryCleanupRequest(request, env, origin);
      if (url.pathname === '/seller/products/delete') return handleDeleteProduct(request, env, origin);
      if (url.pathname === '/seller/products/images') return handleUpdateProductImages(request, env, origin);
      if (url.pathname === '/admin/payment-settings/qr-image') {
        return handleUpdatePaymentQrImage(request, env, origin);
      }
      if (url.pathname === '/manual-upi/orders/create') return handleCreateManualUpiOrder(request, env, origin);
      if (url.pathname === '/payment-attempts/create') return handleCreatePaymentAttempt(request, env, origin);
      if (url.pathname === '/create-order') {
        return jsonResponse({ error: 'Direct order creation is disabled. Create a payment attempt instead.' }, 410, origin);
      }
      if (url.pathname === '/payment-attempts/submit') return handleSubmitPaymentDetails(request, env, origin);
      if (url.pathname === '/admin/payment-attempts/confirm') return handleConfirmPaymentAttempt(request, env, origin);
      if (url.pathname === '/admin/payment-attempts/reject') return handlePaymentAttemptAction(request, env, origin, 'reject');
      if (url.pathname === '/admin/payment-attempts/cancel') return handlePaymentAttemptAction(request, env, origin, 'cancel');
      if (url.pathname === '/admin/payment-attempts/expire') return handlePaymentAttemptAction(request, env, origin, 'expire');
      if (
        url.pathname === '/admin/manual-upi/orders/confirm-payment' ||
        url.pathname === '/admin/legacy-orders/confirm-payment'
      ) return handleConfirmManualUpiOrderPayment(request, env, origin);
      if (
        url.pathname === '/admin/manual-upi/orders/reject-payment' ||
        url.pathname === '/admin/legacy-orders/reject-payment'
      ) return handleRejectManualUpiOrderPayment(request, env, origin);
      return jsonResponse({ error: 'Not found.' }, 404, origin);
    } catch (error) {
      console.error('[worker] Unhandled request failure', error);
      return jsonResponse({ error: 'The request could not be completed. Please retry.' }, 500, origin);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(retryPendingCloudinaryCleanup(env));
  },
};

async function retryPendingCloudinaryCleanup(env: Env): Promise<void> {
  try {
    const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const accessToken = await getGoogleAccessToken(sa);
    const jobs = await listScheduledCloudinaryPage(
      env, sa, accessToken, 'cloudinary_cleanup_jobs', 'cloudinary-cleanup-jobs-cursor',
    );
    for (const document of jobs) {
      const data = fromFirestoreFields(document.fields || {});
      if (
        (data.assetType === 'product' || data.assetType === 'payment-qr') &&
        typeof data.targetId === 'string'
      ) {
        const result = await runCloudinaryCleanup(env, sa, accessToken, data.assetType, data.targetId);
        if (result.pending) {
          console.warn('[cloudinary] Scheduled cleanup remains pending.', {
            targetType: data.assetType,
            reason: result.reason,
          });
        }
      }
    }
    await recoverStaleCloudinaryUploads(env, sa, accessToken);
  } catch {
    console.error('[cloudinary] Scheduled cleanup scan failed; the next invocation will retry.');
  }
}

async function listScheduledCloudinaryPage(
  env: Env,
  sa: ReturnType<typeof parseServiceAccount>,
  accessToken: string,
  collection: 'cloudinary_cleanup_jobs' | 'cloudinary_assets',
  cursorKey: string,
): Promise<Array<{ name: string; fields?: Record<string, unknown> }>> {
  const pageToken = await env.OTP_KV.get(cursorKey);
  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/${collection}`,
  );
  url.searchParams.set('pageSize', '10');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    await env.OTP_KV.delete(cursorKey);
    throw new Error('Firestore scheduled scan request failed.');
  }
  if (!response.ok) {
    await env.OTP_KV.delete(cursorKey);
    throw new Error(`Firestore scheduled scan returned HTTP ${response.status}.`);
  }
  let page: {
    documents?: Array<{ name: string; fields?: Record<string, unknown> }>;
    nextPageToken?: string;
  };
  try {
    page = (await response.json()) as typeof page;
  } catch {
    await env.OTP_KV.delete(cursorKey);
    throw new Error('Firestore scheduled scan response was invalid.');
  }
  if (page.nextPageToken) {
    await env.OTP_KV.put(cursorKey, page.nextPageToken, { expirationTtl: 7 * 24 * 60 * 60 });
  } else {
    await env.OTP_KV.delete(cursorKey);
  }
  return page.documents || [];
}

async function recoverStaleCloudinaryUploads(
  env: Env,
  sa: ReturnType<typeof parseServiceAccount>,
  accessToken: string,
): Promise<void> {
  const documents = await listScheduledCloudinaryPage(
    env, sa, accessToken, 'cloudinary_assets', 'cloudinary-assets-cursor',
  );
  const now = Date.now();
  for (const document of documents) {
    const data = fromFirestoreFields(document.fields || {});
    if (
      (data.status !== 'uploading' && data.status !== 'uploaded') ||
      typeof data.publicId !== 'string' ||
      typeof data.targetId !== 'string' ||
      typeof data.ownerUid !== 'string' ||
      !data.ownerUid ||
      (data.assetType !== 'product' && data.assetType !== 'payment-qr')
    ) continue;
    const createdAt = typeof data.createdAt === 'string' ? Date.parse(data.createdAt) : NaN;
    const staleAfter = data.status === 'uploading'
      ? STALE_CLOUDINARY_UPLOAD_MS
      : STALE_UNATTACHED_CLOUDINARY_ASSET_MS;
    if (!Number.isFinite(createdAt) || now - createdAt < staleAfter) continue;
    if (
      (data.assetType === 'product' && !/^[A-Za-z0-9_-]{1,150}$/.test(data.targetId)) ||
      (data.assetType === 'payment-qr' && data.targetId !== 'settings/payment') ||
      await cloudinaryAssetPath(data.publicId) !== document.name.split('/documents/').at(-1)
    ) continue;

    const targetPath = data.assetType === 'product' ? `products/${data.targetId}` : 'settings/payment';
    const target = await getVersionedDocument(sa, accessToken, targetPath);
    const references = data.assetType === 'product'
      ? (Array.isArray(target.data?.imagePublicIds) ? target.data.imagePublicIds : [])
      : [target.data?.qrImagePublicId];
    if (references.includes(data.publicId)) continue;

    try {
      const writes = await queueCloudinaryCleanup(
        sa, accessToken, data.assetType, data.targetId, data.ownerUid, [data.publicId], true,
      );
      writes.push({
        verify: firestoreDocumentName(sa, targetPath),
        currentDocument: target.exists && target.updateTime
          ? { updateTime: target.updateTime }
          : { exists: false },
      });
      await commitFirestoreWrites(sa, accessToken, writes);
      await runCloudinaryCleanup(env, sa, accessToken, data.assetType, data.targetId);
    } catch {
      console.error('[cloudinary] Stale upload cleanup could not be persisted; recovery will retry.');
    }
  }
}