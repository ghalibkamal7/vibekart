function omitUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : omitUndefined(item));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefined(item)]),
  );
}

function sanitizeAuditLogPayload(log) {
  return omitUndefined(log);
}

module.exports = { sanitizeAuditLogPayload };
