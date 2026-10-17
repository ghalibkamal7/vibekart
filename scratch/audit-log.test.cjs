const assert = require('node:assert/strict');
const { test } = require('node:test');

test('audit log sanitization omits undefined targetId and preserves valid target references', () => {
  const { sanitizeAuditLogPayload } = require('../services/firebase/audit.js');

  const withoutTarget = sanitizeAuditLogPayload({
    adminEmail: 'admin@vibekart.in',
    adminUid: 'admin-1',
    action: 'Review payment',
    details: 'The audit log should omit an undefined targetId.',
  });

  assert.deepEqual(withoutTarget, {
    adminEmail: 'admin@vibekart.in',
    adminUid: 'admin-1',
    action: 'Review payment',
    details: 'The audit log should omit an undefined targetId.',
  });

  const withTarget = sanitizeAuditLogPayload({
    adminEmail: 'admin@vibekart.in',
    adminUid: 'admin-1',
    action: 'Review payment',
    details: 'The payment was verified against the merchant account.',
    targetId: 'manual-order-42',
  });

  assert.equal(withTarget.targetId, 'manual-order-42');
  assert.equal(Object.prototype.hasOwnProperty.call(withTarget, 'targetId'), true);
});

test('audit log sanitization removes undefined values at every object depth', () => {
  const { sanitizeAuditLogPayload } = require('../services/firebase/audit.js');
  const sanitized = sanitizeAuditLogPayload({
    action: 'Review payment',
    targetId: undefined,
    metadata: {
      orderId: 'order-1',
      optional: undefined,
      details: { reason: undefined, source: 'admin-panel' },
    },
    changes: [undefined, { previousValue: undefined, nextValue: 'Paid' }],
  });

  assert.deepEqual(sanitized, {
    action: 'Review payment',
    metadata: {
      orderId: 'order-1',
      details: { source: 'admin-panel' },
    },
    changes: [null, { nextValue: 'Paid' }],
  });
});
