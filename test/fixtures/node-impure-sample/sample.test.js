const test = require("node:test");
const assert = require("node:assert");
const isNumber = require("is-number");

// Proves the real registry dependency installed (fetched through the egress
// proxy, which allowed registry.npmjs.org) and works.
test("is-number, installed from the registry through the egress proxy, works", () => {
  assert.strictEqual(isNumber(7), true);
  assert.strictEqual(isNumber("abc"), false);
});
