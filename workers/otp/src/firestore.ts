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

export function toFirestoreFields(obj: Record<string, any>): Record<string, any> {
  const fields: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    fields[key] = toFirestoreValue(val);
  }
  return fields;
}

function toFirestoreValue(val: any): any {
  if (val === null) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    return { mapValue: { fields: toFirestoreFields(val) } };
  }
  return { stringValue: String(val) };
}

export function fromFirestoreFields(fields: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(fields || {})) {
    result[key] = fromFirestoreValue(val);
  }
  return result;
}

function fromFirestoreValue(val: any): any {
  if (!val || typeof val !== 'object') return null;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) return (val.arrayValue?.values || []).map(fromFirestoreValue);
  if ('mapValue' in val) return fromFirestoreFields(val.mapValue?.fields || {});
  return null;
}

export async function getProductDoc(
  sa: ServiceAccount,
  accessToken: string,
  productId: string,
): Promise<{ exists: boolean; data?: Record<string, any> }> {
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/products/${productId}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status === 404) return { exists: false };
  if (!response.ok) {
    throw new Error(`Firestore get product failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { fields?: Record<string, any> };
  return { exists: true, data: fromFirestoreFields(body.fields || {}) };
}

export async function getProductPrivateDoc(
  sa: ServiceAccount,
  accessToken: string,
  productId: string,
): Promise<{ exists: boolean; data?: Record<string, any> }> {
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/products/${productId}/private/data`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status === 404) return { exists: false };
  if (!response.ok) {
    throw new Error(`Firestore get product private failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { fields?: Record<string, any> };
  return { exists: true, data: fromFirestoreFields(body.fields || {}) };
}

export async function saveOrderTwoDoc(
  sa: ServiceAccount,
  accessToken: string,
  orderId: string,
  publicDoc: Record<string, any>,
  privateDoc: Record<string, any>,
): Promise<void> {
  // 1. Create public document: orders/{orderId}
  const publicUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/orders?documentId=${orderId}`;
  const pubResp = await fetch(publicUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(publicDoc) }),
  });
  if (!pubResp.ok) {
    throw new Error(`Firestore create public order failed: ${pubResp.status} ${await pubResp.text()}`);
  }

  // 2. Create seller-only subdocument: orders/{orderId}/private/data
  const privateUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/orders/${orderId}/private?documentId=data`;
  const privResp = await fetch(privateUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(privateDoc) }),
  });
  if (!privResp.ok) {
    throw new Error(`Firestore create private order data failed: ${privResp.status} ${await privResp.text()}`);
  }
}

export async function getOrderDoc(
  sa: ServiceAccount,
  accessToken: string,
  orderId: string,
): Promise<{ exists: boolean; data?: Record<string, any> }> {
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/orders/${orderId}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status === 404) return { exists: false };
  if (!response.ok) {
    throw new Error(`Firestore get order failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { fields?: Record<string, any> };
  return { exists: true, data: fromFirestoreFields(body.fields || {}) };
}

export async function updateOrderPaymentDoc(
  sa: ServiceAccount,
  accessToken: string,
  orderId: string,
  updates: {
    paymentStatus: string;
    paymentVerifiedAt?: string;
    bankRrn?: string;
  },
): Promise<void> {
  const fields = toFirestoreFields(updates);
  const mask = Object.keys(updates)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/orders/${orderId}?${mask}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    throw new Error(`Firestore update order payment failed: ${response.status} ${await response.text()}`);
  }
}