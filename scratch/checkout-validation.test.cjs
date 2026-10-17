const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const root = path.resolve(__dirname, '..');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibekart-checkout-tests-'));
execFileSync(path.join(root, 'node_modules/.bin/tsc'), [
  path.join(root, 'data/checkout-validation.ts'),
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--strict',
  '--skipLibCheck',
  '--ignoreConfig',
  '--outDir', buildDir,
], { cwd: root, stdio: 'inherit' });
const validation = require(path.join(buildDir, 'checkout-validation.js'));

after(() => fs.rmSync(buildDir, { recursive: true, force: true }));

test('UPI payment URI encodes configured merchant and current INR amount', () => {
  const uri = validation.buildUpiPaymentUri('wwwsneha765-1@oksbi', 'Vibe & Kart/India', 125.5);
  const parsed = new URL(uri);

  assert.equal(parsed.protocol, 'upi:');
  assert.equal(parsed.hostname, 'pay');
  assert.equal(parsed.searchParams.get('pa'), 'wwwsneha765-1@oksbi');
  assert.equal(parsed.searchParams.get('pn'), 'Vibe & Kart/India');
  assert.equal(parsed.searchParams.get('cu'), 'INR');
  assert.equal(parsed.searchParams.get('am'), '125.50');
  assert.equal(validation.buildUpiPaymentUri('merchant@upi', 'Shop', 0), '');
  assert.equal(validation.buildUpiPaymentUri('merchant@upi', 'Shop', Number.NaN), '');
});

test('checkout validates full name, Indian mobile, and delivery address', () => {
  assert.equal(validation.validateCheckoutName('Sneha Sharma'), null);
  assert.equal(validation.validateCheckoutName('Aarav O’Neil'), null);
  assert.ok(validation.validateCheckoutName('12345'));
  assert.ok(validation.validateCheckoutName(''));

  assert.equal(validation.normalizeIndianMobile('+91 98765 43210'), '+919876543210');
  assert.equal(validation.normalizeIndianMobile('09876543210'), '+919876543210');
  assert.equal(validation.normalizeIndianMobile('9876543210'), '+919876543210');
  assert.equal(validation.normalizeIndianMobile('1234567890'), null);
  assert.equal(validation.normalizeIndianMobile('++91 98765 43210'), null);

  assert.equal(validation.validateCheckoutAddress('Flat 4, Green Street'), null);
  assert.ok(validation.validateCheckoutAddress('buyer@example.com'));
  assert.ok(validation.validateCheckoutAddress('   '));

  assert.deepEqual(validation.validateCheckoutDetails({
    name: '12345',
    phone: '1234567890',
    address: 'buyer@example.com',
  }), {
    name: 'Enter a valid name using letters only.',
    phone: 'Enter a valid 10-digit Indian mobile number.',
    address: 'Enter a complete delivery address with locality or city.',
  });
});

test('product-request checkout validates each required delivery field and rejects malformed autofill', () => {
  const valid = {
    name: 'Sneha Sharma',
    phone: '+91 98765 43210',
    address: {
      houseDetails: 'Flat 12B',
      roadArea: 'Green Street',
      pincode: '560001',
      city: 'Bengaluru',
      state: 'Karnataka',
    },
  };
  assert.deepEqual(validation.validateProductRequestDetails(valid), {});
  assert.deepEqual(
    validation.validateProductRequestDetails({
      ...valid,
      name: 'm, ,',
      address: { ...valid.address, houseDetails: 'm, ,', pincode: '56001', city: '1' },
    }),
    {
      name: 'Enter a valid name using letters only.',
      houseDetails: 'Enter valid house or building details.',
      pincode: 'Enter a valid six-digit pincode.',
      city: 'Enter a valid city.',
    },
  );
});
