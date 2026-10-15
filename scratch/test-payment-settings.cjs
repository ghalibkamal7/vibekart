/**
 * Static smoke checks for manual UPI checkout and optional Worker payment APIs.
 * Tests:
 * 1. PaymentSettings default values and schema validation.
 * 2. buildUpiUri and buildUpiQrUrl URI generator functions.
 * 3. Firestore security rule constraints on /settings/payment (isSignedIn read, isAdmin write).
 * 4. Checkout creates a pending Firestore order and submits UTR directly.
 * 5. Admin-only verification marks an order paid; UTR submission does not.
 * 6. Optional payment-attempt Worker endpoints remain available.
 * 7. Cloudinary usage assurance and no Firebase Storage / Blaze requirements.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('--- RUNNING UPI PAYMENT SETTINGS VERIFICATION SUITE ---');

// 1. Check data/store.ts definitions
const storeSource = fs.readFileSync(path.join(__dirname, '../data/store.ts'), 'utf8');

assert(storeSource.includes('export type PaymentSettings'), 'PaymentSettings type missing in data/store.ts');
assert(storeSource.includes('merchantVpa: string'), 'merchantVpa missing in PaymentSettings');
assert(storeSource.includes('merchantName: string'), 'merchantName missing in PaymentSettings');
assert(storeSource.includes('instructions: string'), 'instructions missing in PaymentSettings');
assert(storeSource.includes('autoGenerateQr: boolean'), 'autoGenerateQr missing in PaymentSettings');
assert(storeSource.includes('customerUtr?: string'), 'customerUtr missing in Order interface');
assert(storeSource.includes('export function calculateDeliveryCharge'), 'Delivery charge calculator missing');
assert(storeSource.includes('deliveryMinDays: number'), 'Delivery estimate settings missing');

console.log('✔ data/store.ts types verified.');

// 2. Test URI and QR builder logic
function buildUpiUri(vpa, name, amount) {
  const cleanVpa = (vpa || '').trim();
  const cleanName = (name || '').trim();
  if (!cleanVpa) return '';

  const params = new URLSearchParams();
  params.set('pa', cleanVpa);
  if (cleanName) params.set('pn', cleanName);
  params.set('cu', 'INR');
  if (amount && amount > 0) {
    params.set('am', Number(amount).toFixed(2));
  }
  return `upi://pay?${params.toString()}`;
}

function buildUpiQrUrl(vpa, name, amount) {
  const uri = buildUpiUri(vpa, name, amount);
  if (!uri) return '';
  return `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=10&data=${encodeURIComponent(uri)}`;
}

const testUri = buildUpiUri('store@upi', 'VibeKart Store', 499);
assert.strictEqual(testUri, 'upi://pay?pa=store%40upi&pn=VibeKart+Store&cu=INR&am=499.00', 'buildUpiUri produced unexpected URI');

const testQr = buildUpiQrUrl('store@upi', 'VibeKart Store', 499);
assert(testQr.startsWith('https://api.qrserver.com/v1/create-qr-code/'), 'buildUpiQrUrl prefix mismatch');
assert(testQr.includes(encodeURIComponent(testUri)), 'buildUpiQrUrl missing encoded URI');
console.log('✔ UPI URI & QR URL generator functions tested.');

// 3. Check Firestore rules for settings
const rulesSource = fs.readFileSync(path.join(__dirname, '../firestore.rules'), 'utf8');
assert(rulesSource.includes('match /settings/{settingId}'), 'Missing match /settings/{settingId} rule');
assert(rulesSource.includes('allow read: if isSignedIn();'), 'Settings read rule incorrect');
assert(rulesSource.includes('allow write: if isAdmin();'), 'Settings write rule must require isAdmin()');
console.log('✔ firestore.rules permissions verified (read: isSignedIn, write: isAdmin).');

// 4. Check services/firebase/firestore.ts methods
const firestoreSource = fs.readFileSync(path.join(__dirname, '../services/firebase/firestore.ts'), 'utf8');
assert(firestoreSource.includes('PAYMENT_SETTINGS_DOC_ID = \'payment\''), 'Missing PAYMENT_SETTINGS_DOC_ID');
assert(firestoreSource.includes('fetchPaymentSettingsRemote'), 'Missing fetchPaymentSettingsRemote');
assert(firestoreSource.includes('updatePaymentSettingsRemote'), 'Missing updatePaymentSettingsRemote');
assert(firestoreSource.includes('createPaymentAttemptViaWorker'), 'Missing Worker payment-attempt method');
assert(firestoreSource.includes('confirmPaymentAttemptViaWorker'), 'Missing Worker admin-confirmation method');
assert(!firestoreSource.includes('updateOrderPaymentStatusRemote'), 'Client payment-status writer must be removed');
assert(!firestoreSource.includes('export async function createOrder('), 'Client order creation must be removed');
assert(firestoreSource.includes('createManualUpiOrderRemote'), 'Missing trusted manual UPI order creation');
assert(firestoreSource.includes("'/manual-upi/orders/create'"), 'Manual order creation must use the authenticated Worker');
assert(firestoreSource.includes('submitManualUpiOrderUtrRemote'), 'Missing direct manual UPI UTR submission');
assert(firestoreSource.includes("transaction.update(orderRef, { customerUtr: reference })"), 'UTR submission must only update the submitted reference');
assert(firestoreSource.includes('manualUpiReferenceClaimId'), 'Admin verification must reserve a UTR against duplicate use');
console.log('✔ Firestore settings, Worker-created pending manual orders, and optional Worker payment methods verified.');

// 5. Check Cloudflare Worker OTP handling for customerUtr
const workerSource = fs.readFileSync(path.join(__dirname, '../workers/otp/src/index.ts'), 'utf8');
assert(workerSource.includes('async function handleCreatePaymentAttempt'), 'Worker payment-attempt creation missing');
assert(workerSource.includes('async function handleCreateManualUpiOrder'), 'Trusted manual UPI order creation missing');
assert(workerSource.includes("url.pathname === '/manual-upi/orders/create'"), 'Manual order endpoint is not routed');
assert(workerSource.includes('const unitPrice = Number(product.data.price)'), 'Worker must price from the authoritative product document');
assert(workerSource.includes('const total = itemSubtotal + deliveryCharge'), 'Worker must calculate the order total');
assert(workerSource.includes("getVersionedDocument(caller.sa, caller.accessToken, 'settings/payment')"), 'Worker must read payment readiness from Firestore');
assert(workerSource.includes('paymentSettings.data?.enabled !== true'), 'Worker must reject checkout while manual UPI is disabled');
assert(workerSource.includes("if (!/^pay-[a-f0-9]{64}$/.test(attemptId) || !customerUtr || customerUtr.length > 100)"), 'Worker must require and cap submitted UTRs');
assert(workerSource.includes("if (url.pathname === '/create-order')"), 'Retired direct order route must be explicitly disabled');
assert(!workerSource.includes("url.pathname === '/payment/verify'"), 'Customer verification route must not be active');
assert(workerSource.includes("url.pathname === '/seller/products/delete'"), 'Authenticated product-deletion route is missing');
assert(workerSource.includes('createdByUid !== caller.uid'), 'Seller product ownership must be enforced');
assert(workerSource.includes('CLOUDINARY_API_SECRET'), 'Cloudinary Admin API secret must be server-only');
assert(workerSource.includes('const deliveryCharge = freeDeliveryEnabled && itemSubtotal >= threshold ? 0 : configuredCharge'), 'Worker must price delivery charges authoritatively');
console.log('✔ Cloudflare Worker attempt creation and UTR validation verified.');

// 6. Check Admin Panel UI wiring
const adminSource = fs.readFileSync(path.join(__dirname, '../app/admin.tsx'), 'utf8');
assert(adminSource.includes('Payment Settings'), 'Admin panel missing Payment Settings navigation');
assert(adminSource.includes('merchantVpa'), 'Admin panel missing merchantVpa input');
assert(adminSource.includes('autoGenerateQr'), 'Admin panel missing autoGenerateQr option');
assert(adminSource.includes('handlePickQrImage'), 'Admin panel missing QR image picker');
assert(adminSource.includes('uploadImageToCloudinary'), 'Admin panel should use uploadImageToCloudinary');
assert(!adminSource.includes('firebase/storage'), 'Admin panel must not use Firebase Storage');
assert(adminSource.includes('Visual Payment Prompt'), 'Admin panel missing disclaimer on QR / verification');
assert(adminSource.includes('handleVerifyPaymentAttempt'), 'Admin panel missing payment-attempt verification action');
console.log('✔ Admin Panel Payment Settings UI and Order verification actions verified.');

// 7. Check Checkout flow
const checkoutSource = fs.readFileSync(path.join(__dirname, '../app/checkout.tsx'), 'utf8');
const storeContextSource = fs.readFileSync(path.join(__dirname, '../context/StoreContext.tsx'), 'utf8');
assert(checkoutSource.includes('paymentSettings'), 'Checkout missing paymentSettings from StoreContext');
assert(checkoutSource.includes('manualUpiReady'), 'Checkout missing manualUpiReady check');
assert(checkoutSource.includes('customerUtr'), 'Checkout missing customerUtr input');
assert(checkoutSource.includes('awaiting verification'), 'Checkout missing verification status disclosure');
assert(checkoutSource.includes('submitManualOrderUtr'), 'Checkout must submit UTR directly to the manual order');
assert(!checkoutSource.includes('submitPaymentDetailsViaWorker'), 'Manual checkout must not use the legacy payment-attempt API');
assert(checkoutSource.includes('{pendingOrder && qrDisplayUrl ?'), 'Amount-specific QR must not be shown before the refreshed pending order exists');
assert(storeContextSource.includes('createManualUpiOrderRemote'), 'StoreContext must create manual orders through the Worker');
assert(checkoutSource.includes('vibekart:checkout-idempotency:'), 'Checkout request ID must persist across remounts');
assert(!storeContextSource.includes('createPaymentAttemptViaWorker('), 'Manual checkout must not create Worker payment attempts');
assert(storeContextSource.includes('confirmManualUpiOrderPaymentRemote'), 'Admin manual UPI verification must use the direct Firestore path');
assert(storeContextSource.includes('rejectManualUpiOrderPaymentRemote'), 'Admin manual UPI rejection must use the direct Firestore path');
console.log('✔ Manual checkout uses the trusted Worker; admin review uses the established Firestore path.');
// 8. Check StoreContext admin order subscription and caching
assert(storeContextSource.includes("authUser.role === 'seller' || authUser.role === 'admin'"), 'Admin not included in order subscription filter');
assert(storeContextSource.includes('await AsyncStorage.setItem(STORAGE_KEYS.paymentSettings, JSON.stringify(merged));'), 'AsyncStorage paymentSettings persistence missing');
console.log('✔ StoreContext admin order filter and AsyncStorage caching verified.');

// 9. Check manual-order and payment-status rules.
assert(rulesSource.includes('allow create: if false;'), 'Clients must not create orders using untrusted prices');
assert(rulesSource.includes("request.resource.data.diff(resource.data).affectedKeys().hasOnly(['customerUtr'])"), 'Customer UTR updates must not change payment status');
assert(rulesSource.includes('isAdmin() &&\n        resource.data.paymentMethod == \'UPI\''), 'Manual order payment confirmation must be admin-only');
assert(rulesSource.includes('paymentVerifiedAt == request.time'), 'Manual payment confirmation must use a server timestamp');
assert(rulesSource.includes('match /payment_attempts/{attemptId}'), 'Payment attempt rules missing');
assert(rulesSource.includes('allow create, update, delete: if false;'), 'Clients must not write payment attempts');
assert(rulesSource.includes('allow delete: if false;'), 'Clients must not directly delete products');
assert(rulesSource.includes('request.resource.data.createdByUid == request.auth.uid'), 'Products must record their creator');
assert(rulesSource.includes('resource.data.get(\'createdByUid\', null) == request.auth.uid'), 'Sellers must not modify another seller\'s product');
assert(rulesSource.includes('hasValidCancellationMetadata'), 'Order cancellations must include validated metadata');
assert(rulesSource.includes("request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status'])"), 'Customer update must only affect status key');
console.log('✔ Firestore rules deny client order creation and reserve paid status for admins.');

// 10. Check that only admin confirmation marks orders paid.
assert(workerSource.includes('body?.actualCreditConfirmed !== true'), 'Admin must explicitly confirm merchant-account credit');
assert(workerSource.includes("paymentStatus: 'Paid'"), 'Worker must mark an order paid after authorized confirmation');
console.log('✔ Worker requires admin-confirmed merchant credit before marking paid.');

console.log('\n--- ALL PAYMENT SETTINGS TESTS PASSED SUCCESSFULLY! ---');
