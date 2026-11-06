// Deterministic billing engine. No AI, no floating-point money: everything is integer paise.
const { toPaise, fromPaise } = require('../utils/money');

/**
 * Pure pricing function.
 * @param lines  [{ productId, name, quantity, unitPaise, taxRate }]  (taxRate in percent, e.g. 5 or 12.5)
 * @param discount  { type: 'amount' | 'percent', value: number } | null
 * Discount is allocated across lines proportionally (largest-remainder), tax is applied to the
 * discounted line value, and every rounding is half-up on integer paise.
 */
function computeBill(lines, discount) {
  const lineTotals = lines.map((l) => l.quantity * l.unitPaise);
  const subtotal = lineTotals.reduce((a, b) => a + b, 0);

  let discountPaise = 0;
  if (discount && discount.value > 0) {
    discountPaise =
      discount.type === 'percent'
        ? Math.round((subtotal * Math.round(discount.value * 100)) / 10000)
        : toPaise(discount.value);
  }
  discountPaise = Math.min(Math.max(discountPaise, 0), subtotal);

  // Largest-remainder allocation of the discount across lines.
  const allocations = lineTotals.map((t) => (subtotal === 0 ? 0 : Math.floor((discountPaise * t) / subtotal)));
  let remainder = discountPaise - allocations.reduce((a, b) => a + b, 0);
  const order = lineTotals
    .map((t, i) => ({ i, frac: subtotal === 0 ? 0 : (discountPaise * t) % subtotal }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k += 1, remainder -= 1) allocations[order[k].i] += 1;

  let taxPaise = 0;
  const detailed = lines.map((l, i) => {
    const taxable = lineTotals[i] - allocations[i];
    const lineTax = Math.round((taxable * Math.round(l.taxRate * 100)) / 10000);
    taxPaise += lineTax;
    return {
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      unitPrice: fromPaise(l.unitPaise),
      lineTotal: fromPaise(lineTotals[i]),
      discountShare: fromPaise(allocations[i]),
      taxRate: l.taxRate,
      tax: fromPaise(lineTax),
    };
  });

  const totalPaise = subtotal - discountPaise + taxPaise;
  return {
    items: detailed,
    subtotal: fromPaise(subtotal),
    discount: fromPaise(discountPaise),
    discountPct: subtotal === 0 ? 0 : Math.round((discountPaise / subtotal) * 10000) / 100,
    tax: fromPaise(taxPaise),
    total: fromPaise(totalPaise),
    itemCount: lines.reduce((a, l) => a + l.quantity, 0),
  };
}

module.exports = { computeBill };
