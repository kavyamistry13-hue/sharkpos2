// DEMO DATA GENERATOR — builds a realistic, internally consistent store history in one transaction.
//   * 133 products, 12 categories, 12 suppliers, 64+ customers, 8 staff, ~20k sales over 90 days
//   * stock ledger (inventory_movements) adds up exactly to each product's current stock
//   * "today" is calibrated to the demo story (342 orders, about ₹42,850) and yesterday is shaped so the
//     dashboard shows a believable comparison whatever time of day the data is loaded
//   * deliberate demo cases: high-demand product, stockout risk, slow movers, rising demand, 3 suspicious sales
// Everything is generated with a fixed random seed, so the same dataset is produced every time.
const bcrypt = require('bcryptjs');
const config = require('../config');
const { withSystemTransaction, runAsTenant, query } = require('../db');
const { BCRYPT_ROUNDS } = require('../services/authService');
const { computeBill } = require('../services/billing');
const { toPaise } = require('../utils/money');
const { evaluateSales } = require('../services/risk');
const { invalidateAll } = require('../utils/cache');
const { CATEGORIES, SUPPLIERS, PRODUCTS, FIRST, LAST } = require('./catalog');

const TZ = config.storeTz;
const HISTORY_DAYS = 90;
const REF_ORDERS = 300; // orders/day at which `unitsPerDay` in the catalogue holds
const TARGET_TODAY_ORDERS = 342;
const TARGET_TODAY_REVENUE = 42850;
const TARGET_YESTERDAY_ORDERS = 305; // yesterday, measured at the same time of day
const OPEN_HOUR = 7;
const HOUR_WEIGHTS = [0.03, 0.05, 0.06, 0.06, 0.07, 0.08, 0.08, 0.07, 0.07, 0.08, 0.1, 0.11, 0.09, 0.06, 0.04]; // 07:00 .. 21:59

// ---------- random helpers (mulberry32) ----------
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- date helpers ----------
function localNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}
const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dowOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();
const hhmmss = (min, sec) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
const DOW_FACTOR = [1.12, 0.95, 0.95, 1.0, 1.0, 1.05, 1.18]; // Sun..Sat

async function loadDemoData({ businessId, log = () => {} } = {}) {
  if (!businessId) throw new Error('loadDemoData requires a businessId');
  const rng = makeRng(20260607);
  const rand = (a, b) => a + rng() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const normal = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const lognoise = (sd) => Math.exp(normal() * sd - (sd * sd) / 2);
  const poisson = (lambda) => {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do { k += 1; p *= rng(); } while (p > L && k < 30);
    return k - 1;
  };

  const now = localNow();
  const today = now.date;
  const dayDate = (d) => addDays(today, -d);
  const hourShareBefore = (min) => {
    let share = 0;
    for (let i = 0; i < HOUR_WEIGHTS.length; i += 1) {
      const start = (OPEN_HOUR + i) * 60;
      if (min >= start + 60) share += HOUR_WEIGHTS[i];
      else if (min > start) share += (HOUR_WEIGHTS[i] * (min - start)) / 60;
    }
    return share / HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  };
  const wsum = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  function sampleMinute(limit) {
    if (limit !== null && limit < OPEN_HOUR * 60 + 30) return Math.floor(rng() * Math.max(limit, 1));
    for (;;) {
      let u = rng() * wsum;
      let h = OPEN_HOUR;
      for (let i = 0; i < HOUR_WEIGHTS.length; i += 1) { u -= HOUR_WEIGHTS[i]; if (u <= 0) { h = OPEN_HOUR + i; break; } }
      if (limit !== null && h * 60 > limit) continue;
      let t = h * 60 + Math.floor(rng() * 60);
      if (limit !== null && t > limit) t = h * 60 + Math.floor(rng() * (limit - h * 60 + 1));
      return t;
    }
  }

  // ---------- reference data ----------
  log('Creating users, categories, suppliers, products…');
  const staff = [
    { name: 'Priya Sharma', email: 'admin@sharkpos.ai', pw: 'admin123', role: 'business_owner', w: 0.01 },
    { name: 'Arjun Mehta', email: 'manager@sharkpos.ai', pw: 'manager123', role: 'manager', w: 0.02 },
    { name: 'Sneha Iyer', email: 'cashier@sharkpos.ai', pw: 'cashier123', role: 'cashier', w: 0.21, disc: [0.1, 2, 6], refund: 0.008, cancel: 0.007 },
    { name: 'Rahul Verma', email: 'rahul@sharkpos.ai', pw: 'cashier123', role: 'cashier', w: 0.22, disc: [0.38, 4, 9], refund: 0.008, cancel: 0.007 },
    { name: 'Kiran Patel', email: 'kiran@sharkpos.ai', pw: 'cashier123', role: 'cashier', w: 0.18, disc: [0.12, 2, 6], refund: 0.045, cancel: 0.03 },
    { name: 'Divya Nair', email: 'divya@sharkpos.ai', pw: 'cashier123', role: 'cashier', w: 0.17, disc: [0.1, 2, 6], refund: 0.008, cancel: 0.007 },
    { name: 'Imran Khan', email: 'imran@sharkpos.ai', pw: 'cashier123', role: 'cashier', w: 0.12, disc: [0.08, 2, 5], refund: 0.008, cancel: 0.007 },
    { name: 'Meera Reddy', email: 'meera@sharkpos.ai', pw: 'cashier123', role: 'cashier', w: 0.07, disc: [0.1, 2, 6], refund: 0.008, cancel: 0.007 },
  ];
  staff.forEach((s, i) => { s.id = i + 1; s.hash = bcrypt.hashSync(s.pw, BCRYPT_ROUNDS); });
  const staffId = (name) => staff.find((s) => s.name === name).id;
  const empCum = (() => { let c = 0; return staff.map((s) => (c += s.w)); })();
  const pickEmployee = () => { const u = rng() * empCum[empCum.length - 1]; return staff[empCum.findIndex((c) => u <= c)]; };

  const costPct = [0.86, 0.76, 0.8, 0.78, 0.86, 0.72, 0.76, 0.7, 0.72, 0.76, 0.72, 0.84];
  // Keep the average bill near Rs 125 (small-store basket): high-ticket items sell less often. Demo heroes are exempt.
const HERO_NAMES = new Set(['Milk 1L', 'Whole Wheat Bread 400g', 'Instant Coffee 200g', 'Basmati Rice 5kg']);
// Hero rates are lowered a little because multi-unit lines (qty 2-3) add ~20% to units sold.
const HERO_FACTOR = { 'Milk 1L': 0.84, 'Whole Wheat Bread 400g': 0.8, 'Instant Coffee 200g': 0.8, 'Basmati Rice 5kg': 0.8 };
PRODUCTS.forEach((p) => {
  if (p.scaled) return;
  if (HERO_FACTOR[p.name]) p.perDay *= HERO_FACTOR[p.name];
  else if (p.price >= 150) p.perDay *= 0.45;
  p.scaled = true;
});
const totalRaw = PRODUCTS.reduce((a, p) => a + p.perDay, 0);
  const meanItems = totalRaw / REF_ORDERS;

  const products = PRODUCTS.map((p, i) => {
    const supplier = SUPPLIERS[p.sup];
    let lead = supplier[3];
    if (p.name === 'Whole Wheat Bread 400g') lead = 2;
    if (p.name === 'Instant Coffee 200g') lead = 5;
    const purchase = Math.round(p.price * costPct[p.cat] * 100) / 100;
    const minStock = Math.max(3, Math.ceil(p.perDay * lead * 1.2) + 2);
    let stock = minStock + Math.ceil(p.perDay * rand(4, 10));
    if (p.perDay < 1) stock = randInt(8, 28);
    return { id: i + 1, ...p, sku: `SKU-${String(1000 + i)}`, purchase, lead, minStock, stock, expiry: null };
  });
  const byName = (n) => products.find((p) => p.name === n);

  // Hero stock levels for the demo story
  const hero = { milk: byName('Milk 1L'), bread: byName('Whole Wheat Bread 400g'), coffee: byName('Instant Coffee 200g'), rice: byName('Basmati Rice 5kg') };
  Object.assign(hero.milk, { stock: 35, minStock: 40 });
  Object.assign(hero.bread, { stock: 18, minStock: 30 });
  Object.assign(hero.coffee, { stock: 15, minStock: 25 });
  Object.assign(hero.rice, { stock: 85, minStock: 24 });
  const heroIds = new Set(Object.values(hero).map((h) => h.id));

  // Exactly 17 products at/below minimum stock (3 heroes + 14 others, two fully out of stock)
  const lowCandidates = products.filter((p) => !heroIds.has(p.id) && p.perDay >= 1.5 && p.perDay <= 12 && p.price < 400);
  const lowPicks = [];
  while (lowPicks.length < 14) { const p = pick(lowCandidates); if (!lowPicks.includes(p)) lowPicks.push(p); }
  lowPicks.forEach((p, i) => { p.stock = i < 2 ? 0 : randInt(1, p.minStock); });
  // Overstock + slow movers
  products.filter((p) => p.perDay < 1 && !lowPicks.includes(p)).forEach((p, i) => { if (i % 3 === 0) p.stock = randInt(150, 300); });

  // Expiry dates
  const expiryOffsets = { 'Milk 1L': 4, 'Whole Wheat Bread 400g': 3, 'Paneer 200g': 5, 'Buttermilk 200ml': 3, 'Chocolate Muffin 2 Pack': 2, 'Banana 6 Pcs': 3, 'Curd 400g': -2 };
  const within30 = ['Butter 100g', 'Orange Juice 1L', 'Mayonnaise 250g', 'Chicken Nuggets 250g', 'Frozen Paratha 5 Pack', 'Vanilla Ice Cream 500ml', 'Jelly Cups 6 Pack', 'Cold Coffee Can 180ml'];
  products.forEach((p) => {
    if (expiryOffsets[p.name] !== undefined) p.expiry = addDays(today, expiryOffsets[p.name]);
    else if (within30.includes(p.name)) p.expiry = addDays(today, randInt(10, 28));
    else if (p.shelf && p.shelf > 7) p.expiry = addDays(today, randInt(35, Math.max(36, p.shelf)));
  });
  byName('Curd 400g').stock = Math.max(byName('Curd 400g').stock, 14);

  // ---------- customers ----------
  const customers = [];
  const usedNames = new Set(['Kavya Rao']);
  const phoneSet = new Set(['9876500001']);
  const mkPhone = () => { let ph; do { ph = `9${randInt(1000, 9999)}${randInt(10000, 99999)}`; } while (phoneSet.has(ph)); phoneSet.add(ph); return ph; };
  for (let i = 0; customers.length < 64; i += 1) {
    const name = `${FIRST[(i * 3 + 1) % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`;
    if (usedNames.has(name) || staff.some((s) => s.name === name)) continue;
    usedNames.add(name);
    const idx = customers.length;
    const type = idx < 8 ? 'vip' : idx < 38 ? 'regular' : idx < 48 ? 'inactive' : idx < 58 ? 'new' : 'occasional';
    customers.push({ name, phone: mkPhone(), email: rng() < 0.5 ? `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com` : null, type, startD: type === 'new' ? randInt(3, 18) : null });
  }
  customers.push({ name: 'Kavya Rao', phone: '9876500001', email: 'kavya.rao@example.com', type: 'special', startD: null });
  customers.forEach((c, i) => { c.id = i + 1; });
  const kavya = customers[customers.length - 1];
  const custEligible = (d) => customers.filter((c) => (c.type === 'vip' || c.type === 'regular' || c.type === 'occasional') || (c.type === 'inactive' && d >= 50) || (c.type === 'new' && d <= c.startD));
  const custWeight = { vip: 6, regular: 2, inactive: 1.5, new: 2, occasional: 0.4 };

  // ---------- demand model ----------
  const trends = {
    'Milk 1L': (d) => (d >= 14 ? 1 : d <= 6 ? 1.1 : 1 + ((14 - d) / 8) * 0.1),
    'Basmati Rice 5kg': (d) => (d >= 8 ? 1 : 1.3),
    'Instant Coffee 200g': (d) => (d >= 8 ? 1 : 1.1),
    'Whole Wheat Bread 400g': (d) => (d >= 8 ? 1 : 1.08),
  };
  const noiseSd = { 'Milk 1L': 0.2, 'Whole Wheat Bread 400g': 0.16, 'Basmati Rice 5kg': 0.04 };
  const dayWeights = (d) => {
    const cum = [];
    let c = 0;
    for (const p of products) {
      const t = trends[p.name] ? trends[p.name](d) : 1;
      c += p.perDay * t * lognoise(noiseSd[p.name] || 0.1);
      cum.push(c);
    }
    return cum;
  };
  const drawProduct = (cum) => { const u = rng() * cum[cum.length - 1]; let lo = 0; let hi = cum.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] >= u) hi = mid; else lo = mid + 1; } return products[lo]; };

  const priceOrder = (o) => {
    const lines = [...o.lines.entries()].map(([pid, qty]) => { const p = products[pid - 1]; return { productId: pid, name: p.name, quantity: qty, unitPaise: toPaise(p.price), taxRate: CATEGORIES[p.cat][1] }; });
    const subtotal = lines.reduce((a, l) => a + l.quantity * l.unitPaise, 0) / 100;
    const discAmt = o.discAmt !== undefined ? o.discAmt : o.discPct ? Math.max(1, Math.round((subtotal * o.discPct) / 100)) : 0;
    o.bill = computeBill(lines, discAmt > 0 ? { type: 'amount', value: discAmt } : null);
    return o.bill;
  };

  function makeOrder(date, minute, sec, cum, empOverride) {
    const emp = empOverride || pickEmployee();
    const lines = new Map();
    const k = Math.min(8, 1 + poisson(meanItems - 1));
    for (let i = 0; i < k; i += 1) {
      const p = drawProduct(cum);
      const qty = rng() < 0.2 ? 2 : rng() < 0.05 && p.price < 60 ? 3 : 1;
      lines.set(p.id, (lines.get(p.id) || 0) + qty);
    }
    const r = rng();
    const o = { date, minute, sec, emp: emp.id, empRef: emp, cust: null, lines, pay: r < 0.52 ? 'upi' : r < 0.82 ? 'cash' : 'card', status: 'completed', discPct: 0, approvedBy: null };
    if (emp.disc && rng() < emp.disc[0]) o.discPct = rand(emp.disc[1], emp.disc[2]);
    return o;
  }

  // Greedy tuner: nudges quantities until the total of `orders` is within tolerance of `target`
  function tuneTotal(orders, target, cum, tolerance = 0.002) {
    let total = orders.reduce((a, o) => a + priceOrder(o).total, 0);
    for (let iter = 0; iter < 6000; iter += 1) {
      const diff = target - total;
      if (Math.abs(diff) <= target * tolerance) break;
      const o = pick(orders);
      const before = o.bill.total;
      if (diff > 0) {
        let p = drawProduct(cum);
        for (let t = 0; t < 8 && p.price * (1 + CATEGORIES[p.cat][1] / 100) > Math.max(diff, 12); t += 1) p = drawProduct(cum);
        if (p.price * (1 + CATEGORIES[p.cat][1] / 100) > diff * 1.5) p = products.reduce((a, b) => (a.price < b.price ? a : b));
        o.lines.set(p.id, (o.lines.get(p.id) || 0) + 1);
      } else {
        const units = [...o.lines.values()].reduce((a, b) => a + b, 0);
        if (units <= 1) continue;
        const pid = pick([...o.lines.keys()]);
        const q = o.lines.get(pid);
        if (q <= 1) o.lines.delete(pid); else o.lines.set(pid, q - 1);
      }
      total += priceOrder(o).total - before;
    }
    return total;
  }

  // ---------- generate orders ----------
  log('Generating sales history…');
  const orders = [];
  const nowMin = now.minutes;
  const fracNow = hourShareBefore(nowMin);
  const yesterdayCompleted = TARGET_YESTERDAY_ORDERS; // yesterday is generated only up to the current clock time, so same-time comparisons are fair

  const custPickers = new Map();
  const assignCustomer = (o, d) => {
    if (rng() >= 0.045) return;
    if (!custPickers.has(d)) {
      const el = custEligible(d).filter((c) => c.type !== 'special');
      let c = 0;
      custPickers.set(d, { el, cum: el.map((x) => (c += custWeight[x.type])) });
    }
    const { el, cum } = custPickers.get(d);
    const u = rng() * cum[cum.length - 1];
    o.cust = el[cum.findIndex((x) => u <= x)].id;
  };

  for (let d = HISTORY_DAYS; d >= 1; d -= 1) {
    const date = dayDate(d);
    const cum = dayWeights(d);
    let n;
    if (d === 1) n = Math.round(yesterdayCompleted / 0.985);
    else n = Math.round((300 - 0.9 * Math.max(0, d - 7)) * DOW_FACTOR[dowOf(date)] * lognoise(0.05));
    for (let i = 0; i < n; i += 1) {
      const o = makeOrder(date, sampleMinute(d === 1 ? nowMin : null), randInt(0, 59), cum);
      assignCustomer(o, d);
      const priced = priceOrder(o);
      const s = o.empRef;
      if (rng() < (s.refund ?? 0.008) && priced.total <= 300 && s.role === 'cashier') o.status = 'refunded';
      else if (rng() < (s.cancel ?? 0.007)) o.status = 'cancelled';
      orders.push(o);
    }
  }

  // Today: exactly TARGET_TODAY_ORDERS completed orders (including the 2 special completed sales below)
  const todayCum = dayWeights(0);
  const rahul = staff[staffId('Rahul Verma') - 1];
  const kiran = staff[staffId('Kiran Patel') - 1];
  const imran = staff[staffId('Imran Khan') - 1];
  const recentMin = (back) => Math.max(1, nowMin - back);
  const mk = (empRef, min, lines, extra) => {
    const o = { date: today, minute: min, sec: randInt(0, 59), emp: empRef.id, empRef, cust: null, lines: new Map(lines.map(([n, q]) => [byName(n).id, q])), pay: 'cash', status: 'completed', discPct: 0, approvedBy: null, special: true, ...extra };
    priceOrder(o);
    return o;
  };
  const specials = [
    // 1) Rahul: 65% discount on a bulk bill, no approval recorded
    mk(rahul, recentMin(25), [['Basmati Rice 5kg', 2], ['Ghee 500ml', 2], ['Cumin Seeds 100g', 1], ['Turmeric Powder 200g', 1], ['Sugar 1kg', 1]], { discAmt: 1200, pay: 'upi' }),
    // 2) Kiran: large bill fully refunded
    mk(kiran, recentMin(55), [['Detergent Powder 1kg', 4], ['Floor Cleaner 1L', 3], ['Dishwash Liquid 500ml', 4], ['Toilet Cleaner 500ml', 3], ['Garbage Bags 30 Pack', 3], ['Tissue Box 100 Pulls', 4]], { status: 'refunded', pay: 'card' }),
    // 3) Imran: 21% discount, above the cashier limit, no approval
    mk(imran, recentMin(12), [['Tea Powder 500g', 1], ['Toor Dal 1kg', 1], ['Salt 1kg', 1]], { discAmt: 90, pay: 'cash' }),
  ];
  const specialCompletedRevenue = specials.filter((s) => s.status === 'completed').reduce((a, s) => a + s.bill.total, 0);

  const todayNormal = [];
  const ordinaryToday = TARGET_TODAY_ORDERS - specials.filter((s) => s.status === 'completed').length;
  for (let i = 0; i < ordinaryToday; i += 1) {
    const o = makeOrder(today, sampleMinute(nowMin), randInt(0, 59), todayCum);
    assignCustomer(o, 0);
    todayNormal.push(o);
  }
  tuneTotal(todayNormal, TARGET_TODAY_REVENUE - specialCompletedRevenue, todayCum);
  // A few extra non-completed bills today (not counted in orders/revenue)
  const extras = [];
  for (let i = 0; i < 4; i += 1) {
    const o = makeOrder(today, sampleMinute(nowMin), randInt(0, 59), todayCum, [staff[2], staff[5], staff[6], staff[7]][i]);
    o.status = i === 3 ? 'refunded' : 'cancelled';
    o.discPct = 0;
    if (i === 3) { o.lines = new Map([[byName('Cola 750ml').id, 2]]); }
    priceOrder(o);
    extras.push(o);
  }
  orders.push(...todayNormal, ...specials, ...extras);

  // Kavya: 17 snack-loving orders totalling about ₹8,450
  const snackProducts = products.filter((p) => p.cat === 3 || p.cat === 10);
  const snackCum = (() => { let c = 0; return products.map((p) => (c += snackProducts.includes(p) ? Math.max(p.perDay, 0.5) : 0.0001)); })();
  const kavyaDays = new Set();
  while (kavyaDays.size < 17) kavyaDays.add(randInt(2, 60));
  const kavyaOrders = [...kavyaDays].map((d) => {
    const o = makeOrder(dayDate(d), sampleMinute(null), randInt(0, 59), snackCum, staff[2 + randInt(0, 5)]);
    o.cust = kavya.id;
    o.discPct = 0;
    o.status = 'completed';
    return o;
  });
  tuneTotal(kavyaOrders, 8450, snackCum, 0.004);
  orders.push(...kavyaOrders);

  // ---------- order -> rows ----------
  orders.forEach((o) => { if (!o.bill) priceOrder(o); });
  orders.sort((a, b) => (a.date + hhmmss(a.minute, a.sec)).localeCompare(b.date + hhmmss(b.minute, b.sec)));
  orders.forEach((o, i) => { o.id = i + 1; });

  // customer created_at = day before first purchase
  const firstBy = new Map();
  orders.forEach((o) => { if (o.cust && !firstBy.has(o.cust)) firstBy.set(o.cust, o.date); });

  // ---------- stock ledger ----------
  const netSold = new Map(); // productId -> net units (completed sale units; refunds cancel out)
  const bucketNet = new Map(); // `${pid}:${b}` -> units
  orders.forEach((o) => {
    if (o.status === 'cancelled') return;
    const d = Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${o.date}T00:00:00Z`)) / 86400000);
    o.d = d;
    for (const [pid, q] of o.lines) {
      const net = o.status === 'completed' ? q : 0;
      netSold.set(pid, (netSold.get(pid) || 0) + net);
      if (d >= 1 && net) { const key = `${pid}:${Math.floor((d - 1) / 7)}`; bucketNet.set(key, (bucketNet.get(key) || 0) + net); }
    }
  });
  const movements = []; // [productId, type, qty, ref, 'YYYY-MM-DD HH:MM:SS']
  const restockedTotal = new Map();
  for (const p of products) {
    for (let b = 0; b <= 12; b += 1) {
      const net = bucketNet.get(`${p.id}:${b}`) || 0;
      const qty = Math.round(0.9 * net);
      if (qty <= 0) continue;
      movements.push([p.id, 'restock', qty, null, `${dayDate(Math.min(7 * b + 7, HISTORY_DAYS))} 06:00:00`]);
      restockedTotal.set(p.id, (restockedTotal.get(p.id) || 0) + qty);
    }
    const initial = p.stock - (restockedTotal.get(p.id) || 0) + (netSold.get(p.id) || 0);
    movements.push([p.id, 'initial', Math.max(initial, 0), null, `${dayDate(HISTORY_DAYS + 1)} 06:00:00`]);
    if (initial < 0) throw new Error(`Ledger would be negative for ${p.name}`);
  }
  orders.forEach((o) => {
    if (o.status === 'cancelled') return;
    const ts = `${o.date} ${hhmmss(o.minute, o.sec)}`;
    for (const [pid, q] of o.lines) {
      movements.push([pid, 'sale', -q, o.id, ts]);
      if (o.status === 'refunded') movements.push([pid, 'refund', q, o.id, ts]);
    }
  });

  // ---------- write to the database (single transaction, inside this business only) ----------
  log('Writing to the database…');
  await withSystemTransaction(async (client) => {
    // Remove this business's previous demo rows (row-level security limits every DELETE to this business).
    for (const t of ['value_ledger', 'action_outcomes', 'action_decisions', 'recommendation_log', 'anomaly_alerts', 'restock_orders', 'goods_receipt_items', 'goods_receipts', 'supplier_price_history', 'purchase_order_items', 'purchase_orders', 'supplier_products', 'product_cost_history', 'inventory_movements', 'cash_reconciliations', 'shifts', 'credit_ledger', 'held_bills', 'sale_return_refunds', 'sale_return_items', 'sale_returns', 'sale_payments', 'sale_items', 'sales', 'customers', 'products', 'suppliers', 'categories', 'settings']) {
      await client.query(`DELETE FROM ${t}`);
    }
    // Demo staff: keep existing accounts (audit history references them) and refresh their details.
    const uid = new Map();
    for (const st of staff) {
      const a = await client.query(
        `INSERT INTO accounts (name, email, password_hash) VALUES ($1,$2,$3)
         ON CONFLICT (lower(email)) WHERE deleted_at IS NULL DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash, is_active = TRUE, failed_logins = 0, locked_until = NULL
         RETURNING id`, [st.name, st.email, st.hash]);
      uid.set(st.id, a.rows[0].id);
      await client.query(
        `INSERT INTO memberships (business_id, account_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (business_id, account_id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE, deleted_at = NULL`, [businessId, a.rows[0].id, st.role]);
    }
    // Reserve id ranges so several businesses can be seeded into the same tables.
    const reserve = async (table, n) => {
      const seq = (await client.query('SELECT pg_get_serial_sequence($1, $2) AS s', [table, 'id'])).rows[0].s;
      const first = (await client.query('SELECT nextval($1::regclass)::int AS n', [seq])).rows[0].n;
      await client.query('SELECT setval($1::regclass, $2)', [seq, first + n - 1]);
      return first - 1; // offset
    };
    const offCat = await reserve('categories', CATEGORIES.length);
    const offSup = await reserve('suppliers', SUPPLIERS.length);
    const offProd = await reserve('products', products.length);
    const offCust = await reserve('customers', customers.length);
    const offSale = await reserve('sales', orders.length);
    const emp = (id) => (id == null ? null : uid.get(id));

    await client.query(`INSERT INTO categories (id, name, tax_rate) SELECT id + $4, name, tax FROM unnest($1::int[], $2::text[], $3::numeric[]) AS t(id, name, tax)`, [CATEGORIES.map((_, i) => i + 1), CATEGORIES.map((c) => c[0]), CATEGORIES.map((c) => c[1]), offCat]);
    await client.query(`INSERT INTO suppliers (id, name, phone, email, lead_time_days) SELECT id + $6, name, phone, email, lead FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::int[]) AS t(id, name, phone, email, lead)`, [SUPPLIERS.map((_, i) => i + 1), SUPPLIERS.map((x) => x[0]), SUPPLIERS.map((x) => x[1]), SUPPLIERS.map((x) => x[2]), SUPPLIERS.map((x) => x[3]), offSup]);
    await client.query(
      `INSERT INTO products (id, sku, name, category_id, purchase_price, selling_price, stock, minimum_stock, supplier_id, lead_time_days, expiry_date)
       SELECT id + $12, sku, name, cat + $13, pp, sp, stock, minst, sup + $14, lead, expiry FROM unnest($1::int[], $2::text[], $3::text[], $4::int[], $5::numeric[], $6::numeric[], $7::int[], $8::int[], $9::int[], $10::int[], $11::date[])
         AS t(id, sku, name, cat, pp, sp, stock, minst, sup, lead, expiry)`,
      [products.map((p) => p.id), products.map((p) => p.sku), products.map((p) => p.name), products.map((p) => p.cat + 1), products.map((p) => p.purchase), products.map((p) => p.price), products.map((p) => p.stock), products.map((p) => p.minStock), products.map((p) => p.sup + 1), products.map((p) => p.lead), products.map((p) => p.expiry), offProd, offCat, offSup],
    );
    await client.query(`INSERT INTO product_cost_history (product_id, cost, source) SELECT id + $3, pp, 'initial' FROM unnest($1::int[], $2::numeric[]) AS t(id, pp)`, [products.map((p) => p.id), products.map((p) => p.purchase), offProd]);
    await client.query(
      `INSERT INTO customers (id, name, phone, email, created_at)
       SELECT id + $7, name, phone, email, (ts::timestamp AT TIME ZONE $6) FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[]) AS t(id, name, phone, email, ts)`,
      [customers.map((c) => c.id), customers.map((c) => c.name), customers.map((c) => c.phone), customers.map((c) => c.email), customers.map((c) => `${addDays(firstBy.get(c.id) || addDays(today, -60), -1)} 09:00:00`), TZ, offCust],
    );

    const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
    for (const part of chunk(orders, 4000)) {
      await client.query(
        `INSERT INTO sales (id, invoice_no, customer_id, employee_id, subtotal, discount, tax, total, payment_method, status, refund_amount, discount_approved_by, created_at)
         SELECT id + $15, inv, cust + $16, emp, sub, disc, tax, total, pay, status, refund, appr, (ts::timestamp AT TIME ZONE $14)
           FROM unnest($1::int[], $2::text[], $3::int[], $4::int[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::text[], $10::text[], $11::numeric[], $12::int[], $13::text[])
             AS t(id, inv, cust, emp, sub, disc, tax, total, pay, status, refund, appr, ts)`,
        [
          part.map((o) => o.id), part.map((o) => `INV-${o.date.replace(/-/g, '')}-${String(o.id).padStart(5, '0')}`), part.map((o) => o.cust), part.map((o) => emp(o.emp)),
          part.map((o) => o.bill.subtotal), part.map((o) => o.bill.discount), part.map((o) => o.bill.tax), part.map((o) => o.bill.total), part.map((o) => o.pay), part.map((o) => o.status),
          part.map((o) => (o.status === 'refunded' ? o.bill.total : 0)), part.map((o) => emp(o.approvedBy)), part.map((o) => `${o.date} ${hhmmss(o.minute, o.sec)}`), TZ, offSale, offCust,
        ],
      );
    }
    await client.query(`UPDATE sales SET refunded_at = created_at WHERE status = 'refunded' AND refunded_at IS NULL`);   // demo refunds happen on the day of sale
    // Tender lines and (header-only) return records for the demo sales, so every report reads the same tables as for real data.
    await client.query(`INSERT INTO sale_payments (sale_id, method, amount, created_at) SELECT id, payment_method, total, created_at FROM sales WHERE total > 0`);
    await client.query(`INSERT INTO sale_returns (sale_id, total_refund, taxable_value, tax_amount, reason, completes_sale, is_legacy, created_at) SELECT id, refund_amount, refund_amount - tax, tax, 'other', TRUE, TRUE, refunded_at FROM sales WHERE status = 'refunded' AND refund_amount > 0`);
    await client.query(`INSERT INTO sale_return_refunds (return_id, method, amount) SELECT r.id, s.payment_method, r.total_refund FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE r.is_legacy`);
    const costOf = new Map(products.map((p) => [p.id, p.purchase]));   // demo cost is constant, so the snapshot equals the product cost
    const items = [];
    orders.forEach((o) => o.bill.items.forEach((it) => items.push([o.id + offSale, it.productId + offProd, it.quantity, it.unitPrice, it.lineTotal, costOf.get(it.productId), it.taxRate, it.discountShare, it.taxableValue, it.tax])));
    for (const part of chunk(items, 8000)) {
      await client.query(`INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, total, unit_cost, tax_rate, discount_share, taxable_value, tax_amount) SELECT * FROM unnest($1::int[], $2::int[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[])`, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => part.map((r) => r[k])));
    }
    await client.query(`UPDATE sale_items si SET returned_qty = si.quantity FROM sales s WHERE s.id = si.sale_id AND s.status = 'refunded'`);
    for (const part of chunk(movements, 8000)) {
      await client.query(
        `INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_id, created_at)
         SELECT pid + $7, typ, qty, ref + $8, (ts::timestamp AT TIME ZONE $6) FROM unnest($1::int[], $2::text[], $3::numeric[], $4::int[], $5::text[]) AS t(pid, typ, qty, ref, ts)`,
        [0, 1, 2, 3, 4].map((k) => part.map((r) => r[k])).concat([TZ, offProd, offSale]),
      );
    }
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('storeName', '"SharkMart Fresh"'::jsonb), ('storeAddress', '"12, MG Road, Bengaluru"'::jsonb), ('cashierMaxDiscountPct', '10'::jsonb)`,
    );
  }, businessId);

  // ---------- risk scoring over the whole history (rule-based) ----------
  log('Scoring transactions for risk…');
  return runAsTenant(businessId, async () => {
    invalidateAll();
    await evaluateSales((t, p) => query(t, p), { sinceDays: HISTORY_DAYS + 2 });
    // Older flagged sales count as already reviewed by the owner; only today's flags are open for the demo.
    await query("UPDATE anomaly_alerts SET status = 'reviewed' WHERE created_at < now() - interval '12 hours'");
    invalidateAll();

    const summary = (await query(
      `SELECT (SELECT COUNT(*)::int FROM products) AS products, (SELECT COUNT(*)::int FROM categories) AS categories, (SELECT COUNT(*)::int FROM suppliers) AS suppliers,
              (SELECT COUNT(*)::int FROM customers) AS customers, (SELECT COUNT(*)::int FROM users) AS employees, (SELECT COUNT(*)::int FROM sales) AS sales,
              (SELECT COUNT(*)::int FROM sale_items) AS sale_items, (SELECT COUNT(*)::int FROM inventory_movements) AS movements,
              (SELECT COUNT(*)::int FROM anomaly_alerts WHERE status = 'open') AS open_alerts`,
    )).rows[0];
    log(`Done: ${summary.sales} sales, ${summary.products} products, ${summary.open_alerts} open risk alerts.`);
    return summary;
  });
}

module.exports = { loadDemoData };
