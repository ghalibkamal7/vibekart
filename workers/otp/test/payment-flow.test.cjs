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

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = {
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    project_id: 'vibekart-test',
    client_email: 'worker-test@example.iam.gserviceaccount.com',
    private_key: privateKey,
  }),
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
  seed('users/customer-1', { uid: 'customer-1', role: 'customer', status: 'active', phone: '+911234567890' });
  seed('users/admin-1', { uid: 'admin-1', role: 'admin', status: 'active' });
  seed('users/seller-1', { uid: 'seller-1', role: 'seller', status: 'active' });
  seed('users/suspended-admin', { uid: 'suspended-admin', role: 'admin', status: 'suspended' });
  seed('products/product-1', { name: 'Test Lamp', price: 1250, inStock: true, enabled: true });
  seed('products/product-1/private/data', { baseCost: 700, sourceUrl: 'https://supplier.invalid/item' });
}

async function mockedFetch(input, init = {}) {
  const url = new URL(input);
  if (url.hostname === 'oauth2.googleapis.com') {
    return response({ access_token: 'test-access-token' });
  }
  if (url.hostname === 'identitytoolkit.googleapis.com') {
    const requestBody = JSON.parse(init.body || '{}');
    const users = {
      'customer-token': { localId: 'customer-1', email: 'buyer@example.test' },
      'admin-token': { localId: 'admin-1', email: 'admin@example.test' },
      'seller-token': { localId: 'seller-1', email: 'seller@example.test' },
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
    const resolved = writes.map((write) => ({
      write,
      path: documentPathFromName(write.update.name),
      current: records.get(documentPathFromName(write.update.name)),
    }));
    for (const { write, current } of resolved) {
      const precondition = write.currentDocument;
      if (precondition?.exists === false && current) return response({ error: 'already exists' }, 409);
      if (precondition?.exists === true && !current) return response({ error: 'missing document' }, 404);
      if (precondition?.updateTime && current?.updateTime !== precondition.updateTime) {
        return response({ error: 'document changed' }, 409);
      }
    }
    for (const { write, path: documentPath, current } of resolved) {
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
  const created = await createAttempt('checkout-request-003');
  const attemptId = created.body.attempt.id;
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
  assert.equal(records.get(`payment_attempts/${attemptId}`).data.status, 'Paid');
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
  assert.deepEqual(records.get('orders/existing-paid').data, original);
});

test('preflight permits the authenticated cross-origin Worker requests', async () => {
  const result = await worker.fetch(new Request('https://worker.test/payment-attempts/submit', {
    method: 'OPTIONS',
    headers: { Origin: 'https://vibekart-f27b5.web.app' },
  }), env);
  assert.equal(result.status, 204);
  assert.match(result.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(result.headers.get('Access-Control-Allow-Methods'), /POST/);
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
