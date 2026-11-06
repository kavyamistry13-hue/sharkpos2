// Units and quantity rules. Only measured units may hold fractions; counted units must be whole numbers.
// The same rule is enforced in the database (CHECK constraints in migration 009).
const { z } = require('zod');
const { badRequest } = require('./errors');

const UNITS = ['pcs', 'kg', 'g', 'l', 'ml', 'm', 'pack', 'box', 'dozen'];
const DECIMAL_UNITS = new Set(['kg', 'g', 'l', 'ml', 'm']);

const isDecimalUnit = (unit) => DECIMAL_UNITS.has(unit);
const round3 = (n) => Math.round(n * 1000) / 1000;
const hasAtMost3Decimals = (n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;

/** Zod schema for a quantity: positive, at most 3 decimals. Whether decimals are allowed depends on the product's unit (assertQuantity). */
const quantitySchema = z.coerce.number().positive('Quantity must be more than zero.').max(1e6).refine(hasAtMost3Decimals, 'Use at most 3 decimal places.');
/** Same but zero is allowed (stock levels, minimum stock). */
const stockSchema = z.coerce.number().min(0).max(1e6).refine(hasAtMost3Decimals, 'Use at most 3 decimal places.');

/** Throws 400 when a fractional quantity is used with a unit that is counted in whole numbers. */
function assertQuantity(unit, qty, label = 'Quantity', name = '') {
  if (!isDecimalUnit(unit) && !Number.isInteger(qty)) {
    throw badRequest(`${label}${name ? ` for ${name}` : ''} must be a whole number because it is sold in ${unit}.`);
  }
  return qty;
}

module.exports = { UNITS, DECIMAL_UNITS, isDecimalUnit, round3, quantitySchema, stockSchema, assertQuantity };
