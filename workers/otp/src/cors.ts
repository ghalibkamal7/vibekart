/**
 * Same allowlist approach the old Cloud Function used: dev localhost (any
 * port — Expo picks a new one whenever the default is busy) plus this
 * project's hosting domains.
 */
const ALLOWED_ORIGIN_PATTERNS = [
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
  /^https:\/\/vibekart-f27b5\.(web\.app|firebaseapp\.com)$/,
  /^https:\/\/vibekaart\.vercel\.app$/,
];

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = isAllowedOrigin(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? (origin as string) : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

export function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}