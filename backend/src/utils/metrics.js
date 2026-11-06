// In-memory counters for the platform admin "ops" view. Per instance, reset on restart — logs are the durable record.
const started = Date.now();
const counters = { requests: 0, status5xx: 0, status4xx: 0, dbErrors: 0, authFailures: 0, paymentFailures: 0 };
const recent = []; // last N response times (ms)
const MAX = 1000;

const count = (k) => { counters[k] += 1; };
function recordRequest(status, ms) {
  counters.requests += 1;
  if (status >= 500) counters.status5xx += 1; else if (status >= 400) counters.status4xx += 1;
  recent.push(ms);
  if (recent.length > MAX) recent.shift();
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
function snapshot() {
  const s = [...recent].sort((a, b) => a - b);
  return { uptimeSeconds: Math.round((Date.now() - started) / 1000), ...counters, responseMs: { samples: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.length ? s[s.length - 1] : null } };
}
module.exports = { count, recordRequest, snapshot };
