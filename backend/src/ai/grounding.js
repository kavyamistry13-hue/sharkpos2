// Guardrail: an LLM answer is only shown if every number in it can be found in the facts we gave it.
const numbersIn = (text) =>
  (String(text).match(/\d[\d,]*\.?\d*/g) || [])
    .map((s) => parseFloat(s.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));

function collectNumbers(value, out = new Set()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(value);
    out.add(Math.round(value));
    out.add(Math.round(value * 10) / 10);
    out.add(Math.abs(value));
    out.add(Math.abs(Math.round(value)));
  } else if (typeof value === 'string') {
    numbersIn(value).forEach((n) => out.add(n));
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectNumbers(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectNumbers(v, out));
  }
  return out;
}

/** True when all numbers >= 11 in `text` are present in `facts` (small numbers are list indices / ordinals). */
function isGrounded(text, facts) {
  const allowed = collectNumbers(facts);
  return numbersIn(text).every((n) => n <= 10 || allowed.has(n) || allowed.has(Math.round(n)));
}

module.exports = { isGrounded, numbersIn };
