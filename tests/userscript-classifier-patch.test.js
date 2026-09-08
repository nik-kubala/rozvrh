const test = require("node:test");
const assert = require("node:assert/strict");

// The userscript runtime reads window.ROZVRH_OPTIMIZER. Mirror that environment.
global.window = global;
global.ROZVRH_OPTIMIZER = require("../optimizer-core.js");
require("../scripts/userscript-classifier-patch.js");

test("English EDISON closed-registration message is classified correctly", () => {
  const result = global.ROZVRH_OPTIMIZER.classifyActivityResponse({
    payload: {
      errMsg: "Schedule unit cannot be entered: selection of schedule is not open for your current study relation now."
    },
    activityId: 328115,
    status: 200,
    contentType: "application/json"
  });

  assert.equal(result.code, "REGISTRATION_CLOSED");
  assert.equal(result.ok, false);
});
