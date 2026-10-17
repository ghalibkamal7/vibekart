const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { createHash, generateKeyPairSync } = require('node:crypto');
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
let failGoogleTokenExchangeStatus = null;
let failProfileReadStatus = null;
let failCommitAfterCloudinaryUpload = false;
let mutateProductBeforeNextImageCommit = false;
let failCloudinaryUploadRequest = false;
let appendCleanupDuringDeleteId = null;
let cloudinaryStatus = 200;
let cloudinaryPartialFailureFor = null;
let cloudinaryAssets = new Set();
let kvValues = new Map();
let msg91Calls = 0;

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
    async get(key) { return kvValues.get(key) ?? null; },
    async put(key, value) { kvValues.set(key, value); },
    async delete(key) { kvValues.delete(key); },
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

function cloudinaryAssetRecordPath(publicId) {
  const digest = createHash('sha256').update(publicId).digest('hex');
  return `cloudinary_assets/${digest}`;
}

function seedCloudinaryAsset(publicId, overrides = {}) {
  seed(cloudinaryAssetRecordPath(publicId), {
    publicId,
    assetType: 'product',
    targetId: 'product-1',
    ownerUid: 'seller-1',
    status: 'attached',
    secureUrl: `https://res.cloudinary.com/vibekart-test/image/upload/${publicId}`,
    ...overrides,
  });
}

function resetStore() {
  records.clear();
  updateCounter = 0;
  failNextCommitStatus = null;
  failGoogleTokenExchangeStatus = null;
  failProfileReadStatus = null;
  failCommitAfterCloudinaryUpload = false;
  mutateProductBeforeNextImageCommit = false;
  failCloudinaryUploadRequest = false;
  appendCleanupDuringDeleteId = null;
  cloudinaryStatus = 200;
  cloudinaryPartialFailureFor = null;
  cloudinaryAssets = new Set(['vibekart/products/product-1/test-image']);
  kvValues = new Map();
  msg91Calls = 0;
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
    imageUrls: ['https://res.cloudinary.com/vibekart-test/image/upload/vibekart/products/product-1/test-image'],
  });
  seed('products/product-1/private/data', { baseCost: 700, sourceUrl: 'https://supplier.invalid/item' });
  seedCloudinaryAsset('vibekart/products/product-1/test-image');
}

async function mockedFetch(input, init = {}) {
  const url = new URL(input);
  if (url.hostname === 'control.msg91.com') {
    msg91Calls += 1;
    throw new Error('Disabled OTP endpoint must not call MSG91');
  }
  if (url.hostname === 'api.cloudinary.com') {
    if (init.method === 'POST') {
      assert.equal(url.pathname, '/v1_1/vibekart-test/image/upload');
      const form = init.body;
      const publicId = form.get('public_id');
      assert.equal(form.get('overwrite'), 'false');
      cloudinaryAssets.add(publicId);
      if (failCloudinaryUploadRequest) {
        failCloudinaryUploadRequest = false;
        failNextCommitStatus = 503;
        throw new Error('simulated lost upload response');
      }
      if (failCommitAfterCloudinaryUpload) {
        failCommitAfterCloudinaryUpload = false;
        failNextCommitStatus = 409;
      }
      return response({
        secure_url: `https://res.cloudinary.com/vibekart-test/image/upload/${publicId}`,
        public_id: publicId,
      });
    }
    assert.equal(init.method, 'DELETE');
    assert.equal(url.pathname, '/v1_1/vibekart-test/resources/image/upload');
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from('test-api-key:test-api-secret').toString('base64')}`);
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const publicIds = [...new URLSearchParams(init.body).getAll('public_ids[]')];
    assert.equal(publicIds.length, 1);
    if (appendCleanupDuringDeleteId) {
      const appendedId = appendCleanupDuringDeleteId;
      appendCleanupDuringDeleteId = null;
      const originalId = publicIds[0];
      cloudinaryAssets.add(appendedId);
      seedCloudinaryAsset(appendedId, { status: 'cleanup_pending' });
      const currentJob = records.get('cloudinary_cleanup_jobs/product-product-1').data;
      seed('cloudinary_cleanup_jobs/product-product-1', {
        ...currentJob,
        publicIds: [...currentJob.publicIds, appendedId],
      });
      assert.ok(currentJob.publicIds.includes(originalId));
    }
    if (cloudinaryStatus !== 200) return response({ error: { message: 'simulated Cloudinary failure' } }, cloudinaryStatus);
    const deleted = {};
    for (const id of publicIds) {
      if (id === cloudinaryPartialFailureFor) {
        deleted[id] = 'error';
      } else {
        deleted[id] = cloudinaryAssets.delete(id) ? 'deleted' : 'not_found';
      }
    }
    return response({ deleted });
  }
  if (url.hostname === 'oauth2.googleapis.com') {
    if (failGoogleTokenExchangeStatus) {
      const status = failGoogleTokenExchangeStatus;
      failGoogleTokenExchangeStatus = null;
      return response({ error: 'simulated OAuth dependency failure' }, status);
    }
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
      const name = write.update?.name ?? write.delete ?? write.verify;
      const documentPath = documentPathFromName(name);
      return { write, path: documentPath, current: records.get(documentPath) };
    });
    if (mutateProductBeforeNextImageCommit && resolved.some(({ path: target }) => target === 'products/product-1')) {
      mutateProductBeforeNextImageCommit = false;
      seed('products/product-1', {
        ...records.get('products/product-1').data,
        description: 'Concurrent edit',
      });
    }
    for (const { write, path: documentPath } of resolved) {
      const current = records.get(documentPath);
      const precondition = write.currentDocument;
      if (precondition?.exists === false && current) return response({ error: 'already exists' }, 409);
      if (precondition?.exists === true && !current) return response({ error: 'missing document' }, 404);
      if (precondition?.updateTime && current?.updateTime !== precondition.updateTime) {
        return response({ error: 'document changed' }, 409);
      }
    }
    for (const { write, path: documentPath, current } of resolved) {
      if (write.verify) continue;
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

  if (relativePath.startsWith('users/') && failProfileReadStatus) {
    const status = failProfileReadStatus;
    failProfileReadStatus = null;
    return response({ error: 'simulated Firestore profile read failure' }, status);
  }

  if (
    init.method !== 'POST' &&
    (relativePath === 'cloudinary_cleanup_jobs' || relativePath === 'cloudinary_assets')
  ) {
    const documents = [...records.entries()]
      .filter(([documentPath]) => documentPath.startsWith(`${relativePath}/`))
      .map(([documentPath, record]) => ({
        name: `projects/vibekart-test/databases/(default)/documents/${documentPath}`,
        fields: encodeFields(record.data),
      }));
    return response({ documents });
  }

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

async function callUpload(token, assetType = 'product', targetId = 'product-1', options = {}) {
  const form = new FormData();
  if (options.includeFile !== false) {
    const bytes = options.bytes || new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    form.append('file', new Blob([bytes], { type: options.mime || 'image/jpeg' }), 'test.jpg');
  }
  form.append('assetType', assetType);
  form.append('targetId', targetId);
  const headers = new Headers();
  if (options.contentType) headers.set('Content-Type', options.contentType);
  if (options.contentLength !== undefined) headers.set('Content-Length', String(options.contentLength));
  const result = await worker.fetch(new Request('https://worker.test/cloudinary/upload', {
    method: 'POST',
    headers: new Headers({ Authorization: `Bearer ${token}`, ...Object.fromEntries(headers.entries()) }),
    body: form,
  }), env);
  return { status: result.status, body: await result.json() };
}

async function callRawUpload(token, body, contentType, contentLength) {
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    'Content-Type': contentType,
  });
  if (contentLength !== undefined) headers.set('Content-Length', String(contentLength));
  const result = await worker.fetch(new Request('https://worker.test/cloudinary/upload', {
    method: 'POST',
    headers,
    body,
  }), env);
  return { status: result.status, body: await result.json() };
}

function attemptRequest(idempotencyKey, options = {}) {
  return {
    items: [{ productId: 'product-1', quantity: 2, option: 'Sand' }],
    customerName: 'Buyer',
    customerPhone: '+919876543210',
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
    customerPhone: '+919876543210',
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

test('Firestore payload serialization omits undefined fields and rejects undefined array entries', () => {
  const { toFirestoreFields } = require(path.join(buildDir, 'firestore.js'));
  assert.deepEqual(toFirestoreFields({
    targetId: undefined,
    nested: { optional: undefined, present: 'value' },
    rows: [{ optional: undefined, id: 'row-1' }],
  }), {
    nested: { mapValue: { fields: { present: { stringValue: 'value' } } } },
    rows: { arrayValue: { values: [{ mapValue: { fields: { id: { stringValue: 'row-1' } } } }] } },
  });
  assert.throws(() => toFirestoreFields({ values: ['valid', undefined] }), /cannot be undefined/i);
});

test('phone OTP endpoints are unavailable and never call MSG91', async () => {
  for (const pathname of ['/send-otp', '/verify-otp']) {
    const result = await worker.fetch(new Request(`https://worker.test${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+911234567890', otp: '1234' }),
    }), env);

    assert.equal(result.status, 410);
    assert.deepEqual(await result.json(), {
      error: 'Phone OTP sign-in is currently unavailable. Use Google or email and password.',
      code: 'PHONE_OTP_UNAVAILABLE',
    });
  }

  assert.equal(msg91Calls, 0);
  assert.equal(kvValues.size, 0);
});

test('shared Firebase authentication distinguishes dependency outages from configuration failures', async () => {
  seedManualOrder('auth-failure-confirm');
  seedManualOrder('auth-failure-reject');

  const cases = [
    ['/seller/products/delete', 'seller-token', { productId: 'product-1' }],
    ['/admin/manual-upi/orders/confirm-payment', 'admin-token', {
      orderId: 'auth-failure-confirm',
      customerUtr: 'merchant-credit-ref',
    }],
    ['/admin/manual-upi/orders/reject-payment', 'admin-token', {
      orderId: 'auth-failure-reject',
      reason: 'No matching merchant credit.',
    }],
  ];

  for (const [pathname, token, body] of cases) {
    failProfileReadStatus = 503;
    const result = await call(pathname, token, body);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'FIRESTORE_PROFILE_READ_FAILED');
  }

  failGoogleTokenExchangeStatus = 503;
  const tokenFailure = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(tokenFailure.status, 503);
  assert.equal(tokenFailure.body.code, 'FIREBASE_TOKEN_EXCHANGE_FAILED');

  failGoogleTokenExchangeStatus = 403;
  const rejectedServiceAccount = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(rejectedServiceAccount.status, 500);
  assert.equal(rejectedServiceAccount.body.code, 'FIREBASE_SERVICE_ACCOUNT_REJECTED');

  failProfileReadStatus = 403;
  const rejectedProfileRead = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(rejectedProfileRead.status, 500);
  assert.equal(rejectedProfileRead.body.code, 'FIRESTORE_PROFILE_ACCESS_CONFIG');

  assert.equal(records.has('products/product-1'), true);
  assert.equal(records.get('orders/auth-failure-confirm').data.paymentStatus, 'Pending');
  assert.equal(records.get('orders/auth-failure-reject').data.paymentStatus, 'Pending');
  assert.equal([...records.keys()].filter((key) => key.startsWith('audit_logs/')).length, 0);
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

test('manual UPI order creation rejects malformed customer details before writing', async () => {
  const invalidCases = [
    { customerName: '12345' },
    { customerPhone: '1234567890' },
    { customerPhone: '+911234567890' },
    { customerAddress: 'buyer@example.com' },
  ];

  for (const [index, overrides] of invalidCases.entries()) {
    const result = await call(
      '/manual-upi/orders/create',
      'customer-token',
      manualOrderRequest(`invalid-details-${index}-key`, overrides),
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INVALID_CUSTOMER_DETAILS');
  }
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

test('product deletion requires an authorized owner and queues verified images for cleanup', async () => {
  const forbidden = await call('/seller/products/delete', 'customer-token', { productId: 'product-1' });
  assert.equal(forbidden.status, 403);
  const anotherSeller = await call('/seller/products/delete', 'seller-2-token', { productId: 'product-1' });
  assert.equal(anotherSeller.status, 403);
  assert.equal(records.has('products/product-1'), true);

  const deleted = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(deleted.status, 200);
  assert.equal(records.has('products/product-1'), false);
  assert.equal(records.has('products/product-1/private/data'), false);
  assert.equal(deleted.body.cleanupPending, false);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), false);
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), false);
});

test('an administrator can delete a legacy product without an owner UID', async () => {
  seed('products/legacy-product', { name: 'Legacy', imagePublicIds: [] });
  const deleted = await call('/seller/products/delete', 'admin-token', { productId: 'legacy-product' });
  assert.equal(deleted.status, 200);
  assert.equal(records.has('products/legacy-product'), false);
});

test('legacy image IDs remain usable but cannot be deleted without trusted ownership', async () => {
  const legacyId = 'vibekart/products/legacy-product/old-image';
  seed('products/legacy-product', {
    name: 'Legacy',
    createdByUid: 'seller-1',
    imageUrls: [`https://res.cloudinary.com/vibekart-test/image/upload/${legacyId}`],
    imagePublicIds: [legacyId],
  });
  const retained = await call('/seller/products/images', 'seller-token', {
    productId: 'legacy-product',
    imageUrls: [`https://res.cloudinary.com/vibekart-test/image/upload/${legacyId}`],
    imagePublicIds: [legacyId],
  });
  assert.equal(retained.status, 200);
  const deleted = await call('/seller/products/delete', 'seller-token', { productId: 'legacy-product' });
  assert.equal(deleted.status, 409);
  assert.equal(records.has('products/legacy-product'), true);
  assert.equal(cloudinaryAssets.has(legacyId), false);
});

test('product deletion rejects a client-injected asset belonging to another target', async () => {
  const foreignId = 'vibekart/products/product-2/other-owner-image';
  seedCloudinaryAsset(foreignId, { targetId: 'product-2', ownerUid: 'seller-2' });
  seed('products/product-1', {
    ...records.get('products/product-1').data,
    imagePublicIds: [foreignId],
    imageUrls: [`https://res.cloudinary.com/vibekart-test/image/upload/${foreignId}`],
  });
  cloudinaryAssets.add(foreignId);
  const result = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(result.status, 409);
  assert.equal(records.has('products/product-1'), true);
  assert.equal(cloudinaryAssets.has(foreignId), true);
});

test('unauthorized callers cannot upload product images', async () => {
  const result = await callUpload('customer-token');
  assert.equal(result.status, 403);
  assert.equal([...records.keys()].filter((key) => key.startsWith('cloudinary_assets/')).length, 1);
});

test('upload body size is rejected before multipart parsing', async () => {
  const maxBody = 10 * 1024 * 1024 + 64 * 1024;
  const declaredOversize = await callRawUpload(
    'seller-token',
    new Uint8Array(),
    'multipart/form-data; boundary=x',
    maxBody + 1,
  );
  assert.equal(declaredOversize.status, 413);
  const actualOversize = await callRawUpload(
    'seller-token',
    new Uint8Array(maxBody + 1),
    'multipart/form-data; boundary=x',
  );
  assert.equal(actualOversize.status, 413);
  assert.equal(cloudinaryAssets.size, 1);
});

test('malformed multipart and missing file requests are rejected', async () => {
  const malformed = await callRawUpload('seller-token', 'not multipart', 'multipart/form-data; boundary=x');
  assert.equal(malformed.status, 400);

  const missingFile = await callUpload('seller-token', 'product', 'product-1', { includeFile: false });
  assert.equal(missingFile.status, 400);
});

test('image formats are detected from bytes, not the multipart MIME label', async () => {
  const fixtures = [
    { mime: 'image/png', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) },
    { mime: 'image/jpeg', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { mime: 'application/octet-stream', bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]) },
    { mime: 'image/jpeg', bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]) },
  ];
  for (const fixture of fixtures) {
    const result = await callUpload('seller-token', 'product', 'product-1', fixture);
    assert.equal(result.status, 201);
  }
});

test('spoofed MIME labels cannot make unsupported file bytes upload', async () => {
  const result = await callUpload('seller-token', 'product', 'product-1', {
    mime: 'image/jpeg',
    bytes: new TextEncoder().encode('<svg onload=alert(1)>'),
  });
  assert.equal(result.status, 415);
  assert.equal(cloudinaryAssets.size, 1);
});

test('Cloudinary uploads are throttled by authenticated account using shared KV', async () => {
  kvValues.set('ratelimit:cloudinary:seller-1', '30');
  const result = await callUpload('seller-token');
  assert.equal(result.status, 429);
  assert.equal(cloudinaryAssets.size, 1);
});

test('missing Cloudinary bindings return an actionable error without exposing values', async () => {
  const secret = env.CLOUDINARY_API_SECRET;
  env.CLOUDINARY_API_SECRET = undefined;
  try {
    const result = await callUpload('seller-token');
    assert.equal(result.status, 503);
    assert.match(result.body.error, /CLOUDINARY_CLOUD_NAME.*CLOUDINARY_API_KEY.*CLOUDINARY_API_SECRET/);
    assert.equal(JSON.stringify(result.body).includes('test-api-key'), false);
    assert.equal(JSON.stringify(result.body).includes('test-api-secret'), false);
  } finally {
    env.CLOUDINARY_API_SECRET = secret;
  }
});

test('an uploaded image with failed ownership finalization is durably queued and cleaned on retry', async () => {
  failCommitAfterCloudinaryUpload = true;
  const upload = await callUpload('seller-token');
  assert.equal(upload.status, 502);
  assert.match(upload.body.error, /cleanup is queued/i);

  const job = records.get('cloudinary_cleanup_jobs/product-product-1');
  assert.ok(job);
  assert.equal(job.data.publicIds.length, 1);
  const [publicId] = job.data.publicIds;
  assert.equal(cloudinaryAssets.has(publicId), true);
  assert.equal(records.get(cloudinaryAssetRecordPath(publicId)).data.status, 'cleanup_pending');

  const retry = await call('/cloudinary/cleanup', 'seller-token', {
    assetType: 'product',
    targetId: 'product-1',
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.cleanupPending, false);
  assert.equal(cloudinaryAssets.has(publicId), false);
  assert.equal(records.has(cloudinaryAssetRecordPath(publicId)), false);
});

test('a product metadata-write failure queues and cleans a successfully uploaded unreferenced image', async () => {
  const upload = await callUpload('seller-token');
  assert.equal(upload.status, 201);
  const publicId = upload.body.publicId;
  const oldId = 'vibekart/products/product-1/test-image';
  failNextCommitStatus = 409;
  const save = await call('/seller/products/images', 'seller-token', {
    productId: 'product-1',
    imageUrls: [
      `https://res.cloudinary.com/vibekart-test/image/upload/${oldId}`,
      upload.body.url,
    ],
    imagePublicIds: [oldId, publicId],
  });
  assert.equal(save.status, 409);
  assert.match(save.body.error, /queued for cleanup retry/i);
  assert.deepEqual(records.get('products/product-1').data.imagePublicIds, [oldId]);
  assert.equal(cloudinaryAssets.has(publicId), true);
  assert.equal(cloudinaryAssets.has(oldId), true);
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), true);
  const cleanup = await call('/cloudinary/cleanup', 'seller-token', {
    assetType: 'product',
    targetId: 'product-1',
    publicIds: [publicId],
  });
  assert.equal(cleanup.status, 200);
  assert.equal(cleanup.body.cleanupPending, false);
  assert.equal(cloudinaryAssets.has(publicId), false);
});

test('product image editing atomically detaches and cleans removed images', async () => {
  const result = await call('/seller/products/images', 'seller-token', {
    productId: 'product-1',
    imageUrls: [],
    imagePublicIds: [],
    removedPublicIds: ['vibekart/products/product-1/test-image'],
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.cleanupPending, false);
  assert.deepEqual(records.get('products/product-1').data.imagePublicIds, []);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), false);
});

test('product image updates reject foreign ownership IDs and preserve both assets', async () => {
  const foreignId = 'vibekart/products/product-2/other-owner-image';
  seedCloudinaryAsset(foreignId, { targetId: 'product-2', ownerUid: 'seller-2' });
  cloudinaryAssets.add(foreignId);
  const result = await call('/seller/products/images', 'seller-token', {
    productId: 'product-1',
    imageUrls: [`https://res.cloudinary.com/vibekart-test/image/upload/${foreignId}`],
    imagePublicIds: [foreignId],
  });
  assert.equal(result.status, 409);
  assert.deepEqual(records.get('products/product-1').data.imagePublicIds, ['vibekart/products/product-1/test-image']);
  assert.equal(cloudinaryAssets.has(foreignId), true);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), true);
});

test('concurrent product changes prevent stale image cleanup from deleting a referenced image', async () => {
  mutateProductBeforeNextImageCommit = true;
  const result = await call('/seller/products/images', 'seller-token', {
    productId: 'product-1',
    imageUrls: [],
    imagePublicIds: [],
    removedPublicIds: ['vibekart/products/product-1/test-image'],
  });
  assert.equal(result.status, 409);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), true);
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), false);
});

test('partial Cloudinary deletion stays queued and succeeds on retry', async () => {
  cloudinaryPartialFailureFor = 'vibekart/products/product-1/test-image';
  const deleted = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.cleanupPending, true);
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), true);
  assert.equal(records.has(cloudinaryAssetRecordPath('vibekart/products/product-1/test-image')), true);
  cloudinaryPartialFailureFor = null;
  const retry = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.cleanupPending, false);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), false);
});

test('payment QR replacement and clearing queue cleanup for the previous owned image', async () => {
  const oldId = 'vibekart/payment/old-qr';
  const newId = 'vibekart/payment/new-qr';
  seed('settings/payment', {
    enabled: true,
    merchantVpa: 'vibekart@upi',
    qrImageUrl: `https://res.cloudinary.com/vibekart-test/image/upload/${oldId}`,
    qrImagePublicId: oldId,
  });
  seedCloudinaryAsset(oldId, {
    assetType: 'payment-qr',
    targetId: 'settings/payment',
    ownerUid: 'admin-1',
  });
  seedCloudinaryAsset(newId, {
    assetType: 'payment-qr',
    targetId: 'settings/payment',
    ownerUid: 'admin-1',
    status: 'uploaded',
  });
  cloudinaryAssets.add(oldId);
  cloudinaryAssets.add(newId);

  const replace = await call('/admin/payment-settings/qr-image', 'admin-token', {
    imageUrl: `https://res.cloudinary.com/vibekart-test/image/upload/${newId}`,
    imagePublicId: newId,
  });
  assert.equal(replace.status, 200);
  assert.equal(records.get('settings/payment').data.qrImagePublicId, newId);
  assert.equal(cloudinaryAssets.has(oldId), false);

  const clear = await call('/admin/payment-settings/qr-image', 'admin-token', {
    imageUrl: '',
    imagePublicId: '',
  });
  assert.equal(clear.status, 200);
  assert.equal(records.get('settings/payment').data.qrImagePublicId, '');
  assert.equal(cloudinaryAssets.has(newId), false);
});

test('missing Cloudinary credentials leave deletion durable and report cleanup pending', async () => {
  const secret = env.CLOUDINARY_API_SECRET;
  env.CLOUDINARY_API_SECRET = undefined;
  try {
    const result = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
    assert.equal(result.status, 200);
    assert.equal(result.body.cleanupPending, true);
    assert.equal(records.has('products/product-1'), false);
    assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), true);
  } finally {
    env.CLOUDINARY_API_SECRET = secret;
  }
});

test('failed image deletion leaves a durable cleanup job for retry', async () => {
  cloudinaryStatus = 503;
  const failed = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.cleanupPending, true);
  assert.equal(records.has('products/product-1'), false);
  assert.equal(records.has('products/product-1/private/data'), false);
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), true);

  cloudinaryStatus = 200;
  const retry = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.cleanupPending, false);
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), false);
});

test('scheduled cleanup retries pending Cloudinary deletion jobs', async () => {
  cloudinaryStatus = 503;
  const deleted = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.cleanupPending, true);

  cloudinaryStatus = 200;
  let scheduledTask;
  await worker.scheduled({}, env, { waitUntil(task) { scheduledTask = task; } });
  await scheduledTask;
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), false);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), false);
});

test('concurrent cleanup-job additions are preserved and cleaned on a later retry', async () => {
  appendCleanupDuringDeleteId = 'vibekart/products/product-1/concurrent-image';
  const deleted = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.cleanupPending, true);
  const job = records.get('cloudinary_cleanup_jobs/product-product-1');
  assert.deepEqual(job.data.publicIds, [
    'vibekart/products/product-1/test-image',
    'vibekart/products/product-1/concurrent-image',
  ]);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/concurrent-image'), true);

  const retry = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.cleanupPending, false);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/concurrent-image'), false);
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), false);
});

test('failed cleanup-job persistence is reported and stale uncertain uploads are recovered', async () => {
  failCloudinaryUploadRequest = true;
  const upload = await callUpload('seller-token');
  assert.equal(upload.status, 502);
  assert.match(upload.body.error, /cleanup could not be recorded/i);
  const staleAssetEntry = [...records.entries()].find(([key, value]) =>
    key.startsWith('cloudinary_assets/') && value.data.status === 'uploading');
  assert.ok(staleAssetEntry);
  const [staleAssetPath, staleAsset] = staleAssetEntry;
  const publicId = staleAsset.data.publicId;
  seed(staleAssetPath, {
    ...staleAsset.data,
    createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });
  assert.equal(cloudinaryAssets.has(publicId), true);

  let scheduledTask;
  await worker.scheduled({}, env, { waitUntil(task) { scheduledTask = task; } });
  await scheduledTask;
  assert.equal(cloudinaryAssets.has(publicId), false);
  assert.equal(records.has(staleAssetPath), false);
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), false);
});

test('stale-upload recovery will not delete an asset referenced by product metadata', async () => {
  const publicId = 'vibekart/products/product-1/referenced-stale-upload';
  seed('products/product-1', {
    ...records.get('products/product-1').data,
    imagePublicIds: [publicId],
    imageUrls: [`https://res.cloudinary.com/vibekart-test/image/upload/${publicId}`],
  });
  const assetPath = cloudinaryAssetRecordPath(publicId);
  seedCloudinaryAsset(publicId, {
    status: 'uploading',
    createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });
  cloudinaryAssets.add(publicId);

  let scheduledTask;
  await worker.scheduled({}, env, { waitUntil(task) { scheduledTask = task; } });
  await scheduledTask;
  assert.equal(cloudinaryAssets.has(publicId), true);
  assert.equal(records.get(assetPath).data.status, 'uploading');
  assert.equal(records.has('cloudinary_cleanup_jobs/product-product-1'), false);
});

test('failed atomic product deletion does not delete or queue the referenced image', async () => {
  failNextCommitStatus = 409;
  const failed = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /changed/i);
  assert.equal(records.has('products/product-1'), true);
  assert.equal(records.has('products/product-1/private/data'), true);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), true);

  const retry = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });
  assert.equal(retry.status, 200);
  assert.equal(records.has('products/product-1'), false);
});

test('product deletion reports a Firestore outage without deleting the product or its image', async () => {
  failNextCommitStatus = 503;
  const result = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });

  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'FIRESTORE_WRITE_UNAVAILABLE');
  assert.equal(records.has('products/product-1'), true);
  assert.equal(records.has('products/product-1/private/data'), true);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), true);
});

test('product deletion reports a rejected Firestore write as a configuration failure', async () => {
  failNextCommitStatus = 403;
  const result = await call('/seller/products/delete', 'seller-token', { productId: 'product-1' });

  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'FIRESTORE_WRITE_REJECTED');
  assert.equal(records.has('products/product-1'), true);
  assert.equal(cloudinaryAssets.has('vibekart/products/product-1/test-image'), true);
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
  const paymentAudits = [...records.entries()].filter(([key, value]) =>
    key.startsWith('audit_logs/') && value.data.paymentReviewTargetType === 'payment_attempt');
  assert.equal(paymentAudits.length, 1);
  assert.equal(paymentAudits[0][1].data.action, 'Confirm Payment Attempt');
  assert.equal(paymentAudits[0][1].data.paymentReviewAction, 'Confirmed');
  assert.equal(paymentAudits[0][1].data.targetId, attemptId);
  const sharedClaim = `payment_reference_claims/ref-${encodeURIComponent('REFERENCE-ABC')}`;
  assert.equal(records.get(sharedClaim).data.orderId, confirmed.body.orderId);
  assert.equal([...records.keys()].filter((key) => key.startsWith('orders/') && !key.includes('/private/')).length, 1);
});

test('payment attempt review audit is atomic with confirmation', async () => {
  const created = await createAttempt('atomic-review-audit');
  const attemptId = created.body.attempt.id;
  await call('/payment-attempts/submit', 'customer-token', {
    attemptId,
    customerUtr: 'atomic-review-reference',
  });
  failNextCommitStatus = 503;
  const failed = await call('/admin/payment-attempts/confirm', 'admin-token', {
    attemptId,
    actualCreditConfirmed: true,
  });
  assert.equal(failed.status, 409);
  assert.equal(records.get(`payment_attempts/${attemptId}`).data.status, 'Submitted');
  assert.equal(records.has(`orders/ord-${attemptId.slice(4)}`), false);
  assert.equal([...records.entries()].some(([key, value]) =>
    key.startsWith('audit_logs/') && value.data.targetId === attemptId), false);
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
  const audits = [...records.entries()].filter(([key, value]) =>
    key.startsWith('audit_logs/') && value.data.paymentReviewTargetType === 'payment_attempt');
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1].data.paymentReviewAction, 'Expired');
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
  const audits = [...records.entries()].filter(([key, value]) =>
    key.startsWith('audit_logs/') && value.data.paymentReviewTargetType === 'payment_attempt');
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1].data.paymentReviewAction, 'Rejected');
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

test('manual UPI confirmation reports Firestore outages without changing payment state', async () => {
  seedManualOrder('manual-confirm-firestore-outage');
  failNextCommitStatus = 503;

  const result = await call('/admin/manual-upi/orders/confirm-payment', 'admin-token', {
    orderId: 'manual-confirm-firestore-outage',
    customerUtr: 'merchant-credit-ref',
  });

  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'FIRESTORE_WRITE_UNAVAILABLE');
  assert.equal(records.get('orders/manual-confirm-firestore-outage').data.paymentStatus, 'Pending');
  assert.equal([...records.keys()].some((key) => key.startsWith('payment_reference_claims/')), false);
  assert.equal([...records.keys()].filter((key) => key.startsWith('audit_logs/')).length, 0);
});

test('manual UPI rejection reports Firestore outages without changing payment state', async () => {
  seedManualOrder('manual-reject-firestore-outage');
  failNextCommitStatus = 503;

  const result = await call('/admin/manual-upi/orders/reject-payment', 'admin-token', {
    orderId: 'manual-reject-firestore-outage',
    reason: 'No matching merchant credit.',
  });

  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'FIRESTORE_WRITE_UNAVAILABLE');
  assert.equal(records.get('orders/manual-reject-firestore-outage').data.paymentStatus, 'Pending');
  assert.equal([...records.keys()].filter((key) => key.startsWith('audit_logs/')).length, 0);
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
