/**
 * The Firebase Admin SDK (Node.js) doesn't run in the Cloudflare Workers
 * runtime — its Firestore/Auth Admin clients use gRPC, which needs raw TCP
 * sockets Workers don't expose. Every Admin operation the Admin SDK does is
 * really just a signed-JWT + REST call under the hood, so this file
 * reimplements exactly the two operations this Worker needs, using the
 * Workers-native Web Crypto API and fetch():
 *
 *   1. Exchange the service account for a short-lived Google OAuth2 access
 *      token (the standard "JWT Bearer" service-account flow).
 *   2. Use that token to call the Identity Toolkit Admin REST API — look up
 *      a user by phone number, or create one if none exists.
 *   3. Create a Firebase **custom token** — this is pure local crypto (an
 *      RS256-signed JWT with a specific claim shape Firebase's client SDK
 *      knows how to redeem via signInWithCustomToken), no network call at
 *      all. See: https://firebase.google.com/docs/auth/admin/create-custom-tokens#sign-in-without-server-sdk
 */

export type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

export function parseServiceAccount(json: string): ServiceAccount {
  const parsed = JSON.parse(json);
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('Service account JSON is missing project_id/client_email/private_key.');
  }
  return parsed;
}

function base64UrlEncode(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let cachedKey: { pem: string; key: CryptoKey } | null = null;

async function importSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.pem === privateKeyPem) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKey = { pem: privateKeyPem, key };
  return key;
}

async function signJwt(header: object, payload: object, privateKeyPem: string): Promise<string> {
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const key = await importSigningKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/** Service-account OAuth2 "JWT Bearer" flow — exchanges a signed assertion
 * for a short-lived access token. One token covers both scopes this Worker
 * needs: Identity Toolkit (look up/create the Auth user) and Firestore
 * (write the new user's profile doc) — Google access tokens can carry
 * multiple space-separated scopes. */
export async function getGoogleAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    sa.private_key,
  );

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  if (!response.ok) {
    throw new Error(`Google OAuth2 token exchange failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/** Returns the existing user's uid for this phone number, or null if none exists. */
export async function findUserByPhone(
  sa: ServiceAccount,
  accessToken: string,
  phoneE164: string,
): Promise<string | null> {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts:lookup`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: [phoneE164] }),
    },
  );
  if (!response.ok) {
    throw new Error(`Identity Toolkit lookup failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { users?: Array<{ localId: string }> };
  return data.users?.[0]?.localId ?? null;
}

/** Creates a new Firebase Auth user with this phone number (no password,
 * no email) and returns the new uid. */
export async function createUserWithPhone(
  sa: ServiceAccount,
  accessToken: string,
  phoneE164: string,
): Promise<string> {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phoneE164 }),
  });
  if (!response.ok) {
    throw new Error(`Identity Toolkit create-user failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { localId: string };
  return data.localId;
}

/** Pure local crypto — no network call. This is what lets the Worker "sign
 * in" a user to Firebase Auth without ever calling Firebase itself for
 * this step; the client redeems this via signInWithCustomToken. */
export async function createFirebaseCustomToken(sa: ServiceAccount, uid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: now,
      exp: now + 3600,
      uid,
    },
    sa.private_key,
  );
}