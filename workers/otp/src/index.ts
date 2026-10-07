import { corsHeaders, isAllowedOrigin, jsonResponse } from './cors';
import { createUserProfileDoc, userProfileExists } from './firestore';
import { createFirebaseCustomToken, createUserWithPhone, findUserByPhone, getGoogleAccessToken, parseServiceAccount } from './google';
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
    return jsonResponse({ error: 'Not found.' }, 404, origin);
  },
};