const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../optimizer-core.js");

const context = vm.createContext({ window: { ROZVRH_OPTIMIZER: core } });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../scripts/userscript-teacher-preferences.js"), "utf8"), context, { filename: "userscript-teacher-preferences.js" });

function makeOptimizer(teacherPreferences) {
  const data = {
    slots: ["09:00-10:30"],
    subjects: [{
      id: "logic",
      code: "460205103",
      short: "ULM",
      name: "Úvod do logického myšlení",
      sessions: [
        { id: "logic-bad", type: "C", group: "C/01", day: 0, slot: 0 },
        { id: "logic-neutral", type: "C", group: "C/02", day: 0, slot: 0 },
        { id: "logic-good", type: "C", group: "C/03", day: 0, slot: 0 }
      ]
    }],
    templates: [{ id: "a-compact", sessionIds: ["logic-bad"] }]
  };
  const fixedPlans = {
    subjects: ["logic"],
    plans: [["A001", "A", 0, [[0, 0]]]]
  };
  const preferences = {
    consensusRatings: { A001: 1 },
    hardRejectAt: 5,
    subjectImportance: { logic: 30 },
    teacherPreferences,
    lectureRequirements: [],
    slotPenalty: [0],
    thursdaySlotPenalty: [0],
    rules: { concurrencyLimit: 1 }
  };
  return context.window.ROZVRH_OPTIMIZER.createOptimizer({ data, fixedPlans, preferences });
}

function live(teachers) {
  return [
    [101, "C/01", teachers.bad],
    [102, "C/02", teachers.neutral],
    [103, "C/03", teachers.good]
  ].map(([concreteActivityId, group, teacherShortNamesString]) => ({
    concreteActivityId,
    concreteActivityCode: `460205103${group}`,
    subjectVersionScheduleCode: "460205103",
    weekDayTitle: "Pondělí",
    scheduleWindowBeginTime: "09:00:00",
    concreteActivityCapacity: 21,
    studentsCount: 0,
    hasFreePlaces: true,
    hasCollision: false,
    selected: false,
    lecture: false,
    practise: true,
    teacherShortNamesString,
    teacherShortNamesAbbrev: teacherShortNamesString
  }));
}

test("preferovaný učiteľ vyhrá iba medzi cvičeniami v tom istom čase", () => {
  const optimizer = makeOptimizer({ preferred: ["M. Menšík"], lastChoice: ["M. Běhálek"] });
  const result = optimizer.analyze({ liveActivities: live({ bad: "M. Běhálek", neutral: "T. Stehlík", good: "M. Menšík" }) });
  assert.equal(result.priorities[0].coord.day, 0);
  assert.equal(result.priorities[0].coord.slot, 0);
  assert.equal(result.priorities[0].activity.teacherShortNamesString, "M. Menšík");
  assert.equal(result.priorities[0].activity.localSessionId, "logic-good");
});

test("M. Běhálek je posledná voľba, ale ostáva fallback keď nič iné nie je", () => {
  const optimizer = makeOptimizer({ preferred: [], lastChoice: ["M. Běhálek"] });
  let result = optimizer.analyze({ liveActivities: live({ bad: "M. Běhálek", neutral: "T. Stehlík", good: "T. Stehlík" }) });
  assert.notEqual(result.priorities[0].activity.teacherShortNamesString, "M. Běhálek");

  result = optimizer.analyze({
    liveActivities: live({ bad: "M. Běhálek", neutral: "T. Stehlík", good: "T. Stehlík" }).map((activity) =>
      activity.teacherShortNamesString === "M. Běhálek" ? activity : { ...activity, hasFreePlaces: false, studentsCount: 21 }
    )
  });
  assert.equal(result.priorities[0].activity.teacherShortNamesString, "M. Běhálek");
});
