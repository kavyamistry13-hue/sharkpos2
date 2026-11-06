// AI DAILY BRIEF — built from live database numbers. The text is deterministic; an LLM may only rephrase it,
// and its output is discarded unless every number is present in the facts.
const config = require('../config');
const { getOverview } = require('../services/analytics');
const { getRestockRecommendations } = require('../services/inventory');
const { getProductStats } = require('../services/forecast');
const { complete, isConfigured, AiUnavailableError } = require('./llm');
const { isGrounded } = require('./grounding');
const { cached } = require('../utils/cache');

const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const shortName = (n) => n.replace(/\s+\d.*$/, '');

function greeting(hour) {
  return hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : 'Good evening.';
}

async function getDailyBrief() {
  return cached('brief', 30000, buildBrief);
}

async function buildBrief() {
  const [o, recs, stats] = await Promise.all([getOverview(), getRestockRecommendations(), getProductStats()]);
  const k = o.kpis;
  const cmp = o.comparison;
  const top = o.topToday.slice(0, 2).map((p) => p.name);
  const urgent = recs.filter((r) => r.riskLevel !== 'low').slice(0, 3);
  const facts = {
    revenue: k.revenue, orders: k.orders, revenueChangePct: cmp.revenueChangePct, comparisonBasis: cmp.basis,
    topProducts: top, lowStock: k.lowStock, riskAlerts: k.riskAlerts, restock: urgent.map((r) => ({ name: r.name, quantity: r.recommendedQty })),
    highStockoutRisk: stats.filter((p) => p.riskLevel === 'high').length,
  };
  const lines = [greeting(o.localHour)];
  if (cmp.revenueChangePct !== null) {
    lines.push(`Revenue is ${cmp.revenueChangePct >= 0 ? 'up' : 'down'} ${Math.abs(cmp.revenueChangePct)}% compared with ${cmp.basis} (${inr(k.revenue)} from ${k.orders} orders).`);
  } else {
    lines.push(`Revenue so far is ${inr(k.revenue)} from ${k.orders} orders.`);
  }
  if (top.length) lines.push(`${list(top.map(shortName))} ${top.length > 1 ? 'are' : 'is'} the highest-demand product${top.length > 1 ? 's' : ''} today.`);
  lines.push(`${k.lowStock} product${k.lowStock === 1 ? ' is' : 's are'} below minimum stock.`);
  lines.push(`${k.riskAlerts} transaction${k.riskAlerts === 1 ? '' : 's'} require${k.riskAlerts === 1 ? 's' : ''} review.`);
  const action = urgent.length ? `Recommended action: restock ${list(urgent.map((r) => shortName(r.name)))}.` : 'Recommended action: no urgent restocking needed.';
  const text = lines.join('\n') + '\n\n' + action;

  const result = { text, facts, source: 'data', generatedAt: new Date().toISOString(), notice: null, action: urgent.length ? { label: 'Review restock', to: '/inventory?view=restock' } : null };
  if (!isConfigured()) return result;
  try {
    const polished = await complete({
      system: 'You write a 4-6 line daily brief for a shop owner. Use ONLY the numbers in FACTS; copy them exactly. Plain text, no markdown, no emojis. Keep the greeting first and end with a line starting "Recommended action:".',
      user: `FACTS:\n${JSON.stringify(facts)}\n\nBASELINE:\n${text}`,
      maxTokens: 300,
    });
    if (isGrounded(polished, { facts, text })) return { ...result, text: polished, source: 'llm' };
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) console.error('[brief] unexpected AI error', err);
  }
  return { ...result, notice: 'AI service temporarily unavailable. Showing data-driven summary.' };
}

module.exports = { getDailyBrief };
