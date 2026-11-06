// Deterministic billing engine. No AI, no floating-point money: everything is integer paise (quantities may have up to 3 decimals).
const { toPaise, fromPaise } = require('../utils/money');

/**
 * Pure pricing function.
 * @param lines  [{ productId, name, quantity, unitPaise, taxRate, priceIncludesTax? }]  (taxRate in percent, e.g. 5 or 12.5; quantity may be fractional)
 * @param discount  { type: 'amount' | 'percent', value: number } | null
 * Discount is allocated across lines proportionally (largest-remainder). Then, per line:
 *   - tax added on top (default):  tax = taxable * rate; payable = taxable + tax        (selling price is before tax)
 *   - tax inclusive (MRP style):   tax = payable * rate / (100 + rate); taxable = payable - tax   (selling price already contains tax)
 * Every rounding is half-up on integer paise. subtotal/discount/tax/total keep their old meaning for tax-on-top bills.
 */
function computeBill(lines, discount) {
  const lineTotals = lines.map((l) => Math.round(l.quantity * l.unitPaise));
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
  let taxIncludedPaise = 0;
  let totalPaise = 0;
  const detailed = lines.map((l, i) => {
    const afterDiscount = lineTotals[i] - allocations[i];
    const rateBp = Math.round(l.taxRate * 100);
    let lineTax;
    let taxable;
    let payable;
    if (l.priceIncludesTax) {
      lineTax = Math.round((afterDiscount * rateBp) / (10000 + rateBp));
      taxable = afterDiscount - lineTax;
      payable = afterDiscount;
      taxIncludedPaise += lineTax;
    } else {
      lineTax = Math.round((afterDiscount * rateBp) / 10000);
      taxable = afterDiscount;
      payable = afterDiscount + lineTax;
    }
    taxPaise += lineTax;
    totalPaise += payable;
    return {
      productId: l.productId,
      name: l.name,
      quantity: l.quantity,
      unitPrice: fromPaise(l.unitPaise),
      lineTotal: fromPaise(lineTotals[i]),
      discountShare: fromPaise(allocations[i]),
      taxRate: l.taxRate,
      priceIncludesTax: Boolean(l.priceIncludesTax),
      taxableValue: fromPaise(taxable),
      tax: fromPaise(lineTax),
    };
  });

  return {
    items: detailed,
    subtotal: fromPaise(subtotal),
    discount: fromPaise(discountPaise),
    discountPct: subtotal === 0 ? 0 : Math.round((discountPaise / subtotal) * 10000) / 100,
    tax: fromPaise(taxPaise),
    taxIncluded: fromPaise(taxIncludedPaise),   // part of `tax` that is already inside the shelf prices
    taxAdded: fromPaise(taxPaise - taxIncludedPaise),
    total: fromPaise(totalPaise),
    itemCount: lines.reduce((a, l) => a + l.quantity, 0),
  };
}

module.exports = { computeBill };
