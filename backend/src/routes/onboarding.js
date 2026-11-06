const express = require('express');
const { authorize } = require('../middleware/auth');
const asyncH = require('../utils/async');
const svc = require('../services/onboarding');

const router = express.Router();
router.get('/', authorize('business_owner', 'manager'), asyncH(async (req, res) => res.json(await svc.getOnboarding(req.user.businessId))));
router.post('/dismiss', authorize('business_owner'), asyncH(async (_req, res) => { await svc.dismiss(); res.json({ ok: true }); }));
module.exports = router;
