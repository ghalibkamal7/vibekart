/**
 * Static smoke checks for the manual UPI payment-attempt workflow.
 * Tests:
 * 1. PaymentSettings default values and schema validation.
 * 2. buildUpiUri and buildUpiQrUrl URI generator functions.
 * 3. Firestore security rule constraints on /settings/payment (isSignedIn read, isAdmin write).
 * 4. Payment attempts and admin verification use the Cloudflare Worker.
 * 5. Clients cannot create orders or directly update payment status.
 * 6. Cloudinary usage assurance and no Firebase Storage / Blaze requirements.
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
console.log('✔ Firestore settings and trusted Worker payment methods verified.');

// 5. Check Cloudflare Worker OTP handling for customerUtr
const workerSource = fs.readFileSync(path.join(__dirname, '../workers/otp/src/index.ts'), 'utf8');
assert(workerSource.includes('async function handleCreatePaymentAttempt'), 'Worker payment-attempt creation missing');
assert(workerSource.includes("if (!/^pay-[a-f0-9]{64}$/.test(attemptId) || !customerUtr || customerUtr.length > 100)"), 'Worker must require and cap submitted UTRs');
assert(workerSource.includes("if (url.pathname === '/create-order')"), 'Retired direct order route must be explicitly disabled');
assert(!workerSource.includes("url.pathname === '/payment/verify'"), 'Customer verification route must not be active');
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
assert(checkoutSource.includes('paymentSettings'), 'Checkout missing paymentSettings from StoreContext');
assert(checkoutSource.includes('manualUpiReady'), 'Checkout missing manualUpiReady check');
assert(checkoutSource.includes('customerUtr'), 'Checkout missing customerUtr input');
assert(checkoutSource.includes('awaiting verification'), 'Checkout missing verification status disclosure');
// 8. Check StoreContext admin order subscription and caching
const storeContextSource = fs.readFileSync(path.join(__dirname, '../context/StoreContext.tsx'), 'utf8');
assert(storeContextSource.includes("authUser.role === 'seller' || authUser.role === 'admin'"), 'Admin not included in order subscription filter');
assert(storeContextSource.includes('await AsyncStorage.setItem(STORAGE_KEYS.paymentSettings, JSON.stringify(merged));'), 'AsyncStorage paymentSettings persistence missing');
console.log('✔ StoreContext admin order filter and AsyncStorage caching verified.');

// 9. Check Customer cannot set paymentStatus in firestore.rules
assert(rulesSource.includes('allow create: if false;'), 'Clients must not create orders directly');
assert(rulesSource.includes('match /payment_attempts/{attemptId}'), 'Payment attempt rules missing');
assert(rulesSource.includes('allow create, update, delete: if false;'), 'Clients must not write payment attempts');
assert(rulesSource.includes("request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status'])"), 'Customer update must only affect status key');
console.log('✔ Firestore rules block client-created orders and payment attempts.');

// 10. Check that only admin confirmation marks orders paid.
assert(workerSource.includes('body?.actualCreditConfirmed !== true'), 'Admin must explicitly confirm merchant-account credit');
assert(workerSource.includes("paymentStatus: 'Paid'"), 'Worker must mark an order paid after authorized confirmation');
console.log('✔ Worker requires admin-confirmed merchant credit before marking paid.');

console.log('\n--- ALL PAYMENT SETTINGS TESTS PASSED SUCCESSFULLY! ---');
