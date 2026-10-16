/**
 * MSG91's v5 OTP API does NOT accept a free-form `message` string — it
 * requires a pre-registered, DLT-approved `template_id` (mandatory for
 * Indian mobile numbers; this is a TRAI/DLT regulatory requirement, not an
 * MSG91 quirk). The template's approved content has one variable
 * placeholder (DLT-side: `{#var#}`, MSG91-side: `##OTP##`), e.g.:
 *
 *   "Your OTP for login is ##OTP##. Please do not share it with anyone."
 *
 * We pass OUR OWN securely-generated OTP (see otp-store.ts's generateOtp,
 * which uses Web Crypto) via the `otp` query parameter, so MSG91 only
 * delivers it — this Worker still does its own verification against the
 * hash stored in KV, never MSG91's own verify endpoint. That keeps exactly
 * one source of truth for "was this OTP correct".
 *
 * Phone OTP is currently disabled. This provider implementation and any
 * MSG91 credentials/template are future-only; see workers/otp/README.md
 * before any explicit reactivation.
 */
export async function sendOtpSms(params: {
  authKey: string;
  templateId: string;
  phoneE164: string;
  otp: string;
  otpExpiryMinutes: number;
}): Promise<void> {
  const mobile = params.phoneE164.replace('+', '');
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', params.templateId);
  url.searchParams.set('mobile', mobile);
  url.searchParams.set('otp', params.otp);
  url.searchParams.set('otp_expiry', String(params.otpExpiryMinutes));

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { authkey: params.authKey, 'Content-Type': 'application/json' },
  });

  const data = (await response.json().catch(() => ({}))) as { type?: string; message?: string };
  // MSG91 returns 200 OK with {"type":"error", ...} for several failure
  // modes (bad template, DLT mismatch, etc.) — checking response.ok alone
  // is not enough.
  if (!response.ok || data.type === 'error') {
    throw new Error(`MSG91 error: ${data.message ?? `HTTP ${response.status}`}`);
  }
}