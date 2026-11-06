// Payment gateway adapter. Razorpay is the real provider. The "mock" provider exists ONLY for local development and
// automated tests (refused in production by config.js); it signs payments with the same HMAC scheme so the real
// verification code path is exercised.
const crypto = require('crypto');
const config = require('../../config');
const { HttpError } = require('../../utils/errors');

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8'); const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const MOCK_SECRET = () => config.payment.keySecret || 'mock-dev-secret';

const razorpay = {
  name: 'razorpay',
  configured: () => !!(config.payment.keyId && config.payment.keySecret),
  publicKey: () => config.payment.keyId,
  async api(method, path, body) {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${config.payment.keyId}:${config.payment.keySecret}`).toString('base64')}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[payments] razorpay error', res.status, data && data.error && data.error.description);
      throw new HttpError(502, 'The payment provider could not process this request. Please try again.');
    }
    return data;
  },
  createOrder({ amountPaise, currency, receipt, notes }) { return this.api('POST', '/orders', { amount: amountPaise, currency, receipt, notes }); },
  fetchPayment(id) { return this.api('GET', `/payments/${encodeURIComponent(id)}`); },
  verifyPaymentSignature({ orderId, paymentId, signature }) { return safeEqual(hmac(config.payment.keySecret, `${orderId}|${paymentId}`), signature); },
  verifyWebhookSignature(rawBody, signature) { return !!config.payment.webhookSecret && safeEqual(hmac(config.payment.webhookSecret, rawBody), signature); },
};

const mock = {
  name: 'mock',
  configured: () => true,
  publicKey: () => 'mock_key',
  async createOrder({ amountPaise, currency }) { return { id: `order_mock_${crypto.randomBytes(8).toString('hex')}`, amount: amountPaise, currency, status: 'created' }; },
  // In mock mode there is no remote record to cross-check; the signature check is the gate.
  async fetchPayment() { return null; },
  verifyPaymentSignature({ orderId, paymentId, signature }) { return safeEqual(hmac(MOCK_SECRET(), `${orderId}|${paymentId}`), signature); },
  verifyWebhookSignature(rawBody, signature) { return safeEqual(hmac(config.payment.webhookSecret || 'mock-webhook-secret', rawBody), signature); },
  /** Dev/test only: produce what the checkout widget would return after a successful payment. */
  simulatePayment(orderId) { const paymentId = `pay_mock_${crypto.randomBytes(8).toString('hex')}`; return { orderId, paymentId, signature: hmac(MOCK_SECRET(), `${orderId}|${paymentId}`) }; },
  signWebhook(rawBody) { return hmac(config.payment.webhookSecret || 'mock-webhook-secret', rawBody); },
};

const none = { name: 'none', configured: () => false, publicKey: () => null };

function getGateway() {
  if (config.payment.provider === 'razorpay') return razorpay;
  if (config.payment.provider === 'mock' && !config.isProd) return mock;
  return none;
}

module.exports = { getGateway, hmac };
