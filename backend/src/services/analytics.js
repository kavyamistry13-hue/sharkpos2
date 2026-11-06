// ANALYTICS — plain SQL aggregates over the sales tables. Revenue = collected bill total of completed sales.
// Estimated profit = (item sales value − purchase cost) − bill discounts, i.e. before tax, using current purchase prices.
const config = require('../config');
const { query } = require('../db');
const { cached } = require('../utils/cache');
const { getProductStats } = require('./forecast');

const TZ = config.storeTz;
const LOCAL = `(s.created_at AT TIME ZONE $1)`;
const RANGES = { today: 1, '7d': 7, '30d': 30, '3m': 90 };

const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const r2 = (n) => Math.round(n * 100) / 100;

async function windowTotals(whereSql, params) {
  const sales = await query(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(s.total),0) AS revenue, COALESCE(SUM(s.discount),0) AS discount
       FROM sales s WHERE s.status = 'completed' AND ${whereSql}`,
    params,
  );
  // Profit uses the cost, tax and discount stored ON THE SALE LINE (migration 009), so editing a product's price later never rewrites history.
  // Lines created before that migration fall back to today's purchase price (flagged cost_source = 'estimated').
  const margin = await query(
    `SELECT COALESCE(SUM(COALESCE(si.taxable_value, si.total - si.discount_share) - COALESCE(si.unit_cost, p.purchase_price) * si.quantity),0) AS margin
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
      WHERE s.status = 'completed' AND ${whereSql}`,
    params,
  );
  const t = sales.rows[0];
  return {
    orders: t.orders,
    revenue: r2(t.revenue),
    discount: r2(t.discount),
    profit: r2(margin.rows[0].margin),
    aov: t.orders ? r2(t.revenue / t.orders) : 0,
  };
}

async function getOverview() {
  return cached('overview', 10000, async () => {
    const todayW = `${LOCAL}::date = (now() AT TIME ZONE $1)::date`;
    const ydaySameTimeW = `${LOCAL}::date = (now() AT TIME ZONE $1)::date - 1 AND ${LOCAL}::time <= (now() AT TIME ZONE $1)::time`;
    const ydayFullW = `${LOCAL}::date = (now() AT TIME ZONE $1)::date - 1`;
    const [today, ydaySame, ydayFull, stats, alerts, hourly, topToday, clock] = await Promise.all([
      windowTotals(todayW, [TZ]),
      windowTotals(ydaySameTimeW, [TZ]),
      windowTotals(ydayFullW, [TZ]),
      getProductStats(),
      query(`SELECT COUNT(*)::int AS open, COUNT(*) FILTER (WHERE severity IN ('high','critical'))::int AS severe
               FROM anomaly_alerts WHERE status = 'open'`),
      query(
        `SELECT EXTRACT(HOUR FROM ${LOCAL})::int AS hour, COUNT(*)::int AS orders, COALESCE(SUM(s.total),0) AS revenue
           FROM sales s WHERE s.status = 'completed' AND ${todayW} GROUP BY 1 ORDER BY 1`,
        [TZ],
      ),
      query(
        `SELECT p.name, SUM(si.quantity) AS units, SUM(si.total) AS revenue
           FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
          WHERE s.status = 'completed' AND ${todayW} GROUP BY p.name ORDER BY units DESC LIMIT 5`,
        [TZ],
      ),
      query(`SELECT to_char(now() AT TIME ZONE $1, 'HH24:MI') AS hhmm, EXTRACT(HOUR FROM now() AT TIME ZONE $1)::int AS hour`, [TZ]),
    ]);

    // When it is early in the day the same-time comparison is meaningless (few orders yesterday by now),
    // so fall back to yesterday's full-day totals and say so.
    const useFull = clock.rows[0].hour < 13;
    const baseline = useFull ? ydayFull : ydaySame;
    const lowStock = stats.filter((p) => p.lowStock).length;
    const atRisk = stats.filter((p) => p.riskLevel === 'high').length;
    return {
      generatedAt: new Date().toISOString(),
      localTime: clock.rows[0].hhmm,
      localHour: clock.rows[0].hour,
      kpis: {
        revenue: today.revenue,
        orders: today.orders,
        products: stats.length,
        lowStock,
        estimatedProfit: today.profit,
        riskAlerts: alerts.rows[0].open,
        severeRiskAlerts: alerts.rows[0].severe,
        stockoutRiskProducts: atRisk,
        aov: today.aov,
      },
      comparison: {
        basis: useFull ? 'yesterday (full day)' : 'yesterday (same time)',
        revenueChangePct: pct(today.revenue, baseline.revenue),
        ordersChangePct: pct(today.orders, baseline.orders),
        yesterdayRevenue: baseline.revenue,
        yesterdayOrders: baseline.orders,
      },
      hourly: hourly.rows.map((h) => ({ hour: h.hour, label: `${String(h.hour).padStart(2, '0')}:00`, orders: h.orders, revenue: r2(h.revenue) })),
      topToday: topToday.rows.map((r) => ({ name: r.name, units: r.units, revenue: r2(r.revenue) })),
    };
  });
}

async function getSalesAnalytics(range = '7d') {
  if (!RANGES[range]) range = '7d';
  return cached(`sales:${range}`, 20000, async () => {
    const days = RANGES[range];
    const winW = `${LOCAL}::date > (now() AT TIME ZONE $1)::date - $2::int`;
    const prevW = `${LOCAL}::date > (now() AT TIME ZONE $1)::date - $2::int * 2 AND ${LOCAL}::date <= (now() AT TIME ZONE $1)::date - $2::int`;
    const params = [TZ, days];
    const bucket = range === 'today' ? `EXTRACT(HOUR FROM ${LOCAL})::int` : range === '3m' ? `date_trunc('week', ${LOCAL})::date` : `${LOCAL}::date`;
    const [cur, prev, trend, categories, top, payments, calendar] = await Promise.all([
      windowTotals(winW, params),
      windowTotals(prevW, params),
      query(
        `SELECT ${bucket}::text AS bucket, COUNT(*)::int AS orders, COALESCE(SUM(s.total),0) AS revenue
           FROM sales s WHERE s.status = 'completed' AND ${winW} GROUP BY 1 ORDER BY 1`,
        params,
      ),
      query(
        `SELECT c.name, SUM(si.total) AS revenue, SUM(si.quantity) AS units
           FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
           JOIN categories c ON c.id = p.category_id
          WHERE s.status = 'completed' AND ${winW} GROUP BY c.name ORDER BY revenue DESC`,
        params,
      ),
      query(
        `SELECT p.id, p.name, c.name AS category, SUM(si.quantity) AS units, SUM(si.total) AS revenue
           FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
           JOIN categories c ON c.id = p.category_id
          WHERE s.status = 'completed' AND ${winW} GROUP BY p.id, p.name, c.name ORDER BY units DESC LIMIT 10`,
        params,
      ),
      query(
        `SELECT s.payment_method AS method, COUNT(*)::int AS orders, COALESCE(SUM(s.total),0) AS revenue
           FROM sales s WHERE s.status = 'completed' AND ${winW} GROUP BY 1 ORDER BY revenue DESC`,
        params,
      ),
      // Fixed "sales today / this week / this month" cards, independent of the selected range
      Promise.all([
        windowTotals(`${LOCAL}::date = (now() AT TIME ZONE $1)::date`, [TZ]),
        windowTotals(`${LOCAL}::date > (now() AT TIME ZONE $1)::date - 7`, [TZ]),
        windowTotals(`${LOCAL}::date > (now() AT TIME ZONE $1)::date - 30`, [TZ]),
      ]),
    ]);
    const label = (b) => {
      if (range === 'today') return `${String(b).padStart(2, '0')}:00`;
      const d = new Date(`${b}T00:00:00Z`);
      return `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
    };
    return {
      range,
      granularity: range === 'today' ? 'hour' : range === '3m' ? 'week' : 'day',
      totals: { ...cur, revenueChangePct: pct(cur.revenue, prev.revenue), ordersChangePct: pct(cur.orders, prev.orders), aovChangePct: pct(cur.aov, prev.aov) },
      previous: prev,
      periods: { today: calendar[0], week: calendar[1], month: calendar[2] },
      trend: trend.rows.map((r) => ({ key: r.bucket, label: label(r.bucket), orders: r.orders, revenue: r2(r.revenue), aov: r.orders ? r2(r.revenue / r.orders) : 0 })),
      categories: categories.rows.map((r) => ({ name: r.name, revenue: r2(r.revenue), units: r.units })),
      topProducts: top.rows.map((r) => ({ id: r.id, name: r.name, category: r.category, units: r.units, revenue: r2(r.revenue) })),
      payments: payments.rows.map((r) => ({ method: r.method, orders: r.orders, revenue: r2(r.revenue) })),
    };
  });
}

/** Product-level view: sales velocity from the forecast stats + revenue in the window. */
async function getProductAnalytics(range = '30d') {
  if (!RANGES[range]) range = '30d';
  const days = RANGES[range];
  const [stats, rev] = await Promise.all([
    getProductStats(),
    query(
      `SELECT si.product_id, SUM(si.quantity) AS units, SUM(si.total) AS revenue, SUM(COALESCE(si.taxable_value, si.total - si.discount_share) - COALESCE(si.unit_cost, p.purchase_price) * si.quantity) AS margin
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
        WHERE s.status = 'completed' AND ${LOCAL}::date > (now() AT TIME ZONE $1)::date - $2::int GROUP BY 1`,
      [TZ, days],
    ),
  ]);
  const byId = new Map(rev.rows.map((r) => [r.product_id, r]));
  const rows = stats.map((p) => {
    const r = byId.get(p.id);
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      stock: p.stock,
      units: r ? r.units : 0,
      revenue: r ? r2(r.revenue) : 0,
      margin: r ? r2(r.margin) : 0,
      avgDailySales: p.avgDailySales,
      trendPct: p.trendPct,
      slowMoving: p.slowMoving,
      stockValue: p.stockValue,
    };
  });
  return {
    range,
    fastMoving: [...rows].sort((a, b) => b.avgDailySales - a.avgDailySales).slice(0, 10),
    topRevenue: [...rows].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    slowMoving: rows.filter((r) => r.slowMoving).sort((a, b) => b.stockValue - a.stockValue).slice(0, 10),
    rising: rows.filter((r) => r.avgDailySales >= 3 && r.trendPct >= 15).sort((a, b) => b.trendPct - a.trendPct).slice(0, 10),
  };
}

module.exports = { getOverview, getSalesAnalytics, getProductAnalytics, RANGES };
