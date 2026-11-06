const crypto = require('crypto');
const net = require('net');
const config = require('../config');

// The web app (Cloudflare Pages) forwards /api to this server. From our point of view every visitor then comes from Cloudflare,
// which would put all users in one rate-limit bucket. The proxy therefore sends the real visitor IP in `x-sp-client-ip`,
// proven genuine by `x-sp-proxy-secret`. Without the right secret the headers are ignored (anyone can send headers).
const expected = config.proxySecret ? Buffer.from(config.proxySecret) : null;

module.exports = function proxyIp(req, _res, next) {
  const got = req.headers['x-sp-proxy-secret'];
  if (expected && typeof got === 'string') {
    const g = Buffer.from(got);
    const ip = req.headers['x-sp-client-ip'];
    if (g.length === expected.length && crypto.timingSafeEqual(g, expected) && typeof ip === 'string' && net.isIP(ip.trim())) {
      Object.defineProperty(req, 'ip', { value: ip.trim(), configurable: true });
    }
  }
  next();
};
