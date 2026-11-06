const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const config = require('../config');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncH = require('../utils/async');
const { HttpError } = require('../utils/errors');
const svc = require('../services/authService');
const { sysQuery } = require('../db');

const router = express.Router();
const limiter = (limit, windowMin, message) => rateLimit({ windowMs: windowMin * 60 * 1000, limit: config.isTest ? 10000 : limit, standardHeaders: true, legacyHeaders: false, message: { error: message } });
const loginLimiter = limiter(30, 15, 'Too many login attempts. Please wait a few minutes and try again.');
const registerLimiter = limiter(10, 60, 'Too many sign-ups from this network. Please try again later.');

const COOKIE = 'sp2_refresh';
const cookieOpts = () => ({ httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/api/auth', domain: config.cookieDomain });
const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
};
const setCookie = (res, token) => {
  const o = cookieOpts();
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, `Path=${o.path}`, 'HttpOnly', `SameSite=Strict`, `Max-Age=${config.refreshDays * 86400}`];
  if (o.secure) parts.push('Secure');
  if (o.domain) parts.push(`Domain=${o.domain}`);
  res.append('Set-Cookie', parts.join('; '));
};
const clearCookie = (res) => res.append('Set-Cookie', `${COOKIE}=; Path=${cookieOpts().path}; HttpOnly; SameSite=Strict; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`);
// The refresh cookie is SameSite=Strict; requiring a custom header as well blocks cross-site form posts (CSRF defence in depth).
const csrfHeader = (req, _res, next) => (req.headers['x-requested-with'] === 'sharkpos' ? next() : next(new HttpError(403, 'Request blocked.')));

const respond = (res, s, status = 200) => { setCookie(res, s.refreshToken); res.status(status).json({ accessToken: s.accessToken, user: s.user, ...(s.business ? { business: s.business } : {}) }); };

const password = z.string().min(8, 'Use at least 8 characters.').max(100).refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'Use letters and numbers.');
const phone = z.string().trim().regex(/^[0-9+\-\s]{7,15}$/, 'Enter a valid phone number.');

router.post('/register', registerLimiter, validate({ body: z.object({
  businessName: z.string().trim().min(2, 'Enter your business name.').max(120),
  ownerName: z.string().trim().min(2, 'Enter your name.').max(120),
  email: z.string().trim().email('Enter a valid email.').max(190),
  phone: phone.optional(),
  address: z.string().trim().max(300).optional(),
  password,
  plan: z.string().trim().max(30).optional(),
}) }), asyncH(async (req, res) => respond(res, await svc.register(req.body, req), 201)));

router.post('/login', loginLimiter, validate({ body: z.object({ email: z.string().trim().email().max(190), password: z.string().min(1).max(200), businessId: z.number().int().positive().optional() }) }), asyncH(async (req, res) => {
  const r = await svc.login(req.body, req);
  if (r.needsBusiness) return res.json({ needsBusiness: true, businesses: r.businesses });
  return respond(res, r);
}));

router.post('/refresh', csrfHeader, asyncH(async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (!token) throw new HttpError(401, 'Session expired. Please sign in again.');
  try { respond(res, await svc.refresh(token, req)); } catch (e) { clearCookie(res); throw e; }
}));

router.post('/logout', csrfHeader, asyncH(async (req, res) => { await svc.logout(readCookie(req, COOKIE), req); clearCookie(res); res.json({ ok: true }); }));

router.get('/me', authenticate, asyncH(async (req, res) => {
  const u = req.user;
  res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, businessId: u.businessId, businessName: u.businessName || null } });
}));

router.post('/change-password', authenticate, validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: password }) }), asyncH(async (req, res) => {
  await svc.changePassword(req, req.body.currentPassword, req.body.newPassword);
  clearCookie(res);
  res.json({ ok: true, signedOut: true });
}));

module.exports = router;
