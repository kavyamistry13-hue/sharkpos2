// Append-only audit trail. Never throws: a logging failure must not break the action being logged.
const { sysQuery } = require('../db');

async function audit(req, action, { entityType = null, entityId = null, summary = null, oldValue = null, newValue = null, businessId, accountId, actorName } = {}) {
  try {
    const u = (req && req.user) || {};
    await sysQuery(
      `INSERT INTO audit_logs (business_id, account_id, actor_name, action, entity_type, entity_id, summary, old_value, new_value, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        businessId ?? u.businessId ?? null, accountId ?? u.id ?? null, actorName ?? u.name ?? null, action, entityType,
        entityId == null ? null : String(entityId), summary ? String(summary).slice(0, 300) : null,
        oldValue == null ? null : JSON.stringify(oldValue), newValue == null ? null : JSON.stringify(newValue),
        req && req.ip ? String(req.ip).slice(0, 64) : null,
      ],
    );
  } catch (err) {
    console.error('[audit] failed to write', action, err.message);
  }
}

module.exports = { audit };
