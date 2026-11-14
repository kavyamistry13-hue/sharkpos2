// Deterministic billing engine. The implementation lives in ONE shared file (shared/billing.mjs) so the API and the offline POS can never disagree.
// Node 22.12+ can require() an ES module; the Dockerfile copies ./shared next to ./backend.
const { computeBill } = require('../../../shared/billing.mjs');

module.exports = { computeBill };
