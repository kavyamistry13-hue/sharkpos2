// Zod 4 compatibility. Zod 4 reworded its default error messages; the web app shows these messages to people, so the Zod 3 wording is kept.
// Only the wording is mapped here. No validation rule is changed. Messages a schema sets itself (e.g. 'Use letters and numbers.') are untouched.
const { z } = require('zod');

const received = (v) => (v === undefined ? 'undefined' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isNaN(v) ? 'nan' : typeof v === 'bigint' ? 'bigint' : typeof v);
const q = (v) => (typeof v === 'string' ? `'${v}'` : JSON.stringify(v));

function legacyMessage(iss) {
  switch (iss.code) {
    case 'invalid_type':
      return iss.input === undefined ? 'Required' : `Expected ${iss.expected}, received ${received(iss.input)}`;
    case 'too_small': {
      const n = String(iss.minimum);
      if (iss.origin === 'string') return `String must contain ${iss.inclusive ? 'at least' : 'over'} ${n} character(s)`;
      if (iss.origin === 'array' || iss.origin === 'set') return `${iss.origin === 'set' ? 'Set' : 'Array'} must contain ${iss.inclusive ? 'at least' : 'more than'} ${n} element(s)`;
      return `Number must be ${iss.inclusive ? 'greater than or equal to' : 'greater than'} ${n}`;
    }
    case 'too_big': {
      const n = String(iss.maximum);
      if (iss.origin === 'string') return `String must contain ${iss.inclusive ? 'at most' : 'under'} ${n} character(s)`;
      if (iss.origin === 'array' || iss.origin === 'set') return `${iss.origin === 'set' ? 'Set' : 'Array'} must contain ${iss.inclusive ? 'at most' : 'fewer than'} ${n} element(s)`;
      return `Number must be ${iss.inclusive ? 'less than or equal to' : 'less than'} ${n}`;
    }
    case 'invalid_value':
      return iss.values.length === 1 ? `Invalid literal value, expected ${JSON.stringify(iss.values[0])}` : `Invalid enum value. Expected ${iss.values.map(q).join(' | ')}, received ${q(iss.input)}`;
    case 'invalid_format':
      return iss.format === 'email' ? 'Invalid email' : 'Invalid';
    case 'not_multiple_of':
      return `Number must be a multiple of ${iss.divisor}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${iss.keys.map(q).join(', ')}`;
    case 'invalid_union':
      return 'Invalid input';
    default:
      return undefined;   // custom / refine messages and anything unmapped keep Zod's own text
  }
}

z.config({ customError: legacyMessage });
module.exports = { legacyMessage };
