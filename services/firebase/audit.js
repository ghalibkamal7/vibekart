function sanitizeAuditLogPayload(log) {
  const next = { ...log };
  if (next.targetId === undefined) {
    delete next.targetId;
  }
  return next;
}

module.exports = { sanitizeAuditLogPayload };
