// TRANSACTION RISK ENGINE — transparent, rule-based scoring. This is NOT a machine-learning model.
//
// Each sale gets 0-100 points from independent, explainable factors:
//   discount_deviation      discount vs the cashier's own usual discounts (their 90th percentile)      up to 60
//   discount_depth          discount as a share of the bill                                              up to 15
//   amount_deviation        bill total vs the store's typical bill (z-score)                            up to 15
//   refund_amount           refund taken on this sale as a share of its total                           up to 30
//   refund_frequency        cashier's refund rate vs store average                                       up to 10
//   cancellation_frequency  cashier's cancellation rate vs store average                                 up to 10
//   unapproved_discount     cashier gave more than their discount limit with no manager approval recorded  10
//   transaction_frequency   cashier's transactions in a 10-minute window                                 up to 10
// Severity: >= 80 critical, >= 60 high, >= 40 medium, else low. Sales >= 40 raise an alert.
const config = require('../config');
const { query } = require('../db');
const { notFound } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

const severityFor = (score) => (score >= 80 ? 'critical' : score >= 60 ? 'high' : score >= 40 ? 'medium' : 'low');

/** Store-wide and per-employee baselines over the last 90 days. `q` is a (text, params) => {rows} function. */
async function getBaselines(q) {
  const [storeRes, empRes] = await Promise.all([
    q(
      `SELECT COUNT(*)::int AS n,
              COALESCE(AVG(total), 0) AS total_mean,
              COALESCE(STDDEV_SAMP(total), 0) AS total_std,
              COALESCE(SUM(discount) / NULLIF(SUM(subtotal), 0), 0) AS disc_share,
              COALESCE(AVG((refund_amount > 0)::int), 0) AS refund_rate,   -- full or partial return
              COALESCE(AVG((status = 'cancelled')::int), 0) AS cancel_rate
         FROM sales
        WHERE created_at > now() - interval '90 days'`,
    ),
    q(
      `SELECT u.id, u.name, u.role,
              COUNT(s.id)::int AS n,
              COALESCE(SUM(s.total - s.refund_amount) FILTER (WHERE s.status = 'completed'), 0) AS revenue,   -- net of partial returns
              COALESCE(SUM(s.discount) FILTER (WHERE s.status <> 'cancelled'), 0) AS discount_total,
              COALESCE(SUM(s.subtotal) FILTER (WHERE s.status <> 'cancelled'), 0) AS subtotal_total,
              COUNT(*) FILTER (WHERE s.refund_amount > 0)::int AS refunds,
              COUNT(*) FILTER (WHERE s.status = 'cancelled')::int AS cancels,
              percentile_cont(0.25) WITHIN GROUP (ORDER BY s.discount) FILTER (WHERE s.discount > 0) AS disc_p25,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY s.discount) FILTER (WHERE s.discount > 0) AS disc_p75,
              percentile_cont(0.90) WITHIN GROUP (ORDER BY s.discount) FILTER (WHERE s.discount > 0) AS disc_p90,
              percentile_cont(0.90) WITHIN GROUP (ORDER BY s.discount / NULLIF(s.subtotal, 0) * 100) FILTER (WHERE s.discount > 0 AND s.subtotal > 0) AS pct_p90
         FROM users u
         LEFT JOIN sales s ON s.employee_id = u.id AND s.created_at > now() - interval '90 days'
        GROUP BY u.id, u.name, u.role`,
    ),
  ]);
  const s = storeRes.rows[0];
  const employees = new Map();
  for (const e of empRes.rows) {
    employees.set(e.id, {
      id: e.id,
      name: e.name,
      role: e.role,
      n: e.n,
      revenue: e.revenue,
      discountTotal: e.discount_total,
      discountShare: e.subtotal_total > 0 ? e.discount_total / e.subtotal_total : 0,
      refunds: e.refunds,
      cancels: e.cancels,
      refundRate: e.n ? e.refunds / e.n : 0,
      cancelRate: e.n ? e.cancels / e.n : 0,
      p25: e.disc_p25,
      p75: e.disc_p75,
      p90: e.disc_p90,
      pctP90: e.pct_p90,
    });
  }
  const limitRow = await q(`SELECT value FROM settings WHERE key = 'cashierMaxDiscountPct'`);
  const cashierLimitPct = limitRow.rows[0] ? Number(limitRow.rows[0].value) : config.rules.cashierMaxDiscountPct;
  return {
    cashierLimitPct,
    store: {
      n: s.n,
      totalMean: s.total_mean,
      totalStd: s.total_std,
      discountShare: s.disc_share,
      refundRate: s.refund_rate,
      cancelRate: s.cancel_rate,
    },
    employees,
  };
}

/** Pure scoring. sale: { id, employeeId, subtotal, discount, total, status, refundAmount, burst } */
function scoreSale(sale, baselines) {
  const emp = baselines.employees.get(sale.employeeId);
  const store = baselines.store;
  const factors = [];
  const add = (key, label, points, detail) => {
    if (points > 0) factors.push({ key, label, points: Math.round(points), detail });
  };

  // 1-2. Discounts (judged as a % of the bill, against the cashier's own 90th-percentile discount %)
  if (sale.discount > 0 && sale.status !== 'cancelled') {
    const pct = sale.subtotal > 0 ? (sale.discount / sale.subtotal) * 100 : 0;
    const usualPct = Math.max(emp && emp.pctP90 ? emp.pctP90 : 0, 3);
    const ratio = pct / usualPct;
    if (ratio > 1) {
      const normal = emp && emp.p25 ? `${inr(emp.p25)}–${inr(emp.p75)}` : 'a few rupees';
      add(
        'discount_deviation',
        'Discount deviation',
        clamp(20 * Math.log2(ratio), 0, 60),
        `Discount ${inr(sale.discount)} (${Math.round(pct)}% of the bill) is ${ratio.toFixed(1)}× this cashier's usual upper range of ${usualPct.toFixed(0)}% (normal discounts ${normal}).`,
      );
    }
    const depth = pct >= 50 ? 15 : pct >= 35 ? 10 : pct >= 20 ? 5 : 0;
    add('discount_depth', 'Deep discount', depth, `${Math.round(pct)}% of the bill was discounted.`);
    if (emp && emp.role === 'cashier' && !sale.approvedBy && pct > baselines.cashierLimitPct) {
      add('unapproved_discount', 'No approval recorded', 10, `${Math.round(pct)}% discount is above the cashier limit of ${baselines.cashierLimitPct}% and no manager approval is recorded.`);
    }
  }

  // 3. Amount deviation
  if (store.totalStd > 0 && sale.status !== 'cancelled') {
    const z = (sale.total - store.totalMean) / store.totalStd;
    if (z > 2) {
      add(
        'amount_deviation',
        'Unusual amount',
        clamp((z - 2) * 5, 0, 15),
        `Bill of ${inr(sale.total)} is ${z.toFixed(1)} standard deviations above the store average of ${inr(store.totalMean)}.`,
      );
    }
  }

  // 4. Refund on this sale
  if (sale.refundAmount > 0 && sale.total > 0) {
    const share = sale.refundAmount / sale.total;
    add(
      'refund_amount',
      'High refund',
      clamp(share * 30, 0, 30),
      `${inr(sale.refundAmount)} (${Math.round(share * 100)}% of the bill) was refunded.`,
    );
  }

  // 5-6. Cashier behaviour
  if (emp && emp.n >= 20) {
    if (sale.refundAmount > 0 && emp.refunds >= 3 && emp.refundRate > Math.max(store.refundRate * 2, 0.01)) {
      add(
        'refund_frequency',
        'Frequent refunds',
        clamp((emp.refundRate / Math.max(store.refundRate, 0.005) - 2) * 2 + 3, 0, 10),
        `${emp.name} has ${emp.refunds} refunds in 90 days (${(emp.refundRate * 100).toFixed(1)}% of sales vs ${(store.refundRate * 100).toFixed(1)}% store-wide).`,
      );
    }
    if (sale.status === 'cancelled' && emp.cancels >= 3 && emp.cancelRate > Math.max(store.cancelRate * 2, 0.01)) {
      add(
        'cancellation_frequency',
        'Repeated cancellations',
        clamp((emp.cancelRate / Math.max(store.cancelRate, 0.005) - 2) * 2 + 3, 0, 10),
        `${emp.name} has ${emp.cancels} cancelled bills in 90 days (${(emp.cancelRate * 100).toFixed(1)}% vs ${(store.cancelRate * 100).toFixed(1)}% store-wide).`,
      );
    }
  }

  // 7. Burst of transactions
  if (sale.burst >= 8) {
    add(
      'transaction_frequency',
      'Unusual transaction frequency',
      clamp((sale.burst - 7) * 2, 0, 10),
      `${sale.burst} transactions by the same cashier within 10 minutes.`,
    );
  }

  const score = clamp(
    factors.reduce((a, f) => a + f.points, 0),
    0,
    100,
  );
  factors.sort((a, b) => b.points - a.points);
  const severity = severityFor(score);
  const reason = factors.length ? factors.slice(0, 2).map((f) => f.detail).join(' ') : 'No unusual behaviour detected.';
  return {
    score,
    severity,
    reason,
    factors,
    recommendedAction:
      severity === 'critical' || severity === 'high' ? 'Review this transaction with the cashier and check the supporting documents.' : severity === 'medium' ? 'Spot-check this transaction.' : 'No action needed.',
  };
}

const SALE_SELECT = `
  SELECT s.id, s.invoice_no, s.employee_id, u.name AS employee, s.subtotal, s.discount, s.tax, s.total, s.status,
         s.refund_amount, s.payment_method, s.created_at, s.discount_approved_by,
         (SELECT COUNT(*)::int FROM sales b
           WHERE b.employee_id = s.employee_id
             AND b.created_at BETWEEN s.created_at - interval '10 minutes' AND s.created_at) AS burst
    FROM sales s JOIN users u ON u.id = s.employee_id`;

const mapSale = (r) => ({
  id: r.id,
  invoiceNo: r.invoice_no,
  employeeId: r.employee_id,
  employee: r.employee,
  subtotal: r.subtotal,
  discount: r.discount,
  tax: r.tax,
  total: r.total,
  status: r.status,
  refundAmount: r.refund_amount,
  paymentMethod: r.payment_method,
  createdAt: r.created_at,
  approvedBy: r.discount_approved_by,
  burst: r.burst,
});

/** Score sales and upsert alerts for those >= threshold. Returns [{ saleId, ...result }]. */
async function evaluateSales(q, { saleIds = null, sinceDays = null } = {}) {
  const baselines = await getBaselines(q);
  let rows;
  if (saleIds) rows = (await q(`${SALE_SELECT} WHERE s.id = ANY($1::int[])`, [saleIds])).rows;
  else rows = (await q(`${SALE_SELECT} WHERE s.created_at > now() - ($1::int * interval '1 day')`, [sinceDays || 90])).rows;

  const results = [];
  for (const row of rows) {
    const sale = mapSale(row);
    const r = scoreSale(sale, baselines);
    results.push({ saleId: sale.id, ...r });
    if (r.score >= config.rules.riskAlertThreshold) {
      await q(
        `INSERT INTO anomaly_alerts (sale_id, risk_score, severity, reason, factors, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (business_id, sale_id) DO UPDATE
           SET risk_score = EXCLUDED.risk_score, severity = EXCLUDED.severity,
               reason = EXCLUDED.reason, factors = EXCLUDED.factors`,
        [sale.id, r.score, r.severity, r.reason, JSON.stringify(r.factors), sale.createdAt],
      );
    }
  }
  return results;
}

/** Employee-level risk summary used by the Employees page and by the copilot. */
function employeeRisk(emp, baselines, openAlerts) {
  const store = baselines.store;
  const discRatio = store.discountShare > 0 ? emp.discountShare / store.discountShare : 1;
  const refundRatio = store.refundRate > 0 ? emp.refundRate / store.refundRate : 1;
  const points = 20 * Math.max(0, discRatio - 1) + 10 * openAlerts + 8 * Math.max(0, refundRatio - 1);
  const score = Math.round(clamp(points, 0, 100));
  return { score, level: severityFor(score), discountRatio: Math.round(discRatio * 10) / 10 };
}

async function listAlerts({ status, severity, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
  params.push(limit);
  const res = await query(
    `SELECT a.id, a.sale_id, a.risk_score, a.severity, a.reason, a.factors, a.status, a.created_at,
            s.invoice_no, s.subtotal, s.discount, s.total, s.status AS sale_status, s.refund_amount, s.payment_method,
            u.name AS employee, u.id AS employee_id
       FROM anomaly_alerts a JOIN sales s ON s.id = a.sale_id JOIN users u ON u.id = s.employee_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (a.status = 'open') DESC, a.risk_score DESC, a.created_at DESC LIMIT $${params.length}`,
    params,
  );
  const baselines = await getBaselines(query);
  return res.rows.map((r) => {
    const emp = baselines.employees.get(r.employee_id);
    return {
      id: r.id, saleId: r.sale_id, invoiceNo: r.invoice_no, riskScore: r.risk_score, severity: r.severity,
      reason: r.reason, factors: r.factors, status: r.status, createdAt: r.created_at,
      employee: r.employee, bill: r.subtotal, discount: r.discount, total: r.total, saleStatus: r.sale_status,
      refundAmount: r.refund_amount, paymentMethod: r.payment_method,
      normalDiscountRange: emp && emp.p25 != null ? [Math.round(emp.p25), Math.round(emp.p75)] : null,
      recommendedAction: r.severity === 'critical' || r.severity === 'high' ? 'Review this transaction with the cashier and check the supporting documents.' : r.severity === 'medium' ? 'Spot-check this transaction.' : 'No action needed.',
    };
  });
}

async function getRiskSummary() {
  const res = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE status = 'open' AND severity = 'critical')::int AS critical,
            COUNT(*) FILTER (WHERE status = 'open' AND severity = 'high')::int AS high,
            COUNT(*) FILTER (WHERE status = 'open' AND severity = 'medium')::int AS medium,
            COUNT(*) FILTER (WHERE status <> 'open')::int AS resolved
       FROM anomaly_alerts`,
  );
  return res.rows[0];
}

async function setAlertStatus(id, status, userId) {
  const res = await query(`UPDATE anomaly_alerts SET status = $1, reviewed_by = $2 WHERE id = $3 RETURNING id`, [status, userId, id]);
  if (!res.rowCount) throw notFound('Alert not found.');
  invalidateAll();
}

module.exports = { getBaselines, scoreSale, evaluateSales, employeeRisk, severityFor, listAlerts, getRiskSummary, setAlertStatus };
