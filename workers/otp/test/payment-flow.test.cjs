const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workerRoot = path.resolve(__dirname, '..');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibekart-worker-tests-'));
const records = new Map();
let worker;
let originalFetch;
let updateCounter = 0;
let failNextCommitStatus = null;
let cloudinaryStatus = 200;
let cloudinaryAssets = new Set();

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = {
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    project_id: 'vibekart-test',
    client_email: 'worker-test@example.iam.gserviceaccount.com',
    private_key: privateKey,
  }),
  CLOUDINARY_CLOUD_NAME: 'vibekart-test',
  CLOUDINARY_API_KEY: 'test-api-key',
  CLOUDINARY_API_SECRET: 'test-api-secret',
  OTP_KV: {
    async get() { return null; },
    async put() {},
    async delete() {},
  },
};

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(value) } };
}

function encodeFields(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
}

function decodeValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function documentPathFromName(name) {
  const marker = '/documents/';
  const start = name.indexOf(marker);
  return name.slice(start + marker.length).split('/').map(decodeURIComponent).join('/');
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function seed(pathname, data) {
  records.set(pathname, {
    data,
    updateTime: new Date(Date.now() + ++updateCounter).toISOString(),
  });
}

function resetStore() {
  records.clear();
  updateCounter = 0;
  failNextCommitStatus = null;
  cloudinaryStatus = 200;
  cloudinaryAssets = new Set(['vibekart/products/product-1/test-image']);
  seed('users/customer-1', { uid: 'customer-1', role: 'customer', status: 'active', phone: '+911234567890' });
  seed('users/admin-1', { uid: 'admin-1', role: 'admin', status: 'active' });
  seed('users/seller-1', { uid: 'seller-1', role: 'seller', status: 'active' });
  seed('users/seller-2', { uid: 'seller-2', role: 'seller', status: 'active' });
  seed('users/suspended-admin', { uid: 'suspended-admin', role: 'admin', status: 'suspended' });
  seed('settings/payment', { enabled: true, merchantVpa: 'vibekart@upi' });
  seed('products/product-1', {
    name: 'Test Lamp',
    price: 1250,
    inStock: true,
    enabled: true,
    createdByUid: 'seller-1',
    imagePublicIds: ['vibekart/products/product-1/test-image'],
  });
  seed('products/product-1/private/data', { baseCost: 700, sourceUrl: 'https://supplier.invalid/item' });
}

async function mockedFetch(input, init = {}) {
  const url = new URL(input);
  if (url.hostname === 'api.cloudinary.com') {
    assert.equal(url.pathname, '/v1_1/vibekart-test/resources/image/upload');
    assert.equal(init.method, 'DELETE');
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from('test-api-key:test-api-secret').toString('base64')}`);
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const publicIds = [...new URLSearchParams(init.body).getAll('public_ids[]')];
    assert.deepEqual(publicIds, ['vibekart/products/product-1/test-image']);
    if (cloudinaryStatus !== 200) return response({ error: { message: 'simulated Cloudinary failure' } }, cloudinaryStatus);
    const deleted = {};
    for (const id of publicIds) {
      deleted[id] = cloudinaryAssets.delete(id) ? 'deleted' : 'not_found';
    }
    return response({ deleted });
  }
  if (url.hostname === 'oauth2.googleapis.com') {
    return response({ access_token: 'test-access-token' });
  }
  if (url.hostname === 'identitytoolkit.googleapis.com') {
    const requestBody = JSON.parse(init.body || '{}');
    const users = {
      'customer-token': { localId: 'customer-1', email: 'buyer@example.test' },
      'admin-token': { localId: 'admin-1', email: 'admin@example.test' },
      'seller-token': { localId: 'seller-1', email: 'seller@example.test' },
      'seller-2-token': { localId: 'seller-2', email: 'seller-2@example.test' },
      'suspended-token': { localId: 'suspended-admin', email: 'suspended@example.test' },
    };
    return response({ users: users[requestBody.idToken] ? [users[requestBody.idToken]] : [] });
  }

  if (url.pathname.endsWith('/documents:commit')) {
    if (failNextCommitStatus) {
      const status = failNextCommitStatus;
      failNextCommitStatus = null;
      return response({ error: 'simulated Firestore permission/network failure' }, status);
    }

    const writes = JSON.parse(init.body || '{}').writes || [];
    const resolved = writes.map((write) => {
      const name = write.update?.name ?? write.delete;
      const documentPath = documentPathFromName(name);
      return { write, path: documentPath, current: records.get(documentPath) };
    });
    for (const { write, current } of resolved) {
      const precondition = write.currentDocument;
      if (precondition?.exists === false && current) return response({ error: 'already exists' }, 409);
      if (precondition?.exists === true && !current) return response({ error: 'missing document' }, 404);
      if (precondition?.updateTime && current?.updateTime !== precondition.updateTime) {
        return response({ error: 'document changed' }, 409);
      }
    }
    for (const { write, path: documentPath, current } of resolved) {
      if (write.delete) {
        records.delete(documentPath);
        continue;
      }
      const fields = decodeFields(write.update.fields || {});
      let data = fields;
      if (write.updateMask?.fieldPaths && current) {
        data = { ...current.data };
        for (const fieldPath of write.updateMask.fieldPaths) data[fieldPath] = fields[fieldPath];
      }
      seed(documentPath, data);
    }
    return response({ writeResults: [] });
  }

  const documentsMarker = '/documents/';
  const documentsIndex = url.pathname.indexOf(documentsMarker);
  if (documentsIndex < 0) return response({ error: 'unexpected URL' }, 404);
  const relativePath = url.pathname
    .slice(documentsIndex + documentsMarker.length)
    .split('/')
    .map(decodeURIComponent)
    .join('/');

  if (init.method === 'POST') {
    const body = JSON.parse(init.body || '{}');
    const documentId = url.searchParams.get('documentId');
    if (!documentId) return response({ error: 'missing documentId' }, 400);
    const documentPath = `${relativePath}/${documentId}`;
    if (records.has(documentPath)) return response({ error: 'already exists' }, 409);
    seed(documentPath, decodeFields(body.fields || {}));
    return response({});
  }

  const record = records.get(relativePath);
  if (!record) return response({ error: 'not found' }, 404);
  return response({ fields: encodeFields(record.data), updateTime: record.updateTime });
}

async function call(pathname, token, body) {
  const result = await worker.fetch(new Request(`https://worker.test${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), env);
  return { status: result.status, body: await result.json() };
}

function attemptRequest(idempotencyKey, options = {}) {
  return {
    items: [{ productId: 'product-1', quantity: 2, option: 'Sand' }],
    customerName: 'Buyer',
    customerPhone: '+911234567890',
    customerAddress: 'Test address',
    paymentMethod: 'UPI',
    idempotencyKey,
    ...options,
  };
}

async function createAttempt(idempotencyKey, token = 'customer-token', options) {
  return call('/payment-attempts/create', token, attemptRequest(idempotencyKey, options));
}

function manualOrderRequest(idempotencyKey, overrides = {}) {
  return {
    items: [{ productId: 'product-1', quantity: 2, option: 'Sand', unitPrice: 1 }],
    customerName: 'Buyer',
    customerPhone: '+911234567890',
    customerAddress: 'Test address',
    idempotencyKey,
    total: 2,
    amountPaise: 200,
    ...overrides,
  };
}

function seedManualOrder(orderId, overrides = {}) {
  seed(`orders/${orderId}`, {
    id: orderId,
    customerUid: 'customer-1',
    items: [{ productId: 'product-1', name: 'Test Lamp', quantity: 2, unitPrice: 1250, itemTotal: 2500 }],
    itemSubtotal: 2500,
    deliveryCharge: 45,
    total: 2545,
    amountPaise: 254500,
    currency: 'INR',
    paymentMethod: 'UPI',
    paymentStatus: 'Pending',
    status: 'Placed',
    customerUtr: 'customer-submitted-utr',
    ...overrides,
  });
}

before(() => {
  originalFetch = global.fetch;
  const tsc = path.join(workerRoot, 'node_modules', '.bin', 'tsc');
  execFileSync(tsc, [
    '--project', path.join(workerRoot, 'tsconfig.json'),
    '--outDir', buildDir,
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--noEmit', 'false',
  ], { cwd: workerRoot, stdio: 'inherit' });
  worker = require(path.join(buildDir, 'index.js')).default;
});

test('CORS allows the configured Vercel origin and rejects lookalike origins', () => {
  const { corsHeaders, isAllowedOrigin } = require(path.join(buildDir, 'cors.js'));
  const allowedOrigin = 'https://vibekaart.vercel.app';
  assert.equal(isAllowedOrigin(allowedOrigin), true);
  assert.equal(corsHeaders(allowedOrigin)['Access-Control-Allow-Origin'], allowedOrigin);
  assert.equal(isAllowedOrigin('https://vibekaart.vercel.app.attacker.test'), false);
  assert.equal(isAllowedOrigin('http://vibekaart.vercel.app'), false);
  assert.equal(isAllowedOrigin(null), false);
});

beforeEach(() => {
  resetStore();
  global.fetch = mockedFetch;
});

after(() => {
  global.fetch = originalFetch;
  fs.rmSync(buildDir, { recursive: true, force: true });
});

test('checkout creates only an authoritative, idempotent payment attempt', async () => {
  const first = await createAttempt('checkout-request-001');
  const second = await createAttempt('checkout-request-001');
  assert.equal(first.status, 201);
  assert.equal(first.body.attempt.total, 2500);
  assert.equal(first.body.attempt.status, 'Pending');
  assert.equal(second.body.attempt.id, first.body.attempt.id);
  assert.equal([...records.keys()].filter((key) => key.startsWith('payment_attempts/')).length, 2);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);
});

test('payment attempts calculate delivery charges and free-delivery thresholds on the server', async () => {
  seed('settings/store', {
    deliveryCharge: 45,
    freeDeliveryThreshold: 2500,
    freeDeliveryEnabled: true,
  });
  const atThreshold = await createAttempt('delivery-at-threshold');
  assert.equal(atThreshold.status, 201);
  assert.equal(atThreshold.body.attempt.itemSubtotal, 2500);
  assert.equal(atThreshold.body.attempt.deliveryCharge, 0);
  assert.equal(atThreshold.body.attempt.deliveryMinDays, 4);
  assert.equal(atThreshold.body.attempt.deliveryMaxDays, 6);
  assert.equal(atThreshold.body.attempt.total, 2500);
  assert.equal(atThreshold.body.attempt.amountPaise, 250000);

  seed('settings/store', {
    deliveryCharge: 45,
    freeDeliveryThreshold: 2501,
    freeDeliveryEnabled: true,
  });
  const charged = await createAttempt('delivery-charge-applied');
  assert.equal(charged.status, 201);
  assert.equal(charged.body.attempt.deliveryCharge, 45);
  assert.equal(charged.body.attempt.total, 2545);
  assert.equal(charged.body.attempt.amountPaise, 254500);
});

test('manual UPI order creation uses server product prices and is idempotent', async () => {
  seed('settings/store', {
    deliveryCharge: 45,
    freeDeliveryThreshold: 2500,
    freeDeliveryEnabled: false,
    deliveryMinDays: 7,
    deliveryMaxDays: 9,
  });

  const first = await call(
    '/manual-upi/orders/create',
    'customer-token',
    manualOrderRequest('manual-order-request-001'),
  );
  const retry = await call(
    '/manual-upi/orders/create',
    'customer-token',
    manualOrderRequest('manual-order-request-001', {
      items: [{ productId: 'product-1', quantity: 2, unitPrice: 999999 }],
      total: 1,
      amountPaise: 100,
    }),
  );

  assert.equal(first.status, 201);
  assert.equal(first.body.order.items[0].unitPrice, 1250);
  assert.equal(first.body.order.itemSubtotal, 2500);
  assert.equal(first.body.order.deliveryCharge, 45);
  assert.equal(first.body.order.total, 2545);
  assert.equal(first.body.order.amountPaise, 254500);
  assert.equal(first.body.order.paymentStatus, 'Pending');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.order.id, first.body.order.id);
  assert.equal(retry.body.order.total, 2545);
  assert.equal(records.get(`orders/${first.body.order.id}/private/data`).data.costTotal, 1400);
});

test('manual UPI order creation rejects unavailable products and invalid quantities', async () => {
  const invalidQuantity = await call(
    '/manual-upi/orders/create',
    'customer-token',
    manualOrderRequest('manual-order-request-002', {
      items: [{ productId: 'product-1', quantity: 0 }],
    }),
  );
  assert.equal(invalidQuantity.status, 400);

  seed('products/product-1', { name: 'Test Lamp', price: 1250, inStock: false });
  const unavailable = await call(
    '/manual-upi/orders/create',
    'customer-token',
    manualOrderRequest('manual-order-request-003'),
  );
  assert.equal(unavailable.status, 409);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);
});

test('manual UPI order creation fails closed when payment is disabled or merchant details are missing', async () => {
  seed('settings/payment', { enabled: false, merchantVpa: 'vibekart@upi' });
  const disabled = await call(
    '/manual-upi/orders/create',
    'customer-token',
    manualOrderRequest('manual-order-disabled'),
  );
  assert.equal(disabled.status, 409);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);

  seed('settings/payment', { enabled: true, merchantVpa: '  ' });
  const missingVpa = await call(
    '/manual-upi/orders/create',
    'customer-token',
    manualOrderRequest('manual-order-no-vpa'),
  );
  assert.equal(missingVpa.status, 409);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);
});

test('product deletion requires an authorized owner and removes stored images and product documents', async () => {
  const forbidden = await call('/seller/products/delete', 'customer-token', { productId: 'product-1' });
  assert.equal(forbidden.status, 403);
  const anotherSeller = await call('/seller/products/delete', 'seller-2-token', { productId: 'product-1' });
  assert.equal(anotherSeller.status, 403);
  assert.equal(records.has('products/product-1'), true);

  const deleted = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(deleted.status, 200);
  assert.equal(records.has('products/product-1'), false);
  assert.equal(records.has('products/product-1/private/data'), false);
});

test('an administrator can delete a legacy product without an owner UID', async () => {
  seed('products/legacy-product', { name: 'Legacy', imagePublicIds: [] });
  const deleted = await call('/seller/products/delete', 'admin-token', { productId: 'legacy-product' });
  assert.equal(deleted.status, 200);
  assert.equal(records.has('products/legacy-product'), false);
});

test('product deletion fails closed when Cloudinary credentials are missing', async () => {
  const secret = env.CLOUDINARY_API_SECRET;
  env.CLOUDINARY_API_SECRET = undefined;
  try {
    const result = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
    assert.equal(result.status, 503);
    assert.equal(records.has('products/product-1'), true);
  } finally {
    env.CLOUDINARY_API_SECRET = secret;
  }
});

test('failed image deletion preserves product documents so deletion can be retried', async () => {
  cloudinaryStatus = 503;
  const failed = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(failed.status, 502);
  assert.equal(records.has('products/product-1'), true);
  assert.equal(records.has('products/product-1/private/data'), true);

  cloudinaryStatus = 200;
  const retry = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(retry.status, 200);
  assert.equal(records.has('products/product-1'), false);
});

test('product documents remain intact when the Firestore delete fails after Cloudinary cleanup', async () => {
  failNextCommitStatus = 409;
  const failed = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /Images were deleted/i);
  assert.equal(records.has('products/product-1'), true);
  assert.equal(records.has('products/product-1/private/data'), true);

  const retry = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(retry.status, 200);
  assert.equal(records.has('products/product-1'), false);
});

test('whitespace UTR is rejected and a submitted UTR does not create an order', async () => {
  const created = await createAttempt('checkout-request-002');
  const attemptId = created.body.attempt.id;
  const empty = await call('/payment-attempts/submit', 'customer-token', { attemptId, customerUtr: '  \t ' });
  assert.equal(empty.status, 400);
  const submitted = await call('/payment-attempts/submit', 'customer-token', {
    attemptId,
    customerUtr: '  app:reference / 001  ',
  });
  assert.equal(submitted.status, 200);
  assert.match(submitted.body.message, /awaiting verification/i);
  assert.equal(records.get(`payment_attempts/${attemptId}`).data.customerUtr, 'app:reference / 001');
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);
});

test('only an active admin can confirm a payment; confirmation is atomic and idempotent', async () => {
  seed('settings/store', {
    deliveryCharge: 45,
    freeDeliveryEnabled: false,
    deliveryMinDays: 7,
    deliveryMaxDays: 9,
  });
  const created = await createAttempt('checkout-request-003');
  const attemptId = created.body.attempt.id;
  assert.equal(created.body.attempt.total, 2545);
  await call('/payment-attempts/submit', 'customer-token', { attemptId, customerUtr: 'Reference-ABC' });

  const customerConfirm = await call('/admin/payment-attempts/confirm', 'customer-token', {
    attemptId,
    actualCreditConfirmed: true,
  });
  assert.equal(customerConfirm.status, 403);
  const suspendedConfirm = await call('/admin/payment-attempts/confirm', 'suspended-token', {
    attemptId,
    actualCreditConfirmed: true,
  });
  assert.equal(suspendedConfirm.status, 403);

  const confirmed = await call('/admin/payment-attempts/confirm', 'admin-token', {
    attemptId,
    actualCreditConfirmed: true,
  });
  assert.equal(confirmed.status, 200);
  const retry = await call('/admin/payment-attempts/confirm', 'admin-token', {
    attemptId,
    actualCreditConfirmed: true,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.orderId, confirmed.body.orderId);
  assert.equal(records.get(`orders/${confirmed.body.orderId}`).data.paymentStatus, 'Paid');
  assert.equal(records.get(`orders/${confirmed.body.orderId}`).data.itemSubtotal, 2500);
  assert.equal(records.get(`orders/${confirmed.body.orderId}`).data.deliveryCharge, 45);
  assert.equal(records.get(`orders/${confirmed.body.orderId}`).data.deliveryMinDays, 7);
  assert.equal(records.get(`orders/${confirmed.body.orderId}`).data.deliveryMaxDays, 9);
  assert.equal(records.get(`orders/${confirmed.body.orderId}`).data.total, 2545);
  assert.equal(records.get(`payment_attempts/${attemptId}`).data.status, 'Paid');
  const sharedClaim = `payment_reference_claims/ref-${encodeURIComponent('REFERENCE-ABC')}`;
  assert.equal(records.get(sharedClaim).data.orderId, confirmed.body.orderId);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/') && !key.includes('/private/')).length, 1);
});

test('confirmation requires submitted details and rejects a reused transaction reference', async () => {
  const noUtr = await createAttempt('checkout-request-004');
  const missingReference = await call('/admin/payment-attempts/confirm', 'admin-token', {
    attemptId: noUtr.body.attempt.id,
    actualCreditConfirmed: true,
  });
  assert.equal(missingReference.status, 409);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);

  const first = await createAttempt('checkout-request-005');
  const second = await createAttempt('checkout-request-006');
  await call('/payment-attempts/submit', 'customer-token', {
    attemptId: first.body.attempt.id,
    customerUtr: 'UPI-Ref / Mixed Case',
  });
  await call('/payment-attempts/submit', 'customer-token', {
    attemptId: second.body.attempt.id,
    customerUtr: 'upi-ref / mixed case',
  });
  await call('/admin/payment-attempts/confirm', 'admin-token', {
    attemptId: first.body.attempt.id,
    actualCreditConfirmed: true,
  });
  const duplicate = await call('/admin/payment-attempts/confirm', 'admin-token', {
    attemptId: second.body.attempt.id,
    actualCreditConfirmed: true,
  });
  assert.equal(duplicate.status, 409);
  assert.equal(records.get(`payment_attempts/${second.body.attempt.id}`).data.status, 'Submitted');
});

test('future Worker verification honors the shared manual-UPI reference claim', async () => {
  const created = await createAttempt('shared-reference-claim');
  const attemptId = created.body.attempt.id;
  const reference = 'shared-upi-reference';
  await call('/payment-attempts/submit', 'customer-token', { attemptId, customerUtr: reference });
  seed(`payment_reference_claims/ref-${encodeURIComponent(reference.toLocaleUpperCase('en-US'))}`, {
    orderId: 'manual-order-1',
    reference,
  });

  const result = await call('/admin/payment-attempts/confirm', 'admin-token', {
    attemptId,
    actualCreditConfirmed: true,
  });
  assert.equal(result.status, 409);
  assert.equal(records.get(`payment_attempts/${attemptId}`).data.status, 'Submitted');
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);
});

test('expired attempts remain submittable until manually expired after review', async () => {
  const created = await createAttempt('checkout-request-007');
  const attemptId = created.body.attempt.id;
  const record = records.get(`payment_attempts/${attemptId}`);
  record.data.expiresAt = new Date(Date.now() - 60_000).toISOString();
  record.updateTime = new Date(Date.now() + ++updateCounter).toISOString();

  const submitted = await call('/payment-attempts/submit', 'customer-token', {
    attemptId,
    customerUtr: 'late-reference-07',
  });
  assert.equal(submitted.status, 200);
  const expired = await call('/admin/payment-attempts/expire', 'admin-token', {
    attemptId,
    reason: 'Reviewed merchant account; no credit found.',
    adminReviewed: true,
  });
  assert.equal(expired.status, 200);
  assert.equal(records.get(`payment_attempts/${attemptId}`).data.status, 'Expired');
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);
});

test('rejected attempts and failed Firestore writes do not create fulfillable orders', async () => {
  const created = await createAttempt('checkout-request-008');
  const attemptId = created.body.attempt.id;
  await call('/payment-attempts/submit', 'customer-token', { attemptId, customerUtr: 'not-paid-ref' });
  const rejected = await call('/admin/payment-attempts/reject', 'admin-token', {
    attemptId,
    reason: 'No matching credit was found.',
    adminReviewed: true,
  });
  assert.equal(rejected.status, 200);
  assert.equal(records.get(`payment_attempts/${attemptId}`).data.status, 'Rejected');
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);

  failNextCommitStatus = 403;
  const failed = await createAttempt('checkout-request-009');
  assert.equal(failed.status, 500);
  assert.match(failed.body.error, /Could not create the payment attempt/i);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);
});

test('legacy paid records remain unchanged and unpaid legacy payments require admin review', async () => {
  const original = {
    id: 'existing-paid',
    customerUid: 'customer-1',
    paymentMethod: 'UPI',
    paymentStatus: 'Paid',
    status: 'Processing',
    total: 525,
    customerUtr: 'legacy-ref',
  };
  seed('orders/existing-paid', original);
  seed('orders/legacy-pending', {
    id: 'legacy-pending',
    customerUid: 'customer-1',
    customerName: 'Buyer',
    customerPhone: '+911234567890',
    customerAddress: 'Test address',
    items: [{ productId: 'product-1', name: 'Test Lamp', quantity: 1, unitPrice: 1250 }],
    total: 1250,
    paymentMethod: 'UPI',
    paymentStatus: 'Pending',
    status: 'Placed',
  });
  const unauthorized = await call('/admin/legacy-orders/confirm-payment', 'customer-token', {
    orderId: 'legacy-pending',
    customerUtr: 'legacy-new-ref',
    actualCreditConfirmed: true,
  });
  assert.equal(unauthorized.status, 403);
  const confirmed = await call('/admin/legacy-orders/confirm-payment', 'admin-token', {
    orderId: 'legacy-pending',
    customerUtr: 'legacy-new-ref',
    actualCreditConfirmed: true,
  });
  assert.equal(confirmed.status, 200);
  assert.equal(records.get('orders/legacy-pending').data.paymentStatus, 'Paid');
  assert.equal(
    records.get(`payment_reference_claims/ref-${encodeURIComponent('LEGACY-NEW-REF')}`).data.orderId,
    'legacy-pending',
  );
  assert.deepEqual(records.get('orders/existing-paid').data, original);
});

test('an active admin confirms a pending UPI order atomically with claims and reviewer audit', async () => {
  seedManualOrder('manual-confirm-1');
  for (const token of ['customer-token', 'seller-token', 'suspended-token']) {
    const denied = await call('/admin/manual-upi/orders/confirm-payment', token, {
      orderId: 'manual-confirm-1',
      customerUtr: 'merchant-credit-reference',
    });
    assert.equal(denied.status, 403);
  }
  const result = await call('/admin/manual-upi/orders/confirm-payment', 'admin-token', {
    orderId: 'manual-confirm-1',
    customerUtr: 'merchant-credit-reference',
    total: 1,
    amountPaise: 100,
  });

  assert.equal(result.status, 200);
  const order = records.get('orders/manual-confirm-1').data;
  assert.equal(order.paymentStatus, 'Paid');
  assert.equal(order.status, 'Placed');
  assert.equal(order.paymentReference, 'merchant-credit-reference');
  assert.equal(order.customerUtr, 'customer-submitted-utr');
  assert.equal(order.total, 2545);
  assert.equal(order.amountPaise, 254500);
  assert.equal(order.paymentReviewedByUid, 'admin-1');
  assert.equal(order.paymentReviewAction, 'Confirmed');
  assert.ok(order.paymentReviewedAt);
  assert.equal(
    records.get(`payment_reference_claims/ref-${encodeURIComponent('MERCHANT-CREDIT-REFERENCE')}`).data.orderId,
    'manual-confirm-1',
  );
  const audits = [...records.entries()].filter(([key]) => key.startsWith('audit_logs/'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1].data.adminUid, 'admin-1');
  assert.equal(audits[0][1].data.targetId, 'manual-confirm-1');
});

test('only an active admin may reject a pending UPI order and the rejection is audited', async () => {
  seedManualOrder('manual-reject-1');
  const unauthenticated = await worker.fetch(new Request('https://worker.test/admin/manual-upi/orders/reject-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: 'manual-reject-1',
      reason: 'No merchant credit found.',
    }),
  }), env);
  assert.equal(unauthenticated.status, 401);

  for (const token of ['customer-token', 'seller-token', 'suspended-token']) {
    const denied = await call('/admin/manual-upi/orders/reject-payment', token, {
      orderId: 'manual-reject-1',
      reason: 'No merchant credit found.',
    });
    assert.equal(denied.status, 403);
  }

  const rejected = await call('/admin/manual-upi/orders/reject-payment', 'admin-token', {
    orderId: 'manual-reject-1',
    reason: 'No merchant credit found.',
  });
  assert.equal(rejected.status, 200);
  const order = records.get('orders/manual-reject-1').data;
  assert.equal(order.paymentStatus, 'Failed');
  assert.equal(order.status, 'Cancelled');
  assert.equal(order.paymentReviewReason, 'No merchant credit found.');
  assert.equal(order.paymentReviewedByUid, 'admin-1');
  assert.equal(order.paymentReviewAction, 'Rejected');
  assert.ok(order.paymentReviewedAt);
  assert.equal([...records.keys()].filter((key) => key.startsWith('audit_logs/')).length, 1);
});

test('manual UPI review rejects invalid IDs and never trusts malformed order pricing', async () => {
  const missingId = await call('/admin/manual-upi/orders/confirm-payment', 'admin-token', {
    orderId: '',
    customerUtr: 'merchant-reference',
    actualCreditConfirmed: true,
  });
  assert.equal(missingId.status, 400);

  seedManualOrder('manual-invalid-price', { amountPaise: 1 });
  const invalidPrice = await call('/admin/manual-upi/orders/confirm-payment', 'admin-token', {
    orderId: 'manual-invalid-price',
    customerUtr: 'merchant-reference',
    actualCreditConfirmed: true,
  });
  assert.equal(invalidPrice.status, 409);
  assert.equal(records.get('orders/manual-invalid-price').data.paymentStatus, 'Pending');
  assert.equal([...records.keys()].filter((key) => key.startsWith('audit_logs/')).length, 0);
});

test('UTR submission alone never marks an order paid', async () => {
  seedManualOrder('manual-utr-only');
  records.get('orders/manual-utr-only').data.customerUtr = 'customer-entered-reference';
  assert.equal(records.get('orders/manual-utr-only').data.paymentStatus, 'Pending');
  assert.equal(records.has('payment_reference_claims/ref-CUSTOMER-ENTERED-REFERENCE'), false);
});

test('manual UPI confirmation is idempotent only for the same reference and protects against duplicate claims', async () => {
  seedManualOrder('manual-idempotent-1');
  const body = {
    orderId: 'manual-idempotent-1',
    customerUtr: 'idempotent-reference',
  };
  const confirmed = await call('/admin/manual-upi/orders/confirm-payment', 'admin-token', body);
  assert.equal(confirmed.status, 200);
  const duplicate = await call('/admin/manual-upi/orders/confirm-payment', 'admin-token', body);
  assert.equal(duplicate.status, 200);
  const differentReference = await call('/admin/manual-upi/orders/confirm-payment', 'admin-token', {
    ...body,
    customerUtr: 'different-reference',
  });
  assert.equal(differentReference.status, 409);
  assert.equal([...records.keys()].filter((key) => key.startsWith('audit_logs/')).length, 1);

  seedManualOrder('manual-idempotent-2');
  const reusedReference = await call('/admin/manual-upi/orders/confirm-payment', 'admin-token', {
    ...body,
    orderId: 'manual-idempotent-2',
  });
  assert.equal(reusedReference.status, 409);
  assert.equal(records.get('orders/manual-idempotent-2').data.paymentStatus, 'Pending');
});

test('concurrent confirmation and rejection cannot both transition the same UPI order', async () => {
  seedManualOrder('manual-race');
  const [confirmed, rejected] = await Promise.all([
    call('/admin/manual-upi/orders/confirm-payment', 'admin-token', {
      orderId: 'manual-race',
      customerUtr: 'race-reference',
    }),
    call('/admin/manual-upi/orders/reject-payment', 'admin-token', {
      orderId: 'manual-race',
      reason: 'No matching credit.',
    }),
  ]);
  assert.equal([confirmed, rejected].filter((result) => result.status === 200).length, 1);
  const order = records.get('orders/manual-race').data;
  assert.ok(
    (order.paymentStatus === 'Paid' && order.status === 'Placed') ||
    (order.paymentStatus === 'Failed' && order.status === 'Cancelled'),
  );
  assert.equal([...records.keys()].filter((key) => key.startsWith('audit_logs/')).length, 1);
});

test('preflight permits the authenticated cross-origin Worker requests', async () => {
  const origin = 'https://vibekaart.vercel.app';
  const result = await worker.fetch(new Request('https://worker.test/payment-attempts/submit', {
    method: 'OPTIONS',
    headers: { Origin: origin },
  }), env);
  assert.equal(result.status, 204);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(result.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(result.headers.get('Access-Control-Allow-Methods'), /POST/);

  const deniedOrigin = await worker.fetch(new Request('https://worker.test/payment-attempts/submit', {
    method: 'OPTIONS',
    headers: { Origin: 'https://vibekaart.vercel.app.attacker.test' },
  }), env);
  assert.equal(deniedOrigin.status, 204);
  assert.equal(deniedOrigin.headers.get('Access-Control-Allow-Origin'), 'null');
});

test('retired direct order and customer verification endpoints are unavailable', async () => {
  const directOrder = await call('/create-order', 'customer-token', attemptRequest('legacy-request-01'));
  const customerVerification = await call('/payment/verify', 'customer-token', {
    orderId: 'legacy-order-01',
  });
  assert.equal(directOrder.status, 410);
  assert.equal(customerVerification.status, 404);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/')).length, 0);
});
