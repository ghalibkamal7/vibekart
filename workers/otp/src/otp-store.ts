/**
 * Ephemeral OTP state used to live in Firestore's otp_requests collection
 * (already locked down to "no client access, ever" in firestore.rules —
 * only the old Cloud Function's Admin SDK could touch it). That collection
 * is no longer needed at all: this Worker doesn't touch Firestore for OTP
 * state, only for the one-time "create a profile doc for a brand-new user"
 * write (see firestore.ts). OTP hash/expiry/attempts live in Workers KV
 * instead, which needs no Google auth and supports a native per-key TTL.
 */

export const OTP_TTL_SECONDS = 5 * 60; // 5 minutes
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds
export const MAX_VERIFY_ATTEMPTS = 5;

export type NormalizedPhone = { local: string; e164: string };

export function normalizePhone(raw: unknown): NormalizedPhone | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  // Accepts a bare 10-digit Indian mobile number or one already prefixed with 91.
  const tenDigit = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  if (tenDigit.length !== 10) return null;
  return { local: tenDigit, e164: `+91${tenDigit}` };
}

/** 4-digit OTP, generated with Web Crypto's CSPRNG — never Math.random(),
 * which is not cryptographically secure and could in principle be
 * predicted. The modulo-9000 bias this introduces is negligible (worst
 * case ~0.0000002% skew across the output range) and not exploitable. */
export function generateOtp(): string {
  const randomValues = new Uint32Array(1);
  crypto.getRandomValues(randomValues);
  const otp = 1000 + (randomValues[0] % 9000);
  return String(otp);
}

export async function hashOtp(otp: string, phone: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${otp}:${phone}`));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type OtpRecord = { otpHash: string; expiresAt: number; attempts: number; createdAt: number };

function otpKey(phoneLocal: string) {
  return `otp:${phoneLocal}`;
}

export async function getOtpRecord(kv: KVNamespace, phoneLocal: string): Promise<OtpRecord | null> {
  const raw = await kv.get(otpKey(phoneLocal));
  return raw ? (JSON.parse(raw) as OtpRecord) : null;
}

export async function setOtpRecord(kv: KVNamespace, phoneLocal: string, record: OtpRecord): Promise<void> {
  await kv.put(otpKey(phoneLocal), JSON.stringify(record), { expirationTtl: OTP_TTL_SECONDS });
}

export async function deleteOtpRecord(kv: KVNamespace, phoneLocal: string): Promise<void> {
  await kv.delete(otpKey(phoneLocal));
}

/** Basic abuse protection: caps send-otp requests per source IP. Cheap and
 * KV-native — no Durable Objects or paid add-ons needed. Not a substitute
 * for a real WAF/rate-limiting product, but enough to stop naive spamming. */
export async function checkIpRateLimit(kv: KVNamespace, ip: string, max: number, windowSeconds: number): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= max) return false;
  await kv.put(key, String(count + 1), { expirationTtl: windowSeconds });
  return true;
}