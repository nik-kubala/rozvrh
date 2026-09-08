const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../optimizer-core.js");

const root = path.resolve(__dirname, "..");
const context = vm.createContext({ window: {} });
for (const file of ["data.js", "fixes.js", "fixed-plans.js", "preferences.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}

const data = context.window.ROZVRH_DATA;
const fixedPlans = context.window.ROZVRH_FIXED_PLANS;
const preferences = context.window.ROZVRH_PREFERENCES;
const optimizer = core.createOptimizer({ data, fixedPlans, preferences });

function makeLive() {
  let concreteActivityId = 100000;
  return data.subjects.flatMap((subject) => subject.sessions.map((session) => ({
    subjectVersionScheduleCode: subject.code,
    concreteActivityId: concreteActivityId++,
    concreteActivityCode: `${subject.code}${session.group}`,
    group: session.group,
    day: session.day,
    beginTime: data.slots[session.slot].slice(0, 5),
    concreteActivityCapacity: session.type === "P" ? 300 : 25,
    studentsCount: 0,
    hasFreePlaces: true,
    hasCollision: false,
    selected: false,
    lecture: session.type === "P",
    practise: session.type === "C"
  })));
}

function full(live, ...localIds) {
  const ids = new Set(localIds);
  return live.map((dto) => {
    const normalized = optimizer.normalizeActivity(dto);
    return ids.has(normalized.localSessionId)
      ? { ...dto, studentsCount: dto.concreteActivityCapacity, hasFreePlaces: false }
      : dto;
  });
}

function activityFor(result, localId) {
  return result.liveActivities.find((item) => item.localSessionId === localId);
}

test("A: všetko voľné zachová prijateľné plány a bezpečný batch", () => {
  const result = optimizer.analyze({ liveActivities: makeLive() });
  assert.ok(result.remainingCount > 0);
  assert.ok(result.targetInfo);
  assert.ok(optimizer.consensusRating(result.targetInfo.plan) < 5);
  assert.ok(result.safeBatch.length >= 1 && result.safeBatch.length <= 2);
  if (result.safeBatch.length > 1) assert.ok(result.batchOutcomes.every((branch) => branch.acceptable));
});

test("B: ZIT C/02 full odstráni iba layouty závislé od tohto času", () => {
  const result = optimizer.analyze({ liveActivities: full(makeLive(), "it-c02") });
  assert.ok(result.remainingCount > 0);
  assert.ok(result.remainingPlans.every((plan) => !(plan.bySubject.it.day === 1 && plan.bySubject.it.slot === 3)));
});

test("C: ZIT C/02 a Programming C/08 full stále nájdu fallback", () => {
  const result = optimizer.analyze({ liveActivities: full(makeLive(), "it-c02", "programming-c08") });
  assert.ok(result.remainingCount > 0);
  assert.ok(result.priorities.length > 0);
});

test("D: Digital C/06 full nepripustí rovnaký osamelý slot", () => {
  const result = optimizer.analyze({ liveActivities: full(makeLive(), "digital-c06") });
  assert.ok(result.remainingCount > 0);
  assert.ok(result.remainingPlans.every((plan) => !(plan.bySubject.digital.day === 2 && plan.bySubject.digital.slot === 2)));
});

test("nedostupná ZDS P/02 vopred chráni štvrtkovú P/01 pred kolíziou", () => {
  const live = full(makeLive(), "digital-p02");
  const result = optimizer.analyze({ liveActivities: live });
  assert.ok(result.remainingCount > 0);
  assert.ok(result.remainingPlans.every((plan) => Object.values(plan.bySubject).every((coord) => !(coord.day === 3 && coord.slot === 0))));
});

test("E: viac plných termínov nespôsobí zaseknutie", () => {
  const result = optimizer.analyze({ liveActivities: full(makeLive(), "it-c02", "programming-c08", "digital-c06", "algebra-c04", "law-c06") });
  assert.equal(typeof result.remainingCount, "number");
  assert.ok(result.noAcceptableLayout || result.priorities.length > 0);
});

test("F: keď zostane iba štvrtkový fallback, piatok sa nepoužije", () => {
  const target = optimizer.plans.find((plan) => plan.id === "B001");
  assert.ok(target);
  const live = makeLive().map((dto) => {
    const activity = optimizer.normalizeActivity(dto);
    if (activity.type !== "C") return dto;
    const coord = target.bySubject[activity.subjectId];
    const keep = activity.day === coord.day && activity.slot === coord.slot;
    return keep ? dto : { ...dto, studentsCount: dto.concreteActivityCapacity, hasFreePlaces: false };
  });
  const result = optimizer.analyze({ liveActivities: live });
  assert.ok(result.remainingCount > 0);
  assert.ok(result.remainingPlans.every((plan) => plan.tier === "B"));
  assert.ok(result.remainingPlans.every((plan) => Object.values(plan.bySubject).every((coord) => coord.day !== 4)));
});

test("G: bez jediného ZIT termínu sa zápis bezpečne zastaví", () => {
  const result = optimizer.analyze({ liveActivities: full(makeLive(), "it-c01", "it-c02", "it-c03", "it-c04") });
  assert.equal(result.remainingCount, 0);
  assert.equal(result.noAcceptableLayout, true);
  assert.equal(result.safeBatch.length, 0);
});

test("plány nemajú kolízie, používajú jeden C čas na predmet a nikdy rating 5/5", () => {
  const anchors = preferences.lectureRequirements.map((requirement) => optimizer.sessionById.get(requirement.alternatives[0]));
  for (const plan of optimizer.usablePlans) {
    assert.equal(Object.keys(plan.bySubject).length, fixedPlans.subjects.length);
    assert.ok(optimizer.consensusRating(plan) < 5);
    const events = [...anchors, ...fixedPlans.subjects.map((subjectId) => ({ ...plan.bySubject[subjectId], subjectId, type: "C" }))];
    for (let i = 0; i < events.length; i += 1) {
      for (let j = i + 1; j < events.length; j += 1) {
        assert.notDeepEqual([events[i].day, events[i].slot], [events[j].day, events[j].slot], `${plan.id} kolízia`);
      }
    }
  }
});

test("medzi susednými blokmi je 15-minútový buffer", () => {
  for (let index = 0; index < data.slots.length - 1; index += 1) {
    const end = data.slots[index].slice(-5).split(":").map(Number);
    const start = data.slots[index + 1].slice(0, 5).split(":").map(Number);
    assert.equal((start[0] * 60 + start[1]) - (end[0] * 60 + end[1]), 15);
  }
});

test("optimizer dokončí 7 cvičení a až potom všetky 4 prednáškové požiadavky", () => {
  const live = makeLive();
  const state = { liveActivities: live, locked: {}, unavailable: [] };
  let steps = 0;
  while (steps < 20) {
    const result = optimizer.analyze(state);
    if (result.complete) break;
    const next = result.priorities[0];
    assert.ok(next, "optimizer sa nesmie zaseknúť");
    if (steps < 7) assert.equal(next.type, "C");
    state.locked[next.requirementKey] = next.activity.concreteActivityId;
    steps += 1;
  }
  assert.equal(steps, 11);
  assert.equal(optimizer.analyze(state).complete, true);
  assert.ok(state.locked["lecture:programming"]);
  assert.equal(Object.keys(state.locked).filter((key) => key.startsWith("lecture:programming")).length, 1);
});

test("Programming P/01 a P/02 sú alternatívy: ak je prvá plná, vyberie druhú", () => {
  const live = full(makeLive(), "programming-p01");
  const exerciseLocks = {};
  const initial = optimizer.analyze({ liveActivities: live });
  for (const subjectId of fixedPlans.subjects) {
    const plan = initial.targetInfo.plan;
    const coord = plan.bySubject[subjectId];
    const activity = initial.liveActivities.find((item) => item.subjectId === subjectId && item.type === "C" && item.day === coord.day && item.slot === coord.slot && item.hasFreePlaces !== false);
    assert.ok(activity);
    exerciseLocks[subjectId] = activity.concreteActivityId;
  }
  const result = optimizer.analyze({ liveActivities: live, locked: exerciseLocks, unavailable: [] });
  const programmingLecture = result.lecturePriorities.find((item) => item.requirementKey === "lecture:programming");
  assert.ok(programmingLecture);
  assert.equal(programmingLecture.activity.localSessionId, "programming-p02");
});

test("capacity pressure dá 23/25 výrazne vyššie riziko než 0/94", () => {
  const urgent = core.capacityPressure({ studentsCount: 23, concreteActivityCapacity: 25, hasFreePlaces: true });
  const roomy = core.capacityPressure({ studentsCount: 0, concreteActivityCapacity: 94, hasFreePlaces: true });
  assert.ok(urgent > roomy + 0.5);
});

test("success/failure detekcia neverí samotnému HTTP 200", () => {
  assert.equal(core.classifyActivityResponse({ payload: { subjectScheduleTable: {} }, activityId: 42 }).code, "UNKNOWN_SERVER_ERROR");
  assert.equal(core.classifyActivityResponse({ payload: { errMsg: "volba rozvrhu nyní není otevřena" }, activityId: 42 }).code, "REGISTRATION_CLOSED");
  assert.equal(core.classifyActivityResponse({ payload: { rows: [{ concreteActivityId: 42, concreteActivityCode: "X-C/01", selected: true }] }, activityId: 42 }).code, "SUCCESS");
  assert.equal(core.classifyActivityResponse({ payload: null, activityId: 42, contentType: "text/html" }).code, "AUTH_EXPIRED");
});

test("LIVE mapovanie používa kód + skupinu + deň a nie hardcoded activity ID", () => {
  const result = optimizer.analyze({ liveActivities: makeLive() });
  const zit = activityFor(result, "it-c02");
  assert.equal(zit.subjectId, "it");
  assert.equal(zit.group, "C/02");
  assert.ok(Number.isFinite(zit.concreteActivityId));
});

test("termín zo starej databázy, ktorý v načítanom LIVE predmete chýba, sa nepovažuje za voľný", () => {
  const live = makeLive().filter((dto) => optimizer.normalizeActivity(dto).localSessionId !== "it-c02");
  const result = optimizer.analyze({ liveActivities: live });
  assert.ok(result.remainingPlans.every((plan) => !(plan.bySubject.it.day === 1 && plan.bySubject.it.slot === 3)));
});