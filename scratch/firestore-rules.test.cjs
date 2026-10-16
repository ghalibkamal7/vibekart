const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
const {
  doc,
  deleteDoc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} = require('firebase/firestore');

const projectId = 'demo-vibekart-manual-upi';
let testEnvironment;

function orderData(id, customerUid = 'customer-1') {
  return {
    id,
    customerUid,
    items: [{ productId: 'product-1', name: 'Test product', quantity: 1, unitPrice: 1000 }],
    itemSubtotal: 1000,
    deliveryCharge: 50,
    deliveryMinDays: 3,
    deliveryMaxDays: 7,
    total: 1050,
    amountPaise: 105000,
    currency: 'INR',
    paymentMethod: 'UPI',
    paymentStatus: 'Pending',
    paymentInitiatedAt: new Date().toISOString(),
    status: 'Placed',
    date: '16 Oct',
    customerName: 'Customer',
    customerPhone: '9876543210',
    customerAddress: 'Test address',
    createdAt: serverTimestamp(),
  };
}

async function seedOrder(id, customerUid = 'customer-1') {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `orders/${id}`), orderData(id, customerUid));
  });
}

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
    },
  });
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore();
    await Promise.all([
      setDoc(doc(database, 'users/customer-1'), { uid: 'customer-1', role: 'customer', status: 'active' }),
      setDoc(doc(database, 'users/customer-2'), { uid: 'customer-2', role: 'customer', status: 'active' }),
      setDoc(doc(database, 'users/admin-1'), { uid: 'admin-1', role: 'admin', status: 'active' }),
      setDoc(doc(database, 'users/seller-1'), { uid: 'seller-1', role: 'seller', status: 'active' }),
      setDoc(doc(database, 'users/suspended-admin'), { uid: 'suspended-admin', role: 'admin', status: 'suspended' }),
    ]);
  });
});

after(async () => {
  await testEnvironment?.cleanup();
});

test('customers cannot create orders directly and can only read their own Worker-created order', async () => {
  const customer = testEnvironment.authenticatedContext('customer-1').firestore();
  const order = doc(customer, 'orders/checkout-test-001');
  await assertFails(setDoc(order, orderData(order.id.split('/').at(-1))));
  await seedOrder('checkout-test-001');
  await assertSucceeds(getDoc(order));

  const otherCustomer = testEnvironment.authenticatedContext('customer-2').firestore();
  await assertFails(getDoc(doc(otherCustomer, 'orders/checkout-test-001')));
});

test('rules reject forged client prices and customer attempts to set payment status', async () => {
  const customer = testEnvironment.authenticatedContext('customer-1').firestore();
  const forged = orderData('checkout-forged-total');
  forged.total = 1;
  forged.amountPaise = 100;
  await assertFails(setDoc(doc(customer, 'orders/checkout-forged-total'), forged));

  const order = doc(customer, 'orders/checkout-test-002');
  await seedOrder('checkout-test-002');
  await assertSucceeds(updateDoc(order, { customerUtr: 'UTR-123' }));
  const afterUtr = await getDoc(order);
  assert.equal(afterUtr.data().paymentStatus, 'Pending');

  await assertFails(updateDoc(order, {
    paymentStatus: 'Paid',
    paymentReference: 'UTR-123',
    paymentVerifiedAt: serverTimestamp(),
  }));
});

test('payment confirmation, reference claims, and payment audit writes are Worker-only', async () => {
  const customer = testEnvironment.authenticatedContext('customer-1').firestore();
  const orderId = 'checkout-test-003';
  const order = doc(customer, `orders/${orderId}`);
  await seedOrder(orderId);
  await assertSucceeds(updateDoc(order, { customerUtr: 'UTR-UNIQUE' }));

  const unauthorized = testEnvironment.authenticatedContext('customer-2').firestore();
  await assertFails(updateDoc(doc(unauthorized, `orders/${orderId}`), {
    paymentStatus: 'Paid',
    paymentReference: 'UTR-UNIQUE',
    paymentVerifiedAt: serverTimestamp(),
  }));

  const suspended = testEnvironment.authenticatedContext('suspended-admin').firestore();
  await assertFails(updateDoc(doc(suspended, `orders/${orderId}`), {
    paymentStatus: 'Paid',
    paymentReference: 'UTR-UNIQUE',
    paymentVerifiedAt: serverTimestamp(),
    paymentReviewedByUid: 'suspended-admin',
    paymentReviewedAt: serverTimestamp(),
    paymentReviewAction: 'Confirmed',
  }));

  const admin = testEnvironment.authenticatedContext('admin-1').firestore();
  const claim = doc(admin, 'payment_reference_claims/ref-UTR-UNIQUE');
  const seller = testEnvironment.authenticatedContext('seller-1').firestore();
  await assertFails(updateDoc(doc(seller, `orders/${orderId}`), {
    paymentStatus: 'Paid',
    paymentReference: 'UTR-UNIQUE',
    paymentVerifiedAt: serverTimestamp(),
    paymentReviewedByUid: 'seller-1',
    paymentReviewedAt: serverTimestamp(),
    paymentReviewAction: 'Confirmed',
  }));
  await assertFails(updateDoc(doc(customer, `orders/${orderId}`), {
    paymentReviewReason: 'approved by customer',
    paymentReviewedByUid: 'customer-1',
  }));

  await assertFails(runTransaction(admin, async (transaction) => {
    const adminOrder = doc(admin, `orders/${orderId}`);
    await transaction.get(adminOrder);
    transaction.update(adminOrder, {
      paymentStatus: 'Paid',
      paymentReference: 'UTR-UNIQUE',
      paymentVerifiedAt: serverTimestamp(),
      paymentReviewedByUid: 'admin-1',
      paymentReviewedAt: serverTimestamp(),
      paymentReviewAction: 'Confirmed',
    });
    transaction.set(claim, {
      orderId,
      reference: 'UTR-UNIQUE',
      createdAt: serverTimestamp(),
    });
  }));
  await assertFails(setDoc(claim, {
    orderId,
    reference: 'UTR-UNIQUE',
    createdAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(admin, 'audit_logs/payment-review-forged'), {
    adminUid: 'admin-1',
    action: 'Confirm Manual UPI Payment',
    targetId: orderId,
    paymentReference: 'UTR-UNIQUE',
    timestamp: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(admin, 'audit_logs/payment-attempt-forged'), {
    adminUid: 'admin-1',
    action: 'Confirm Payment',
    targetId: 'pay-123',
    details: 'Confirmed payment',
    timestamp: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(admin, 'audit_logs/payment-marker-forged'), {
    adminUid: 'admin-1',
    action: 'Update Payment Settings',
    targetId: 'pay-123',
    paymentReviewAction: 'Confirmed',
    timestamp: serverTimestamp(),
  }));
  await assertSucceeds(setDoc(doc(admin, 'audit_logs/settings-update'), {
    adminUid: 'admin-1',
    action: 'Update Payment Settings',
    details: 'Updated merchant display settings.',
    timestamp: serverTimestamp(),
  }));
  assert.equal((await getDoc(doc(admin, `orders/${orderId}`))).data().paymentStatus, 'Pending');
  assert.equal((await getDoc(claim)).exists(), false);
});

test('direct admin payment rejection is denied while customer UTR submission remains allowed', async () => {
  const orderId = 'checkout-test-reject';
  await seedOrder(orderId);
  const admin = testEnvironment.authenticatedContext('admin-1').firestore();
  await assertFails(updateDoc(doc(admin, `orders/${orderId}`), {
    paymentStatus: 'Failed',
    status: 'Cancelled',
    paymentReviewReason: 'No matching merchant-account credit.',
    paymentReviewedByUid: 'admin-1',
    paymentReviewedAt: serverTimestamp(),
    paymentReviewAction: 'Rejected',
  }));

  const customer = testEnvironment.authenticatedContext('customer-1').firestore();
  await seedOrder('checkout-test-reject-customer');
  await assertFails(updateDoc(doc(customer, 'orders/checkout-test-reject-customer'), {
    paymentStatus: 'Failed',
    status: 'Cancelled',
    paymentReviewReason: 'Customer forged a review.',
    paymentReviewedByUid: 'customer-1',
    paymentReviewedAt: serverTimestamp(),
    paymentReviewAction: 'Rejected',
  }));
});

test('admins and customers cannot directly write reference claims', async () => {
  const admin = testEnvironment.authenticatedContext('admin-1').firestore();
  const claimData = {
    orderId: 'first-order',
    reference: 'UTR-REUSED',
    createdAt: serverTimestamp(),
  };
  await assertFails(setDoc(doc(admin, 'payment_reference_claims/ref-UTR-REUSED'), claimData));
  const customer = testEnvironment.authenticatedContext('customer-1').firestore();
  await assertFails(setDoc(doc(customer, 'payment_reference_claims/ref-UTR-CUSTOMER'), claimData));
});

test('admin cannot review orders outside valid pending states or reject a paid order', async () => {
  const admin = testEnvironment.authenticatedContext('admin-1').firestore();
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore();
    await setDoc(doc(database, 'orders/processing-unpaid'), {
      ...orderData('processing-unpaid'),
      status: 'Processing',
    });
    await setDoc(doc(database, 'orders/already-paid'), {
      ...orderData('already-paid'),
      paymentStatus: 'Paid',
    });
  });

  await assertFails(updateDoc(doc(admin, 'orders/processing-unpaid'), {
    paymentStatus: 'Paid',
    paymentReference: 'UTR-123',
    paymentVerifiedAt: serverTimestamp(),
    paymentReviewedByUid: 'admin-1',
    paymentReviewedAt: serverTimestamp(),
    paymentReviewAction: 'Confirmed',
  }));
  await assertFails(updateDoc(doc(admin, 'orders/already-paid'), {
    paymentStatus: 'Failed',
    status: 'Cancelled',
    paymentReviewReason: 'No matching merchant credit.',
    paymentReviewedByUid: 'admin-1',
    paymentReviewedAt: serverTimestamp(),
    paymentReviewAction: 'Rejected',
  }));
});

test('existing Selected UPI orders cannot be approved by direct client writes', async () => {
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'orders/legacy-selected'), {
      ...orderData('legacy-selected'),
      paymentStatus: 'Selected',
    });
  });

  const admin = testEnvironment.authenticatedContext('admin-1').firestore();
  await assertFails(updateDoc(doc(admin, 'orders/legacy-selected'), {
    paymentStatus: 'Paid',
    paymentReference: 'LEGACY-UTR',
    paymentVerifiedAt: serverTimestamp(),
    paymentReviewedByUid: 'admin-1',
    paymentReviewedAt: serverTimestamp(),
    paymentReviewAction: 'Confirmed',
  }));
});

test('admins cannot delete payment settings directly, but may delete other settings', async () => {
  const admin = testEnvironment.authenticatedContext('admin-1').firestore();
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore();
    await setDoc(doc(database, 'settings/payment'), {
      merchantVpa: 'vibekart@upi',
      qrImageUrl: 'https://res.cloudinary.com/example/image/upload/qr',
      qrImagePublicId: 'vibekart/payment/qr',
    });
    await setDoc(doc(database, 'settings/banner'), { text: 'Sale' });
  });

  await assertFails(deleteDoc(doc(admin, 'settings/payment')));
  await assertSucceeds(deleteDoc(doc(admin, 'settings/banner')));
  await assertSucceeds(getDoc(doc(admin, 'settings/payment')));
});
