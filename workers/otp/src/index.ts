import { corsHeaders, isAllowedOrigin, jsonResponse } from './cors';
import { createUserProfileDoc, getProductDoc, getProductPrivateDoc, saveOrderTwoDoc, userProfileExists } from './firestore';
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
  } | null;

  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return jsonResponse({ error: 'Order must contain at least one item.' }, 400, origin);
  }

  const customerName = String(body.customerName || '').trim();
  const customerPhone = String(body.customerPhone || '').trim();
  const customerAddress = String(body.customerAddress || '').trim();
  const paymentMethod = String(body.paymentMethod || '').trim();

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
  const nowIso = new Date().toISOString();

  const publicOrderDoc = {
    id: orderId,
    customerUid: user.uid,
    customerName,
    customerPhone,
    customerAddress,
    paymentMethod,
    paymentStatus: 'Selected',
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
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin);
    }

    if (url.pathname === '/send-otp') return handleSendOtp(request, env, origin);
    if (url.pathname === '/verify-otp') return handleVerifyOtp(request, env, origin);
    if (url.pathname === '/create-order') return handleCreateOrder(request, env, origin);
    return jsonResponse({ error: 'Not found.' }, 404, origin);
  },
};