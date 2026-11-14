// Offline cart pricing (Phase 17B). There is NO pricing or tax logic here: it hands catalog rows to the SAME computeBill the API uses
// (shared/billing.mjs, one file for both sides). If the shop's tax rules ever change, they change in that one file.
import { computeBill, toPaise, fromPaise } from '../../../../shared/billing.mjs';

export { computeBill, toPaise, fromPaise };

/** [{productId, quantity}] + a Map of catalog products → the line objects computeBill expects (same fields services/sales.js builds). */
export function billLinesFor(cart, byId) {
  return cart.map((c) => {
    const p = byId.get(c.productId);
    if (!p) throw new Error(`Product ${c.productId} is not in the offline catalog.`);
    return { productId: p.id, name: p.name, quantity: c.quantity, unitPaise: toPaise(p.price), taxRate: p.taxRate, priceIncludesTax: p.priceIncludesTax, unit: p.unit };
  });
}
/** The bill for an offline cart. `bill.total` (rupees) × 100 is the `expectedTotal` (paise) sent with the sale. */
export const priceCart = (cart, byId, discount = null) => computeBill(billLinesFor(cart, byId), discount);
export const totalPaise = (bill) => toPaise(bill.total);
