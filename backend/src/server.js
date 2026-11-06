const config = require('./config');
const { pool } = require('./db');
const logger = require('./utils/logger');
const { createApp } = require('./app');

const app = createApp();
const server = app.listen(config.port, () => logger.info('startup', { port: config.port, env: config.isProd ? 'production' : 'development', db: config.dbName, version: config.version }) || (!config.isProd && console.log(`SHARKPOS 2 API listening on http://localhost:${config.port}`)));

// Render sends SIGTERM on every deploy: stop taking requests, let in-flight ones finish, close the pool.
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  setTimeout(() => process.exit(1), 10000).unref();
  server.close(() => pool.end().then(() => process.exit(0), () => process.exit(1)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => logger.error('api_error', { where: 'unhandledRejection', message: String(e && e.message || e) }));
process.on('uncaughtException', (e) => { logger.error('api_error', { where: 'uncaughtException', message: e.message, stack: String(e.stack || '').split('\n').slice(0, 6).join(' | ') }); shutdown(); });
