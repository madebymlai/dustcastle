const test = require("node:test");
const assert = require("node:assert");
const isNumber = require("is-number");

test("is-number recognizes numbers (deps resolved offline from the Store)", () => {
  assert.strictEqual(isNumber(5), true);
  assert.strictEqual(isNumber("not a number"), false);
});
