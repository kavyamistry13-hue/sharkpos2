// Unit tests for the deterministic engines. No database or network needed.
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBill } = require('../src/services/billing');
const { forecastFromSeries } = require('../src/services/forecast');
const { scoreSale, severityFor } = require('../src/services/risk');

const line = (id, qty, rupees, taxRate = 5) => ({ productId: id, name: `P${id}`, quantity: qty, unitPaise: Math.round(rupees * 100), taxRate });

test('billing: subtotal, tax and total are exact', () => {
  const b = computeBill([line(1, 2, 58), line(2, 3, 14)], null);
  assert.equal(b.subtotal, 158);
  assert.equal(b.tax, 7.9);
  assert.equal(b.total, 165.9);
  assert.equal(b.itemCount, 5);
});

test('billing: percent discount reduces taxable value', () => {
  const b = computeBill([line(1, 1, 100)], { type: 'percent', value: 10 });
  assert.equal(b.discount, 10);
  assert.equal(b.tax, 4.5);
  assert.equal(b.total, 94.5);
});

test('billing: discount allocation sums exactly (no lost paise)', () => {
  const b = computeBill([line(1, 1, 33.33), line(2, 1, 33.33), line(3, 1, 33.34)], { type: 'amount', value: 10 });
  const shares = b.items.reduce((a, i) => a + Math.round(i.discountShare * 100), 0);
  assert.equal(shares, 1000);
});

test('billing: discount is capped at the subtotal', () => {
  const b = computeBill([line(1, 1, 50)], { type: 'amount', value: 500 });
  assert.equal(b.discount, 50);
  assert.equal(b.total, 0);
});

test('forecast: fast seller with low stock gets high risk and a restock quantity', () => {
  const series = Array.from({ length: 28 }, (_, i) => 16 + (i > 20 ? 3 : 0));
  const f = forecastFromSeries(series, { stock: 35, leadTimeDays: 2, minimumStock: 40 });
  assert.ok(f.forecastDaily >= 16);
  assert.ok(f.stockoutRisk >= 0.75 && f.riskLevel === 'high');
  assert.ok(f.recommendedQty > 0 && f.recommendedQty % 5 === 0);
});

test('forecast: well stocked product needs no restock', () => {
  const f = forecastFromSeries(Array(28).fill(3), { stock: 400, leadTimeDays: 3, minimumStock: 20 });
  assert.equal(f.recommendedQty, 0);
  assert.equal(f.riskLevel, 'low');
});

test('forecast: out of stock item that sells is flagged', () => {
  const f = forecastFromSeries(Array(28).fill(4), { stock: 0, leadTimeDays: 3, minimumStock: 10 });
  assert.equal(f.stockoutRisk, 0.99);
  assert.ok(f.recommendedQty > 0);
});

test('forecast: stock already on order is subtracted', () => {
  const a = forecastFromSeries(Array(28).fill(10), { stock: 20, leadTimeDays: 3, minimumStock: 30 });
  const b = forecastFromSeries(Array(28).fill(10), { stock: 20, leadTimeDays: 3, minimumStock: 30, onOrder: 200 });
  assert.ok(b.recommendedQty < a.recommendedQty);
});

const baselines = {
  cashierLimitPct: 10,
  store: { n: 1000, totalMean: 125, totalStd: 90, discountShare: 0.02, refundRate: 0.01, cancelRate: 0.01 },
  employees: new Map([[1, { n: 300, p25: 2, p75: 6, p90: 9, pctP90: 5, refundRate: 0.01, cancelRate: 0.01 }]]),
};
const sale = (o) => ({ id: 1, employeeId: 1, subtotal: 1000, discount: 0, total: 1000, status: 'completed', refundAmount: 0, burst: 0, ...o });

test('risk: ordinary sale scores below the alert threshold', () => {
  assert.ok(scoreSale(sale({ discount: 30 }), baselines).score < 40);
});

test('risk: huge unapproved discount is critical and explained', () => {
  const r = scoreSale(sale({ subtotal: 1913, discount: 1200, total: 750 }), baselines);
  assert.ok(r.score >= 80);
  assert.equal(severityFor(r.score), 'critical');
  assert.ok(r.factors.length > 0 && r.factors.every((f) => f.label && f.detail));
});

test('risk: severity bands', () => {
  assert.equal(severityFor(85), 'critical');
  assert.equal(severityFor(65), 'high');
  assert.equal(severityFor(45), 'medium');
  assert.equal(severityFor(10), 'low');
});
