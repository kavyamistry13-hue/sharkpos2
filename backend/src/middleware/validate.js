const { badRequest } = require('../utils/errors');
require('../utils/zodCompat');   // keeps the Zod 3 wording of validation messages

/** validate({ body, query, params }) with zod schemas. Replaces req.* with the parsed value. */
const validate = (schemas) => (req, _res, next) => {
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      }));
      const first = details[0];
      const msg = first ? `Invalid input: ${first.field ? first.field + ' — ' : ''}${first.message}` : 'Invalid input';
      return next(badRequest(msg, details));
    }
    // req.query is a getter in newer Express versions; define instead of assign.
    Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
  }
  return next();
};

module.exports = validate;
