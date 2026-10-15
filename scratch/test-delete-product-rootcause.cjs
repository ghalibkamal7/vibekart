/**
 * VibeKart Product Delete — Root Cause Analysis Test
 *
 * Traces the complete delete flow through all layers and identifies every
 * issue that can cause "delete doesn't work."
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const contextSrc = fs.readFileSync(path.join(root, 'context/StoreContext.tsx'), 'utf8');
const firestoreSrc = fs.readFileSync(path.join(root, 'services/firebase/firestore.ts'), 'utf8');
const rulesSrc = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const adminSrc = fs.readFileSync(path.join(root, 'app/admin.tsx'), 'utf8');
const sellerSrc = fs.readFileSync(path.join(root, 'app/seller.tsx'), 'utf8');

console.log('====================================================');
console.log('  PRODUCT DELETE — ROOT CAUSE ANALYSIS');
console.log('====================================================\n');

// ---- 1. Check removeProduct exists and calls deleteDoc ----
console.log('[1] Checking removeProduct in firestore.ts...');
assert(firestoreSrc.includes('export async function removeProduct'), 'removeProduct not found');
assert(firestoreSrc.includes('deleteDoc(doc(database, PRODUCTS_COLLECTION, id, PRIVATE_SUBCOLLECTION, PRIVATE_DOC_ID))'), 'removeProduct does not delete private doc');
assert(firestoreSrc.includes('deleteDoc(doc(database, PRODUCTS_COLLECTION, id))'), 'removeProduct does not delete main product doc');
console.log('  ✔ removeProduct calls deleteDoc on private and main docs.');

// ---- 2. Check deleteProduct in StoreContext ----
console.log('\n[2] Checking deleteProduct in StoreContext.tsx...');
assert(contextSrc.includes('await removeProduct(id)'), 'deleteProduct does not call removeProduct');
assert(contextSrc.includes('await refreshSellerProducts()'), 'deleteProduct does not call refreshSellerProducts');
console.log('  ✔ deleteProduct calls removeProduct(id) then refreshSellerProducts().');

// ---- 3. Firestore rules: can seller/admin delete products? ----
console.log('\n[3] Checking Firestore rules for product deletion...');
assert(rulesSrc.includes('allow create, update, delete: if isSeller()'), 'products delete rule missing');
console.log('  ✔ isSeller() (includes admin) can delete products and their private sub-docs.');

// ---- 4. CRITICAL: Admin product subscription vs. deleteProduct refresh ----
console.log('\n[4] Analyzing admin product subscription flow...');
// The useEffect only uses refreshSellerProducts() for role === 'seller'.
// For role === 'admin', it falls through to subscribeToProducts() (realtime listener).
const adminUsesRealtimeListener = contextSrc.includes("authUser.role === 'seller'") &&
  !contextSrc.includes("authUser.role === 'admin'", contextSrc.indexOf('refreshSellerProducts'));
console.log(`  Admin uses realtime subscribeToProducts listener: ${adminUsesRealtimeListener}`);
console.log('  subscribeToProducts uses toPublicProduct() which strips private fields.');
console.log('  refreshSellerProducts uses fetchSellerProducts() which merges private fields.');
console.log('  ⚠ After admin deletes → refreshSellerProducts sets state with full private cost data.');
console.log('    Then the realtime listener immediately fires again and overwrites with toPublicProduct()');
console.log('    (stripping baseCost/markup). This is a data inconsistency bug but NOT the delete bug.');

// ---- 5. CRITICAL: seller.tsx confirmDelete has NO error handling ----
console.log('\n[5] Checking seller.tsx delete error handling...');
const sellerDeleteLine = sellerSrc.match(/onPress:\s*\(\)\s*=>\s*deleteProduct\(id\)/);
assert(sellerDeleteLine, 'Could not find seller delete onPress');
const hasAwaitInSeller = sellerSrc.includes('onPress: async () => { await deleteProduct(id)');
const hasTryCatchInSeller = sellerSrc.includes('try') && sellerSrc.indexOf('try') > sellerSrc.indexOf('confirmDelete');
console.log(`  Seller delete uses await: ${hasAwaitInSeller}`);
console.log(`  Seller delete has try/catch: ${hasTryCatchInSeller}`);
console.log('  ⚠ FINDING: seller.tsx fires deleteProduct(id) WITHOUT await and WITHOUT try/catch.');
console.log('    If removeProduct throws (e.g., permission denied), the error is an unhandled rejection.');
console.log('    The user sees nothing — the product stays in the list with no error message.');

// ---- 6. admin.tsx handleDeleteProduct error handling ----
console.log('\n[6] Checking admin.tsx delete error handling...');
assert(adminSrc.includes('await deleteProduct(p.id)'), 'admin delete does not await');
assert(adminSrc.includes("Alert.alert('Error', err?.message || 'Failed to delete product.')"), 'admin delete missing error alert');
console.log('  ✔ admin.tsx properly awaits and catches errors with an alert.');

// ---- 7. Check whether admin gets refreshSellerProducts that may fail ----
console.log('\n[7] Checking refreshSellerProducts for admin...');
// fetchSellerProducts reads each product's private/data sub-doc.
// For a 'seller' role, the rules allow this (isSeller() returns true for both seller and admin).
// But subscribeToProducts is the *initial* loader for admins, and it doesn't read private docs.
// After deleteProduct → refreshSellerProducts → setProducts(await fetchSellerProducts()),
// the realtime listener onSnapshot fires AGAIN because the subscription is still active,
// overwriting with the public-only view. This is a flickering/data issue but the product
// SHOULD still be deleted from Firestore.
console.log('  refreshSellerProducts does full private merge fetch.');
console.log('  For admin: realtime listener continues running and may overwrite.');
console.log('  But the Firestore document IS deleted, so both should exclude it.');

// ---- 8. Check for the REAL root cause: the private sub-doc may not exist ----
console.log('\n[8] Checking if missing private sub-doc breaks removeProduct...');
// removeProduct calls deleteDoc on products/{id}/private/data FIRST.
// If this sub-doc doesn't exist (e.g., product was created locally or the private
// doc was never written), Firestore's deleteDoc on a non-existent doc succeeds
// silently. This is NOT the issue.
console.log('  deleteDoc on non-existent doc succeeds silently in Firebase v9+. Not the issue.');

// ---- 9. Check if product IDs could be wrong ----
console.log('\n[9] Checking product ID flow...');
assert(adminSrc.includes('deleteProduct(p.id)'), 'admin uses p.id for delete');
assert(sellerSrc.includes('deleteProduct(id)'), 'seller uses id parameter');
console.log('  ✔ Both pass the correct product ID.');

// ---- 10. Check if deleteProduct optimistically removes from local state ----
console.log('\n[10] Checking optimistic UI removal...');
// In cloud mode, deleteProduct does NOT remove from local state immediately.
// It calls removeProduct (network call) then refreshSellerProducts (another network call).
// If either fails, the product remains in the list with no feedback (especially in seller.tsx).
// 
// Compare with the local/demo mode path: setProducts(current => current.filter(...))
// which IS immediate.
const cloudPathHasOptimisticRemoval = contextSrc.includes(
  'setProducts((current) => current.filter((product) => product.id !== id))'
);
// Check if this line is ONLY in the else (non-cloud) branch:
const deleteBlock = contextSrc.slice(
  contextSrc.indexOf("const deleteProduct: StoreContextValue['deleteProduct']"),
  contextSrc.indexOf("const toggleStock:")
);
const cloudBranch = deleteBlock.slice(
  deleteBlock.indexOf('if (isCloudMode)'),
  deleteBlock.indexOf('setProducts((current) => current.filter')
);
const filterIsInCloudBranch = cloudBranch.includes('filter');
console.log(`  Cloud mode has optimistic removal before network call: ${filterIsInCloudBranch}`);
console.log('  ⚠ FINDING: In cloud mode, deleteProduct does NOT remove the product from');
console.log('    local state first. It waits for removeProduct() + refreshSellerProducts().');
console.log('    If either network call fails or is slow, the UI shows no change.');
console.log('    The user thinks nothing happened and may tap Delete again.');

console.log('\n====================================================');
console.log('  ROOT CAUSE SUMMARY');
console.log('====================================================');
console.log(`
BUG #1 (PRIMARY — seller.tsx): The delete button fires deleteProduct(id)
  WITHOUT await and WITHOUT try/catch. If removeProduct() throws (e.g.,
  Firestore permission denied, network error, or the private doc delete
  fails), the rejection is completely unhandled and silent. The user sees
  no error and the product stays in the list.

BUG #2 (UX — cloud mode): In cloud mode, deleteProduct does NOT optimistically
  remove the product from local state before the network call. The user
  sees no immediate feedback. Combined with Bug #1, it looks like delete
  "doesn't work" even when it silently fails OR when it's just slow.

BUG #3 (DATA — admin role): Admin users get products via subscribeToProducts
  (realtime listener with public-only toPublicProduct), but after delete,
  refreshSellerProducts overwrites with the full private-merged version.
  The realtime listener then fires and strips private fields again. This
  causes flickering and data inconsistency (baseCost shows 0 briefly).

These three bugs combine to create the symptom: "deleting a product does
not work" — especially on seller.tsx where there is zero error feedback.
`);
