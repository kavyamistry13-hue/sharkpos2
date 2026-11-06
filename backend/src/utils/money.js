// All billing arithmetic is done in integer paise to avoid floating-point drift.
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const fromPaise = (paise) => paise / 100;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

module.exports = { toPaise, fromPaise, round2 };
