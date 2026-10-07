import type { ServiceAccount } from './google';

/**
 * Just enough of the Firestore REST API to read and create one document —
 * the user's profile, in the same shape the old Cloud Function wrote it.
 * Uses the same OAuth2 access token as the Identity Toolkit calls (see
 * google.ts — the token is requested with both scopes).
 */

/** Used for an EXISTING Firebase Auth user too, not just brand-new ones —
 * the app must never end up with an Auth user that has no Firestore
 * profile (e.g. if a previous sign-in's profile-creation step failed
 * partway through for any reason). */
export async function userProfileExists(sa: ServiceAccount, accessToken: string, uid: string): Promise<boolean> {
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users/${uid}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Firestore profile check failed: ${response.status} ${await response.text()}`);
  }
  return true;
}

export async function createUserProfileDoc(
  sa: ServiceAccount,
  accessToken: string,
  uid: string,
  phoneE164: string,
): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/users?documentId=${uid}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        uid: { stringValue: uid },
        phone: { stringValue: phoneE164 },
        name: { stringValue: '' },
        email: { stringValue: '' },
        role: { stringValue: 'customer' },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Firestore create-profile failed: ${response.status} ${await response.text()}`);
  }
}