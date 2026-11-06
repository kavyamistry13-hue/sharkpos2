// Guard shared by every database script: SHARKPOS 2 may only ever touch databases named "sharkpos2*".
function assertSafeTarget(connectionString) {
  const name = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  if (!/^sharkpos2/.test(name)) {
    throw new Error(`Refusing to run: target database is "${name}", not a SHARKPOS 2 database (name must start with "sharkpos2").`);
  }
  return name;
}
module.exports = { assertSafeTarget };
