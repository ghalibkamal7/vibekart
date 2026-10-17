const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = path.resolve(__dirname, '..');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibekart-customer-order-tests-'));
execFileSync(path.join(root, 'node_modules/.bin/tsc'), [
  path.join(root, 'data/customer-order-presentation.ts'),
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--strict',
  '--skipLibCheck',
  '--ignoreConfig',
  '--outDir', buildDir,
], { cwd: root, stdio: 'inherit' });
const presentation = require(path.join(buildDir, 'customer-order-presentation.js'));

after(() => fs.rmSync(buildDir, { recursive: true, force: true }));

test('customer request statuses use neutral labels without changing internal status values', () => {
  assert.equal(presentation.getCustomerOrderStatusLabel('New'), 'Request received');
  assert.equal(presentation.getCustomerOrderStatusLabel('Ordered on Meesho'), 'Processing');
  assert.equal(presentation.getCustomerOrderStatusLabel('Shipped'), 'Shipped');
  assert.equal(presentation.getCustomerOrderStatusLabel('Delivered'), 'Delivered');
  assert.equal(presentation.getCustomerOrderStatusLabel('Cancelled'), 'Cancelled');
});

test('customer request confirmation and orders description use approved neutral copy', () => {
  assert.equal(presentation.PRODUCT_REQUEST_RECEIVED_TITLE, 'Request received');
  assert.equal(
    presentation.PRODUCT_REQUEST_RECEIVED_MESSAGE,
    'Your product request has been submitted successfully. We will contact you using the mobile number provided. Your request is currently being reviewed.',
  );
  assert.equal(
    presentation.PRODUCT_REQUEST_STATUS_DESCRIPTION,
    'This is a product request only. Your request is being reviewed. No payment has been taken.',
  );
});
