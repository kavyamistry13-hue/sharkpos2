// Supplier directory + which supplier sells which product, and at what price. Suppliers are never hard-deleted (purchase history points at them).
const { query, withTransaction } = require('../db');
const { badRequest, conflict, notFound } = require('../utils/errors');
const { invalidateAll } = require('../utils/cache');

const map = (r) => ({
  id: r.id, name: r.name, phone: r.phone, email: r.email, contactPerson: r.contact_person, address: r.address, gstin: r.gstin,
  leadTimeDays: r.lead_time_days, paymentTermsDays: r.payment_terms_days, minOrderValue: r.min_order_value, notes: r.notes, isActive: r.is_active,
  products: r.products ?? undefined, openOrders: r.open_orders ?? undefined, createdAt: r.created_at,
});

const COLS = 's.id, s.name, s.phone, s.email, s.contact_person, s.address, s.gstin, s.lead_time_days, s.payment_terms_days, s.min_order_value, s.notes, s.is_active, s.created_at';

async function listSuppliers({ q, includeInactive = false } = {}) {
  const params = [];
  const where = [];
  if (!includeInactive) where.push('s.is_active');
  if (q) { params.push(`%${q}%`); where.push(`(s.name ILIKE $${params.length} OR s.phone ILIKE $${params.length} OR s.contact_person ILIKE $${params.length})`); }
  const res = await query(
    `SELECT ${COLS},
            (SELECT COUNT(*)::int FROM supplier_products sp WHERE sp.supplier_id = s.id) AS products,
            (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('draft','ordered','partially_received')) AS open_orders
       FROM suppliers s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.is_active DESC, lower(s.name)`,
    params,
  );
  return res.rows.map(map);
}

async function getSupplier(id) {
  const res = await query(
    `SELECT ${COLS},
            (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('draft','ordered','partially_received')) AS open_orders
       FROM suppliers s WHERE s.id = $1`,
    [id],
  );
  if (!res.rowCount) throw notFound('Supplier not found.');
  const prods = await query(
    `SELECT sp.product_id, p.name, p.sku, p.unit, sp.supplier_sku, sp.pack_size, sp.min_order_qty, sp.lead_time_days, sp.last_cost, sp.is_preferred
       FROM supplier_products sp JOIN products p ON p.id = sp.product_id WHERE sp.supplier_id = $1 ORDER BY lower(p.name)`,
    [id],
  );
  return {
    ...map(res.rows[0]),
    products: prods.rows.map((r) => ({
      productId: r.product_id, name: r.name, sku: r.sku, unit: r.unit, supplierSku: r.supplier_sku, packSize: r.pack_size, minOrderQty: r.min_order_qty,
      leadTimeDays: r.lead_time_days, lastCost: r.last_cost, isPreferred: r.is_preferred,
    })),
  };
}

async function createSupplier(i) {
  const res = await query(
    `INSERT INTO suppliers (name, phone, email, contact_person, address, gstin, lead_time_days, payment_terms_days, min_order_value, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [i.name, i.phone || null, i.email || null, i.contactPerson || null, i.address || null, i.gstin || null, i.leadTimeDays ?? 3, i.paymentTermsDays ?? 0, i.minOrderValue ?? 0, i.notes || null],
  );
  invalidateAll();
  return getSupplier(res.rows[0].id);
}

const FIELDS = { name: 'name', phone: 'phone', email: 'email', contactPerson: 'contact_person', address: 'address', gstin: 'gstin', leadTimeDays: 'lead_time_days', paymentTermsDays: 'payment_terms_days', minOrderValue: 'min_order_value', notes: 'notes', isActive: 'is_active' };

async function updateSupplier(id, input) {
  const before = await getSupplier(id);
  if (input.isActive === false && before.openOrders > 0) {
    throw conflict(`${before.name} has ${before.openOrders} open purchase order${before.openOrders === 1 ? '' : 's'}. Finish or cancel them first.`, { code: 'SUPPLIER_HAS_OPEN_ORDERS' });
  }
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(FIELDS)) {
    if (input[k] !== undefined) { params.push(input[k] === '' ? null : input[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (!sets.length) throw badRequest('Nothing to update.');
  params.push(id);
  await query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  invalidateAll();
  return { before, after: await getSupplier(id) };
}

/** Create or update the supplier–product relationship. A new cost is also written to the price history. */
async function setSupplierProduct(supplierId, productId, input, userId) {
  const out = await withTransaction(async (client) => {
    const sup = (await client.query('SELECT id, lead_time_days FROM suppliers WHERE id = $1', [supplierId])).rows[0];
    if (!sup) throw notFound('Supplier not found.');
    const prod = (await client.query('SELECT id, unit FROM products WHERE id = $1 AND is_active', [productId])).rows[0];
    if (!prod) throw notFound('Product not found.');
    const cur = (await client.query('SELECT * FROM supplier_products WHERE supplier_id = $1 AND product_id = $2 FOR UPDATE', [supplierId, productId])).rows[0];
    const v = {
      supplier_sku: input.supplierSku !== undefined ? input.supplierSku || null : cur ? cur.supplier_sku : null,
      pack_size: input.packSize ?? (cur ? cur.pack_size : 1),
      min_order_qty: input.minOrderQty ?? (cur ? cur.min_order_qty : 1),
      lead_time_days: input.leadTimeDays !== undefined ? input.leadTimeDays : cur ? cur.lead_time_days : null,
      last_cost: input.lastCost !== undefined ? input.lastCost : cur ? cur.last_cost : null,
      is_preferred: input.isPreferred ?? (cur ? cur.is_preferred : false),
    };
    if (v.is_preferred) await client.query('UPDATE supplier_products SET is_preferred = FALSE WHERE product_id = $1 AND supplier_id <> $2 AND is_preferred', [productId, supplierId]);
    if (cur) {
      await client.query(
        `UPDATE supplier_products SET supplier_sku=$1, pack_size=$2, min_order_qty=$3, lead_time_days=$4, last_cost=$5, is_preferred=$6 WHERE id = $7`,
        [v.supplier_sku, v.pack_size, v.min_order_qty, v.lead_time_days, v.last_cost, v.is_preferred, cur.id],
      );
    } else {
      await client.query(
        `INSERT INTO supplier_products (supplier_id, product_id, supplier_sku, pack_size, min_order_qty, lead_time_days, last_cost, is_preferred) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [supplierId, productId, v.supplier_sku, v.pack_size, v.min_order_qty, v.lead_time_days, v.last_cost, v.is_preferred],
      );
    }
    if (input.lastCost !== undefined && input.lastCost !== null && (!cur || Number(cur.last_cost) !== Number(input.lastCost))) {
      await client.query(`INSERT INTO supplier_price_history (supplier_id, product_id, unit_cost, source, created_by) VALUES ($1,$2,$3,'manual',$4)`, [supplierId, productId, input.lastCost, userId]);
    }
    // The preferred supplier is the product's main supplier (the one its reorder lead time and "supplier" column refer to).
    if (v.is_preferred) {
      await client.query('UPDATE products SET supplier_id = $1, lead_time_days = $2 WHERE id = $3', [supplierId, v.lead_time_days ?? sup.lead_time_days, productId]);
    }
    return { created: !cur };
  });
  invalidateAll();
  return out;
}

async function removeSupplierProduct(supplierId, productId) {
  const res = await query('DELETE FROM supplier_products WHERE supplier_id = $1 AND product_id = $2 RETURNING id', [supplierId, productId]);
  if (!res.rowCount) throw notFound('This supplier does not have that product.');
}

async function getPriceHistory(supplierId, productId, limit = 100) {
  if (!(await query('SELECT 1 FROM suppliers WHERE id = $1', [supplierId])).rowCount) throw notFound('Supplier not found.');
  const params = [supplierId, limit];
  let extra = '';
  if (productId) { params.push(productId); extra = 'AND h.product_id = $3'; }
  const res = await query(
    `SELECT h.id, h.product_id, p.name AS product, h.unit_cost, h.recorded_at, h.source, h.purchase_order_id, po.po_number
       FROM supplier_price_history h JOIN products p ON p.id = h.product_id LEFT JOIN purchase_orders po ON po.id = h.purchase_order_id
      WHERE h.supplier_id = $1 ${extra} ORDER BY h.recorded_at DESC, h.id DESC LIMIT $2`,
    params,
  );
  return res.rows.map((r) => ({ id: r.id, productId: r.product_id, product: r.product, unitCost: r.unit_cost, recordedAt: r.recorded_at, source: r.source, purchaseOrderId: r.purchase_order_id, poNumber: r.po_number }));
}

module.exports = { listSuppliers, getSupplier, createSupplier, updateSupplier, setSupplierProduct, removeSupplierProduct, getPriceHistory };
