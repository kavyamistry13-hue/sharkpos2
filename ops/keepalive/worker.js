// OPTIONAL. Cloudflare Worker with a Cron Trigger (free: up to 5 per account). Pings the API's cheap liveness probe every 10 minutes
// during shop hours so Render's free instance (which sleeps after 15 idle minutes) is awake when the shop is open.
// /api/health/live never touches the database, so Neon can still sleep between sales.
export default {
  async scheduled(_event, env) {
    try { await fetch(`${env.API_ORIGIN}/api/health/live`, { cf: { cacheTtl: 0 } }); } catch { /* the next ping will try again */ }
  },
};
