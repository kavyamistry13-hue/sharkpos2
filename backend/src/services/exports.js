// CSV exports (Phase 9). Local, free, tenant-isolated (every query runs under the caller's forced RLS) and authorised by the route.
// Each export is an explicit ALLOWLIST of columns — no SELECT *, so password hashes, tokens, sessions, secrets and internal ids never leave.
const { query } = require('../db');
const { getProductStats } = require('./forecast');
const csv = require('../utils/csv');

const CAP = 50000;       // hard row cap per export: bounded memory even for a very large shop
const d = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const KINDS = {
  products: {
    roles: ['business_owner', 'manager'],
    cols: [['sku', 'sku', 1], ['name', 'name', 1], ['barcode', 'barcode', 1], ['category', 'category', 1], ['unit', 'unit'], ['cost_price', 'cost_price'], ['selling_price', 'selling_price'], ['tax_rate', 'tax_rate'], ['stock', 'stock'], ['min_stock', 'min_stock'], ['reorder_level', 'reorder_level'], ['max_stock', 'max_stock'], ['supplier', 'supplier', 1], ['track_batches', 'track_batches'], ['expiry_date', 'expiry_date'], ['active', 'active']],
    async rows() {
      return (await query(
        `SELECT p.sku, p.name, (SELECT b.barcode FROM product_barcodes b WHERE b.product_id = p.id ORDER BY b.is_primary DESC, b.id LIMIT 1) AS barcode, c.name AS category, p.unit,
                p.purchase_price AS cost_price, p.selling_price, c.tax_rate, p.stock, p.minimum_stock AS min_stock, p.reorder_level, p.max_stock, s.name AS supplier, p.track_batches, p.expiry_date, p.is_active AS active
           FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN suppliers s ON s.id = p.supplier_id ORDER BY p.name LIMIT ${CAP}`)).rows.map((r) => ({ ...r, expiry_date: d(r.expiry_date) }));
    },
  },
  inventory: {
    roles: ['business_owner', 'manager'],
    cols: [['sku', 'sku', 1], ['name', 'name', 1], ['category', 'category', 1], ['unit', 'unit'], ['stock', 'stock'], ['min_stock', 'min_stock'], ['reorder_level', 'reorder_level'], ['max_stock', 'max_stock'], ['needs_reorder', 'needs_reorder'], ['suggested_reorder_qty', 'suggested_reorder_qty'], ['cost_value', 'cost_value'], ['selling_value', 'selling_value'], ['stock_status', 'stock_status'], ['expiry_status', 'expiry_status'], ['supplier', 'supplier', 1]],
    async rows() {
      return (await getProductStats()).slice(0, CAP).map((p) => ({
        sku: p.sku, name: p.name, category: p.category, unit: p.unit, stock: p.stock, min_stock: p.minimumStock, reorder_level: p.reorderLevel, max_stock: p.maxStock, needs_reorder: p.needsReorder,
        suggested_reorder_qty: p.suggestedReorderQty, cost_value: p.stockValue, selling_value: Math.round(p.stock * p.sellingPrice * 100) / 100, stock_status: p.stockStatus, expiry_status: p.expiryStatus || '', supplier: p.supplier || '',
      }));
    },
  },
  sales: {
    roles: ['business_owner'],                      // money + customer names: owner only
    cols: [['invoice_no', 'invoice_no', 1], ['date', 'date'], ['status', 'status'], ['payment_method', 'payment_method'], ['customer', 'customer', 1], ['cashier', 'cashier', 1], ['subtotal', 'subtotal'], ['discount', 'discount'], ['tax', 'tax'], ['total', 'total'], ['refund_amount', 'refund_amount']],
    async rows() {
      return (await query(
        `SELECT s.invoice_no, s.created_at AS date, s.status, s.payment_method, c.name AS customer, a.name AS cashier, s.subtotal, s.discount, s.tax, s.total, s.refund_amount
           FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN accounts a ON a.id = s.employee_id ORDER BY s.id DESC LIMIT ${CAP}`)).rows;
    },
  },
  purchases: {
    roles: ['business_owner', 'manager'],
    cols: [['po_number', 'po_number', 1], ['supplier', 'supplier', 1], ['status', 'status'], ['order_date', 'order_date'], ['expected_date', 'expected_date'], ['ordered_value', 'ordered_value'], ['received_value', 'received_value']],
    async rows() {
      return (await query(
        `SELECT po.po_number, s.name AS supplier, po.status, po.order_date, po.expected_date,
                COALESCE(SUM(i.ordered_qty * i.unit_cost), 0) AS ordered_value, COALESCE(SUM(i.received_qty * i.unit_cost), 0) AS received_value
           FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN purchase_order_items i ON i.purchase_order_id = po.id
          GROUP BY po.id, s.name ORDER BY po.id DESC LIMIT ${CAP}`)).rows.map((r) => ({ ...r, order_date: d(r.order_date), expected_date: d(r.expected_date) }));
    },
  },
  suppliers: {
    roles: ['business_owner', 'manager'],
    cols: [['name', 'name', 1], ['contact_person', 'contact_person', 1], ['phone', 'phone'], ['email', 'email'], ['gstin', 'gstin'], ['lead_time_days', 'lead_time_days'], ['payment_terms_days', 'payment_terms_days'], ['active', 'active']],
    async rows() {
      return (await query(`SELECT name, contact_person, phone, email, gstin, lead_time_days, payment_terms_days, is_active AS active FROM suppliers ORDER BY name LIMIT ${CAP}`)).rows;
    },
  },
  customers: {
    roles: ['business_owner'],                      // personal data + Udhaar: owner only
    cols: [['name', 'name', 1], ['phone', 'phone'], ['email', 'email'], ['credit_limit', 'credit_limit'], ['udhaar_balance', 'udhaar_balance']],
    async rows() {
      return (await query(
        `SELECT c.name, c.phone, c.email, c.credit_limit, COALESCE(SUM(l.amount * l.effect), 0) AS udhaar_balance
           FROM customers c LEFT JOIN credit_ledger l ON l.customer_id = c.id GROUP BY c.id ORDER BY c.name LIMIT ${CAP}`)).rows;
    },
  },
};

async function build(kind) {
  const k = KINDS[kind];
  const rows = await k.rows();
  return { csv: csv.toCsv(rows, k.cols.map(([key, header, text]) => ({ key, header, text: !!text }))), count: rows.length, capped: rows.length >= CAP };
}

module.exports = { KINDS, build };
