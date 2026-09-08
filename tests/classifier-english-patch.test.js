const test = require("node:test");
const assert = require("node:assert/strict");

require("../optimizer-core.js");
require("../scripts/userscript-classifier-patch.js");

const core = globalThis.ROZVRH_OPTIMIZER;

function classify(errMsg) {
  return core.classifyActivityResponse({
    payload: { errMsg },
    activityId: 42,
    status: 200,
    contentType: "application/json"
  }).code;
}

test("English EDISON closed-registration message maps to REGISTRATION_CLOSED", () => {
  assert.equal(
    classify("Schedule unit cannot be entered: selection of schedule is not open for your current study relation now."),
    "REGISTRATION_CLOSED"
  );
});

test("English capacity/conflict/auth messages keep stable error types", () => {
  assert.equal(classify("Schedule unit cannot be entered: capacity is full."), "FULL");
  assert.equal(classify("Schedule unit cannot be entered because of a collision with another activity."), "COLLISION");
  assert.equal(classify("Your session has expired. Please log in."), "AUTH_EXPIRED");
});
