const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// Mobile OTP (sendOtp/verifyOtp) and Cloudinary signing used to live here as
// Cloud Functions. Both have moved off Cloud Functions entirely, because
// this project intentionally stays on Firebase's Spark (free) plan, and
// Cloud Functions — of any kind, with or without secrets — require the
// Blaze plan just to deploy.
//   - Mobile OTP now goes through a Cloudflare Worker instead (Cloudflare's
//     free tier) — see workers/otp/ and services/firebase/auth.ts.
//   - Cloudinary now uses an unsigned upload preset from the client
//     directly — see services/cloudinary/upload.ts and README.md.
//
// reconcileOrderCost below is the one Cloud Function this project still
// has. It still requires Blaze to deploy, same as any Cloud Function would
// — that's a separate, so-far-unresolved limitation (order cost/profit
// stays at its client-computed placeholder value until either Blaze is
// enabled or this is redesigned the same way OTP was). See README.md's
// "Known limitations" section.

/**
 * Why this exists: firestore.rules deny customers read access to
 * products/{id}/private/data (that's what actually hides supplier cost from
 * them — see firestore.rules). Which means a customer's client can never
 * compute a trustworthy costTotal/profitTotal when placing an order; it
 * only ever has the public price. This function runs with Admin SDK
 * privileges (bypasses security rules) to look up the real baseCost for
 * every item and stamp the order with authoritative figures right after
 * it's created. The seller-facing UI should treat costTotal/profitTotal as
 * "pending" until costReconciled is true (usually well under a second).
 */
exports.reconcileOrderCost = onDocumentCreated('orders/{orderId}', async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;

  const order = snapshot.data();
  if (!order || order.costReconciled) return;

  let costTotal = 0;
  for (const item of order.items ?? []) {
    if (!item.productId) continue;
    const privateSnap = await db.doc(`products/${item.productId}/private/data`).get();
    const baseCost = privateSnap.exists ? (privateSnap.data().baseCost ?? 0) : 0;
    costTotal += baseCost * (item.quantity ?? 1);
  }

  const total = order.total ?? 0;
  await snapshot.ref.update({
    costTotal,
    profitTotal: total - costTotal,
    costReconciled: true,
  });
});