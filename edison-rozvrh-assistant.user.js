// ==UserScript==
// @name         EDISON Rozvrh Assistant
// @namespace    https://github.com/nik-kubala/rozvrh
// @version      1.0.0
// @description  Bezpečný adaptívny zápis rozvrhu VŠB-TUO s DRY RUN, ARM/START/STOP a robustnými fallbackmi.
// @author       nik-kubala
// @match        https://edison.sso.vsb.cz/wps/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* bundled from optimizer-core.js — edit the source file, then run npm run build:userscript */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ROZVRH_OPTIMIZER = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY_INDEX = new Map([
    ["pondeli", 0], ["pondelok", 0], ["monday", 0],
    ["utery", 1], ["utorok", 1], ["tuesday", 1],
    ["streda", 2], ["wednesday", 2],
    ["ctvrtek", 3], ["stvrtok", 3], ["thursday", 3],
    ["patek", 4], ["piatok", 4], ["friday", 4]
  ]);

  const DEFAULT_RULES = {
    ratingWeight: 600,
    thursdayBasePenalty: 320,
    fridayBasePenalty: 2200,
    extraSchoolDayPenalty: 160,
    gapPenalty: 12,
    robustnessAveragePenalty: 260,
    robustnessWeakLinkPenalty: 520,
    concurrencyLimit: 2,
    batchMinimumMassRatio: 0.02
  };

  function stripDiacritics(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function dayIndex(value) {
    if (Number.isInteger(value)) return value;
    return DAY_INDEX.get(stripDiacritics(value).trim()) ?? -1;
  }

  function slotIndex(value, slots) {
    if (Number.isInteger(value)) return value;
    const time = String(value || "").slice(0, 5);
    return (slots || []).findIndex((slot) => String(slot).slice(0, 5) === time);
  }

  function normalizeGroup(activity) {
    if (activity.group) return String(activity.group).toUpperCase();
    const direct = activity.concreteActivityCode || activity.code || "";
    const match = String(direct).match(/([PC]\/\d+)$/i);
    if (match) return match[1].toUpperCase();
    const template = activity.concreteActivityTemplate;
    const order = Number(activity.concreteActivityOrder);
    if (template && Number.isFinite(order)) return `${String(template).toUpperCase()}/${String(order).padStart(2, "0")}`;
    return "";
  }

  function extractActivityDtos(value) {
    const found = [];
    const seen = new Set();
    function visit(item) {
      if (!item || typeof item !== "object" || seen.has(item)) return;
      seen.add(item);
      if (Number.isFinite(Number(item.concreteActivityId)) &&
          (item.concreteActivityCode || item.concreteActivityTemplate || item.subjectVersionScheduleCode)) {
        found.push(item);
      }
      if (Array.isArray(item)) item.forEach(visit);
      else Object.values(item).forEach(visit);
    }
    visit(value);
    return found;
  }

  function capacityPressure(activity) {
    if (!activity) return 0;
    const capacity = Number(activity.concreteActivityCapacity ?? activity.capacity);
    const students = Number(activity.studentsCount ?? activity.students);
    if (!Number.isFinite(capacity) || capacity <= 0) return activity.hasFreePlaces === false ? 1 : 0;
    const used = Number.isFinite(students) ? Math.max(0, students) : 0;
    const free = Math.max(0, capacity - used);
    const occupiedRatio = Math.min(1, used / capacity);
    const fewPlaces = Math.exp(-free / 8);
    const smallGroup = Math.exp(-capacity / 25);
    const score = occupiedRatio * 0.55 + fewPlaces * 0.30 + smallGroup * 0.15;
    return Math.max(0, Math.min(1, activity.hasFreePlaces === false ? 1 : score));
  }

  function classifyActivityResponse({ payload, activityId, status = 200, contentType = "application/json", networkError = null }) {
    if (networkError) return { ok: false, code: "NETWORK_ERROR", message: String(networkError.message || networkError) };
    if (status === 401 || status === 403) return { ok: false, code: "AUTH_EXPIRED", message: `HTTP ${status}` };
    if (!payload || typeof payload !== "object" || !String(contentType || "").toLowerCase().includes("json")) {
      return { ok: false, code: "AUTH_EXPIRED", message: "EDISON nevrátil JSON; relácia pravdepodobne vypršala." };
    }

    const errMsg = String(payload.errMsg || "").trim();
    const folded = stripDiacritics(errMsg);
    if (errMsg) {
      if (/nyni otevrena|neni.*otevren|volba rozvrhu.*uzavren|registrac.*uzavren/.test(folded)) {
        return { ok: false, code: "REGISTRATION_CLOSED", message: errMsg };
      }
      if (/koliz|konflikt|prekryv/.test(folded)) return { ok: false, code: "COLLISION", message: errMsg };
      if (/obsazen|kapacit|voln.*mist|pln/.test(folded)) return { ok: false, code: "FULL", message: errMsg };
      if (/prihlas|autoriz|session|relace|platnost/.test(folded)) return { ok: false, code: "AUTH_EXPIRED", message: errMsg };
      return { ok: false, code: "UNKNOWN_SERVER_ERROR", message: errMsg };
    }

    const requested = extractActivityDtos(payload).find((activity) => Number(activity.concreteActivityId) === Number(activityId));
    if (requested?.selected === true) return { ok: true, code: "SUCCESS", message: String(payload.infoMsg || "Zapísané."), activity: requested };
    if (requested?.hasFreePlaces === false) return { ok: false, code: "FULL", message: "Rozvrhová jednotka už nemá voľné miesto.", activity: requested };
    if (requested?.hasCollision === true) return { ok: false, code: "COLLISION", message: "EDISON hlási kolíziu.", activity: requested };
    return { ok: false, code: "UNKNOWN_SERVER_ERROR", message: "HTTP odpoveď nepotvrdila selected === true pre požadované activity ID.", activity: requested || null };
  }

  function createOptimizer({ data, fixedPlans, preferences }) {
    if (!data || !fixedPlans || !preferences) throw new Error("Optimizer potrebuje data, fixedPlans a preferences.");
    const rules = { ...DEFAULT_RULES, ...(preferences.rules || {}) };
    const hardRejectAt = Number(preferences.hardRejectAt || 5);
    const importance = preferences.subjectImportance || {};
    const slotPenalty = preferences.slotPenalty || [8, 0, 2, 7, 18, 32, 48];
    const thursdaySlotPenalty = preferences.thursdaySlotPenalty || [0, 8, 18, 35, 60, 95, 140];
    const subjectById = new Map(data.subjects.map((subject) => [subject.id, subject]));
    const sessionById = new Map();
    const subjectByCode = new Map();
    for (const subject of data.subjects) {
      subjectByCode.set(String(subject.code), subject);
      for (const session of subject.sessions) sessionById.set(session.id, { ...session, subjectId: subject.id });
    }

    const preferredTemplate = (data.templates || []).find((template) => template.id === "a-compact") || (data.templates || [])[0] || { sessionIds: [] };
    const preferredExercise = new Map();
    for (const id of preferredTemplate.sessionIds || []) {
      const session = sessionById.get(id);
      if (session?.type === "C") preferredExercise.set(session.subjectId, session.id);
    }

    const plans = fixedPlans.plans.map(([id, tier, score, coords], rank) => {
      const bySubject = {};
      fixedPlans.subjects.forEach((subjectId, index) => {
        const [day, slot] = coords[index];
        bySubject[subjectId] = { day, slot };
      });
      return { id, tier, score, rank, bySubject };
    });

    function consensusRating(planOrId) {
      const id = typeof planOrId === "string" ? planOrId : planOrId?.id;
      const value = Number(preferences.consensusRatings?.[id]);
      return Number.isFinite(value) ? value : 5;
    }

    function exerciseSessionsAt(subjectId, coord) {
      return (subjectById.get(subjectId)?.sessions || [])
        .filter((session) => session.type === "C" && session.day === coord.day && session.slot === coord.slot)
        .map((session) => ({ ...session, subjectId }));
    }

    function lectureAnchors() {
      return (preferences.lectureRequirements || []).flatMap((requirement) => {
        const first = (requirement.alternatives || []).map((id) => sessionById.get(id)).find(Boolean);
        return first ? [{ ...first, subjectId: requirement.subjectId, requirementKey: requirement.key }] : [];
      });
    }

    function planMetrics(plan) {
      const events = [
        ...lectureAnchors(),
        ...fixedPlans.subjects.map((subjectId) => ({ ...plan.bySubject[subjectId], subjectId, type: "C" }))
      ];
      const byDay = new Map();
      for (const event of events) {
        if (!byDay.has(event.day)) byDay.set(event.day, []);
        byDay.get(event.day).push(event.slot);
      }
      let gaps = 0;
      for (const slots of byDay.values()) {
        const unique = [...new Set(slots)].sort((a, b) => a - b);
        if (unique.length) gaps += Math.max(0, unique.at(-1) - unique[0] + 1 - unique.length);
      }
      return { activeDays: byDay.size, gaps, thursdayFree: !byDay.has(3), fridayFree: !byDay.has(4) };
    }

    function planScheduleCost(plan) {
      let cost = 0;
      for (const subjectId of fixedPlans.subjects) {
        const coord = plan.bySubject[subjectId];
        cost += Number(slotPenalty[coord.slot] || 0);
        if (coord.day === 3) cost += Number(rules.thursdayBasePenalty) + Number(thursdaySlotPenalty[coord.slot] || 0);
        if (coord.day === 4) cost += Number(rules.fridayBasePenalty);
      }
      const metrics = planMetrics(plan);
      cost += Math.max(0, metrics.activeDays - 3) * Number(rules.extraSchoolDayPenalty);
      cost += metrics.gaps * Number(rules.gapPenalty);
      return cost;
    }

    const planMeta = new Map(plans.map((plan) => {
      const rating = consensusRating(plan);
      const scheduleCost = planScheduleCost(plan);
      const cost = Math.max(0, rating - 1) * Number(rules.ratingWeight) + scheduleCost;
      const qualityWeight = Math.exp(-Math.max(0, rating - 1) * 0.72) * Math.exp(-scheduleCost / 1000);
      return [plan.id, { rating, scheduleCost, cost, qualityWeight }];
    }));

    const usablePlans = plans.filter((plan) => consensusRating(plan) < hardRejectAt)
      .sort((a, b) => planMeta.get(a.id).cost - planMeta.get(b.id).cost || a.id.localeCompare(b.id));

    function normalizeActivity(dto) {
      const code = String(dto.subjectVersionScheduleCode || dto.subjectCode || "");
      const subject = subjectByCode.get(code) || subjectById.get(dto.subjectId);
      const group = normalizeGroup(dto);
      const local = subject?.sessions.find((session) => session.group.toUpperCase() === group &&
        (dayIndex(dto.weekDayTitle ?? dto.day) < 0 || session.day === dayIndex(dto.weekDayTitle ?? dto.day)) &&
        (slotIndex(dto.scheduleWindowBeginTime ?? dto.beginTime, data.slots) < 0 || session.slot === slotIndex(dto.scheduleWindowBeginTime ?? dto.beginTime, data.slots)));
      const capacity = Number(dto.concreteActivityCapacity ?? dto.capacity);
      const students = Number(dto.studentsCount ?? dto.students);
      const hasFreePlaces = dto.hasFreePlaces === false ? false : Number.isFinite(capacity) && Number.isFinite(students) ? students < capacity : dto.hasFreePlaces !== false;
      return {
        ...dto,
        concreteActivityId: Number(dto.concreteActivityId),
        subjectId: subject?.id || dto.subjectId || null,
        localSessionId: local?.id || dto.localSessionId || null,
        group,
        type: local?.type || (dto.lecture ? "P" : "C"),
        day: local?.day ?? dayIndex(dto.weekDayTitle ?? dto.day),
        slot: local?.slot ?? slotIndex(dto.scheduleWindowBeginTime ?? dto.beginTime, data.slots),
        week: dto.week || dto.educationWeekTitle || local?.week || null,
        concreteActivityCapacity: Number.isFinite(capacity) ? capacity : null,
        studentsCount: Number.isFinite(students) ? students : null,
        hasFreePlaces,
        selected: dto.selected === true,
        hasCollision: dto.hasCollision === true
      };
    }

    function runtime(state = {}) {
      const liveActivities = (state.liveActivities || []).map(normalizeActivity)
        .filter((activity) => activity.subjectId && activity.localSessionId);
      const liveByLocal = new Map(liveActivities.map((activity) => [activity.localSessionId, activity]));
      const liveByConcrete = new Map(liveActivities.map((activity) => [String(activity.concreteActivityId), activity]));
      const liveSubjectIds = new Set(liveActivities.map((activity) => activity.subjectId));
      const unavailable = new Set((state.unavailable || []).map(String));
      const locked = { ...(state.locked || {}) };

      function activityForSession(session) {
        return liveByLocal.get(session.id) || {
          ...session,
          subjectId: session.subjectId,
          localSessionId: session.id,
          concreteActivityId: null,
          concreteActivityCapacity: null,
          studentsCount: null,
          hasFreePlaces: !liveSubjectIds.has(session.subjectId),
          selected: false
        };
      }

      function resolveLock(value) {
        if (!value) return null;
        if (typeof value === "object") return normalizeActivity(value);
        return liveByConcrete.get(String(value)) || (sessionById.has(String(value)) ? activityForSession(sessionById.get(String(value))) : null);
      }

      function isUnavailable(activity) {
        return unavailable.has(String(activity.localSessionId)) || unavailable.has(String(activity.concreteActivityId)) || activity.hasFreePlaces === false;
      }

      function availableAt(subjectId, coord, extraUnavailable = null) {
        return exerciseSessionsAt(subjectId, coord).map(activityForSession).filter((activity) => {
          if (extraUnavailable && (String(activity.localSessionId) === String(extraUnavailable) || String(activity.concreteActivityId) === String(extraUnavailable))) return false;
          return !isUnavailable(activity);
        });
      }

      function planIsFeasible(plan, overrides = {}) {
        const overrideLocked = { ...locked, ...(overrides.locked || {}) };
        const extraUnavailable = overrides.unavailable || [];
        for (const subjectId of fixedPlans.subjects) {
          const coord = plan.bySubject[subjectId];
          const lock = resolveLock(overrideLocked[subjectId]);
          if (lock) {
            if (lock.day !== coord.day || lock.slot !== coord.slot || lock.type !== "C") return false;
          } else {
            const sessions = availableAt(subjectId, coord).filter((activity) => !extraUnavailable.some((id) => String(id) === String(activity.localSessionId) || String(id) === String(activity.concreteActivityId)));
            if (!sessions.length) return false;
          }
        }
        const exerciseEvents = fixedPlans.subjects.map((subjectId) => ({ ...plan.bySubject[subjectId], subjectId, type: "C" }));
        const requirements = preferences.lectureRequirements || [];
        function chooseLectures(index, chosen) {
          if (index >= requirements.length) return true;
          const requirement = requirements[index];
          const requirementLock = resolveLock(overrideLocked[requirement.key]);
          const candidates = requirementLock
            ? [requirementLock]
            : (requirement.alternatives || []).map((id) => sessionById.get(id)).filter(Boolean).map(activityForSession).filter((activity) => {
                const key = activity.concreteActivityId ?? activity.localSessionId;
                return !isUnavailable(activity) && !extraUnavailable.some((id) => String(id) === String(key) || String(id) === String(activity.localSessionId));
              });
          for (const candidate of candidates) {
            if (exerciseEvents.some((event) => conflicts(candidate, event))) continue;
            if (chosen.some((event) => conflicts(candidate, event))) continue;
            if (chooseLectures(index + 1, [...chosen, candidate])) return true;
          }
          return false;
        }
        return chooseLectures(0, []);
      }

      function remaining(overrides = {}) {
        return usablePlans.filter((plan) => planIsFeasible(plan, overrides));
      }

      function qualityMass(list) {
        return list.reduce((sum, plan) => sum + planMeta.get(plan.id).qualityWeight, 0);
      }

      function bestPlanCost(list) {
        return list.length ? Math.min(...list.map((plan) => planMeta.get(plan.id).cost)) : Infinity;
      }

      function supportMass(list, subjectId, coord) {
        return qualityMass(list.filter((plan) => plan.bySubject[subjectId].day === coord.day && plan.bySubject[subjectId].slot === coord.slot));
      }

      function chooseTargetPlan(list) {
        if (!list.length) return null;
        const totalMass = Math.max(qualityMass(list), 1e-9);
        const unlocked = fixedPlans.subjects.filter((subjectId) => !resolveLock(locked[subjectId]));
        let best = null;
        for (const plan of list.slice(0, 50)) {
          const supports = unlocked.map((subjectId) => supportMass(list, subjectId, plan.bySubject[subjectId]) / totalMass);
          const avgSupport = supports.length ? supports.reduce((sum, value) => sum + value, 0) / supports.length : 1;
          const minSupport = supports.length ? Math.min(...supports) : 1;
          const robustScore = planMeta.get(plan.id).cost +
            (1 - avgSupport) * Number(rules.robustnessAveragePenalty) +
            (1 - minSupport) * Number(rules.robustnessWeakLinkPenalty);
          if (!best || robustScore < best.robustScore) best = { plan, avgSupport, minSupport, robustScore };
        }
        return best;
      }

      function preferredActivity(subjectId, coord) {
        const available = availableAt(subjectId, coord);
        if (!available.length) return null;
        const preferredId = preferredExercise.get(subjectId);
        return available.find((activity) => activity.localSessionId === preferredId) ||
          available.sort((a, b) => capacityPressure(b) - capacityPressure(a) || a.group.localeCompare(b.group))[0];
      }

      function buildExercisePriorities(list, targetInfo) {
        if (!list.length || !targetInfo?.plan) return [];
        const totalMass = Math.max(qualityMass(list), 1e-9);
        const currentBestCost = bestPlanCost(list);
        const priorities = [];
        for (const subjectId of fixedPlans.subjects) {
          if (resolveLock(locked[subjectId])) continue;
          const coord = targetInfo.plan.bySubject[subjectId];
          const activity = preferredActivity(subjectId, coord);
          if (!activity) continue;
          const available = availableAt(subjectId, coord);
          const activityKey = activity.concreteActivityId ?? activity.localSessionId;
          const afterSuccess = list.filter((plan) => plan.bySubject[subjectId].day === coord.day && plan.bySubject[subjectId].slot === coord.slot);
          const afterFailure = remaining({ unavailable: [activityKey] });
          const afterSuccessMass = qualityMass(afterSuccess);
          const afterFailureMass = qualityMass(afterFailure);
          const fallbackLoss = Math.max(0, 1 - afterFailureMass / totalMass);
          const scheduleRegretRaw = afterFailure.length ? Math.max(0, bestPlanCost(afterFailure) - currentBestCost) : 5000;
          const scheduleRegret = 1 - Math.exp(-Math.min(scheduleRegretRaw, 5000) / 500);
          const alternativeTimes = new Set(list.map((plan) => `${plan.bySubject[subjectId].day}:${plan.bySubject[subjectId].slot}`)).size;
          const sameSlotAlternatives = Math.max(0, available.length - 1);
          const pressure = capacityPressure(activity);
          const subjectImportance = Number(importance[subjectId] || 40);
          let riskScore = subjectImportance * 2.2 + fallbackLoss * 400 + scheduleRegret * 260 + pressure * 300 + (1 / Math.max(1, alternativeTimes)) * 120 - sameSlotAlternatives * 45;
          if (!afterFailure.length) riskScore += 10000;
          const riskLevel = !afterFailure.length || riskScore >= 700 ? "CRITICAL" : riskScore >= 430 ? "HIGH" : riskScore >= 250 ? "MEDIUM" : "LOW";
          priorities.push({
            requirementKey: subjectId,
            type: "C",
            subjectId,
            subject: subjectById.get(subjectId),
            coord,
            activity,
            sameSlotAlternatives,
            alternativeTimes,
            afterSuccessCount: afterSuccess.length,
            afterFailureCount: afterFailure.length,
            afterSuccessMass,
            afterFailureMass,
            fallbackLoss,
            scheduleRegret,
            scheduleRegretRaw,
            capacityPressure: pressure,
            subjectImportance,
            riskScore,
            riskLevel,
            reason: `${Math.round(fallbackLoss * 100)} % strata quality mass pri zlyhaní; kapacitný tlak ${Math.round(pressure * 100)} %; ${alternativeTimes} časových alternatív.`
          });
        }
        return priorities.sort((a, b) => b.riskScore - a.riskScore || b.subjectImportance - a.subjectImportance || a.subject.name.localeCompare(b.subject.name));
      }

      function conflicts(a, b) {
        if (!a || !b || a.day !== b.day || a.slot !== b.slot) return false;
        if (a.subjectId === b.subjectId && a.type === "P" && b.type === "P" && a.week && b.week && a.week !== b.week) return false;
        return true;
      }

      function lockedActivities() {
        return Object.values(locked).map(resolveLock).filter(Boolean);
      }

      function buildLecturePriorities(exercisesDone) {
        if (!exercisesDone) return [];
        const selected = lockedActivities();
        const result = [];
        for (const requirement of preferences.lectureRequirements || []) {
          if (resolveLock(locked[requirement.key])) continue;
          const alternatives = (requirement.alternatives || []).map((id) => activityForSession(sessionById.get(id))).filter((activity) => activity.localSessionId && !isUnavailable(activity));
          const activity = alternatives.find((candidate) => !selected.some((other) => conflicts(candidate, other)));
          if (!activity) continue;
          const pressure = capacityPressure(activity);
          const subjectImportance = Number(importance[requirement.subjectId] || 40);
          const riskScore = subjectImportance * 1.2 + pressure * 300 + (alternatives.length === 1 ? 80 : 0);
          result.push({ requirementKey: requirement.key, type: "P", subjectId: requirement.subjectId, subject: subjectById.get(requirement.subjectId), coord: { day: activity.day, slot: activity.slot }, activity, capacityPressure: pressure, subjectImportance, riskScore, riskLevel: riskScore >= 350 ? "HIGH" : riskScore >= 200 ? "MEDIUM" : "LOW", reason: `Prednáška po cvičeniach; kapacitný tlak ${Math.round(pressure * 100)} %.` });
        }
        return result.sort((a, b) => b.riskScore - a.riskScore || b.subjectImportance - a.subjectImportance);
      }

      function simulateBatch(candidates, baseline) {
        const outcomes = [];
        const count = 2 ** candidates.length;
        const baselineMass = Math.max(qualityMass(baseline), 1e-9);
        for (let mask = 0; mask < count; mask += 1) {
          const extraLocked = {};
          const extraUnavailable = [];
          const labels = [];
          candidates.forEach((candidate, index) => {
            const success = Boolean(mask & (1 << index));
            labels.push(`${candidate.subject?.short || candidate.subjectId} ${success ? "SUCCESS" : "FAIL"}`);
            if (success) extraLocked[candidate.requirementKey] = candidate.activity;
            else extraUnavailable.push(candidate.activity.concreteActivityId ?? candidate.activity.localSessionId);
          });
          const branch = remaining({ locked: extraLocked, unavailable: extraUnavailable });
          outcomes.push({ labels, remainingCount: branch.length, qualityMass: qualityMass(branch), bestRating: branch.length ? Math.min(...branch.map(consensusRating)) : null, acceptable: branch.length > 0 && qualityMass(branch) / baselineMass >= Number(rules.batchMinimumMassRatio) });
        }
        return outcomes;
      }

      const remainingPlans = remaining();
      const targetInfo = chooseTargetPlan(remainingPlans);
      const exercisesDone = fixedPlans.subjects.every((subjectId) => Boolean(resolveLock(locked[subjectId])));
      const exercisePriorities = buildExercisePriorities(remainingPlans, targetInfo);
      const lecturePriorities = buildLecturePriorities(exercisesDone);
      const priorities = exercisesDone ? lecturePriorities : exercisePriorities;
      let safeBatch = priorities.slice(0, 1);
      let batchOutcomes = safeBatch.length && safeBatch[0].type === "C" ? simulateBatch(safeBatch, remainingPlans) : [];
      const limit = Math.max(1, Math.min(3, Number(rules.concurrencyLimit || 2)));
      for (const candidate of priorities.slice(1, limit)) {
        if (candidate.type !== "C" || safeBatch.some((item) => conflicts(item.activity, candidate.activity))) continue;
        const trial = [...safeBatch, candidate];
        const outcomes = simulateBatch(trial, remainingPlans);
        if (outcomes.every((outcome) => outcome.acceptable)) {
          safeBatch = trial;
          batchOutcomes = outcomes;
        }
      }

      return {
        usablePlans,
        remainingPlans,
        remainingCount: remainingPlans.length,
        qualityMass: qualityMass(remainingPlans),
        bestRemainingRating: remainingPlans.length ? Math.min(...remainingPlans.map(consensusRating)) : null,
        targetInfo,
        priorities,
        exercisePriorities,
        lecturePriorities,
        safeBatch,
        batchOutcomes,
        exercisesDone,
        complete: exercisesDone && (preferences.lectureRequirements || []).every((requirement) => Boolean(resolveLock(locked[requirement.key]))),
        noAcceptableLayout: remainingPlans.length === 0,
        liveActivities,
        planIsFeasible,
        conflicts
      };
    }

    return {
      data,
      fixedPlans,
      preferences,
      plans,
      usablePlans,
      subjectById,
      sessionById,
      consensusRating,
      normalizeActivity,
      analyze: runtime,
      extractActivityDtos,
      capacityPressure,
      classifyActivityResponse
    };
  }

  return { createOptimizer, extractActivityDtos, capacityPressure, classifyActivityResponse, dayIndex, slotIndex };
});

/* bundled from data.js — edit the source file, then run npm run build:userscript */
window.ROZVRH_DATA = {
  updated: "2026-09-07",
  days: ["Pondelok", "Utorok", "Streda", "Štvrtok", "Piatok"],
  slots: [
    "07:15–08:45",
    "09:00–10:30",
    "10:45–12:15",
    "12:30–14:00",
    "14:15–15:45",
    "16:00–17:30",
    "17:45–19:15"
  ],
  subjects: [
    {
      id: "digital",
      code: "440210401",
      short: "Digitálne systémy",
      name: "Základy digitálních systémů",
      requirement: "P+C",
      color: "#60a5fa",
      sessions: [
        { id: "digital-p02", type: "P", group: "P/02", day: 0, slot: 2 },
        { id: "digital-p01", type: "P", group: "P/01", day: 3, slot: 0 },
        { id: "digital-c18", type: "C", group: "C/18", day: 0, slot: 0 },
        { id: "digital-c14", type: "C", group: "C/14", day: 0, slot: 1 },
        { id: "digital-c01", type: "C", group: "C/01", day: 0, slot: 2 },
        { id: "digital-c16", type: "C", group: "C/16", day: 0, slot: 3 },
        { id: "digital-c02", type: "C", group: "C/02", day: 0, slot: 4 },
        { id: "digital-c17", type: "C", group: "C/17", day: 0, slot: 5 },
        { id: "digital-c21", type: "C", group: "C/21", day: 0, slot: 6 },
        { id: "digital-c03", type: "C", group: "C/03", day: 1, slot: 0 },
        { id: "digital-c09", type: "C", group: "C/09", day: 1, slot: 5 },
        { id: "digital-c22", type: "C", group: "C/22", day: 1, slot: 6 },
        { id: "digital-c04", type: "C", group: "C/04", day: 2, slot: 0 },
        { id: "digital-c07", type: "C", group: "C/07", day: 2, slot: 1 },
        { id: "digital-c06", type: "C", group: "C/06", day: 2, slot: 2 },
        { id: "digital-c05", type: "C", group: "C/05", day: 2, slot: 3 },
        { id: "digital-c08", type: "C", group: "C/08", day: 2, slot: 4 },
        { id: "digital-c15", type: "C", group: "C/15", day: 2, slot: 5 },
        { id: "digital-c23", type: "C", group: "C/23", day: 2, slot: 6 },
        { id: "digital-c19", type: "C", group: "C/19", day: 3, slot: 0 },
        { id: "digital-c10", type: "C", group: "C/10", day: 3, slot: 1 },
        { id: "digital-c11", type: "C", group: "C/11", day: 3, slot: 2 },
        { id: "digital-c12", type: "C", group: "C/12", day: 3, slot: 4 },
        { id: "digital-c13", type: "C", group: "C/13", day: 3, slot: 5 },
        { id: "digital-c24", type: "C", group: "C/24", day: 3, slot: 6 }
      ]
    },
    {
      id: "logic",
      code: "460205103",
      short: "Logické myslenie",
      name: "Úvod do logického myšlení",
      requirement: "P+C",
      color: "#a78bfa",
      sessions: [
        { id: "logic-p01", type: "P", group: "P/01", day: 0, slot: 0 },
        { id: "logic-c05", type: "C", group: "C/05", day: 0, slot: 1 },
        { id: "logic-c20", type: "C", group: "C/20", day: 0, slot: 4 },
        { id: "logic-c06", type: "C", group: "C/06", day: 0, slot: 4 },
        { id: "logic-c11", type: "C", group: "C/11", day: 1, slot: 0 },
        { id: "logic-c07", type: "C", group: "C/07", day: 1, slot: 0 },
        { id: "logic-c12", type: "C", group: "C/12", day: 1, slot: 2 },
        { id: "logic-c08", type: "C", group: "C/08", day: 1, slot: 2 },
        { id: "logic-c13", type: "C", group: "C/13", day: 1, slot: 3 },
        { id: "logic-c09", type: "C", group: "C/09", day: 1, slot: 3 },
        { id: "logic-c03", type: "C", group: "C/03", day: 1, slot: 3 },
        { id: "logic-c04", type: "C", group: "C/04", day: 1, slot: 4 },
        { id: "logic-c14", type: "C", group: "C/14", day: 2, slot: 2 },
        { id: "logic-c10", type: "C", group: "C/10", day: 2, slot: 2 },
        { id: "logic-c15", type: "C", group: "C/15", day: 2, slot: 3 },
        { id: "logic-c16", type: "C", group: "C/16", day: 2, slot: 4 },
        { id: "logic-c01", type: "C", group: "C/01", day: 3, slot: 1 },
        { id: "logic-c02", type: "C", group: "C/02", day: 3, slot: 2 },
        { id: "logic-c19", type: "C", group: "C/19", day: 3, slot: 4 }
      ]
    },
    {
      id: "programming",
      code: "460205205",
      short: "Programovanie",
      name: "Úvod do programování",
      requirement: "P+C",
      color: "#f59e0b",
      sessions: [
        { id: "programming-p01", type: "P", group: "P/01", day: 1, slot: 1, week: "sudý týždeň" },
        { id: "programming-p02", type: "P", group: "P/02", day: 1, slot: 1, week: "lichý týždeň" },
        { id: "programming-c05", type: "C", group: "C/05", day: 0, slot: 1 },
        { id: "programming-c01", type: "C", group: "C/01", day: 0, slot: 1 },
        { id: "programming-c15", type: "C", group: "C/15", day: 0, slot: 2 },
        { id: "programming-c02", type: "C", group: "C/02", day: 0, slot: 2 },
        { id: "programming-c16", type: "C", group: "C/16", day: 0, slot: 4 },
        { id: "programming-c17", type: "C", group: "C/17", day: 0, slot: 5 },
        { id: "programming-c22", type: "C", group: "C/22", day: 0, slot: 5 },
        { id: "programming-c20", type: "C", group: "C/20", day: 1, slot: 2 },
        { id: "programming-c06", type: "C", group: "C/06", day: 1, slot: 2 },
        { id: "programming-c21", type: "C", group: "C/21", day: 1, slot: 3 },
        { id: "programming-c07", type: "C", group: "C/07", day: 1, slot: 3 },
        { id: "programming-c08", type: "C", group: "C/08", day: 1, slot: 4 },
        { id: "programming-c03", type: "C", group: "C/03", day: 1, slot: 6 },
        { id: "programming-c18", type: "C", group: "C/18", day: 2, slot: 4 },
        { id: "programming-c04", type: "C", group: "C/04", day: 2, slot: 4 },
        { id: "programming-c19", type: "C", group: "C/19", day: 2, slot: 5 },
        { id: "programming-c12", type: "C", group: "C/12", day: 3, slot: 0 },
        { id: "programming-c13", type: "C", group: "C/13", day: 3, slot: 1 },
        { id: "programming-c14", type: "C", group: "C/14", day: 3, slot: 2 },
        { id: "programming-c09", type: "C", group: "C/09", day: 3, slot: 4 },
        { id: "programming-c10", type: "C", group: "C/10", day: 3, slot: 5 },
        { id: "programming-c11", type: "C", group: "C/11", day: 3, slot: 6 }
      ]
    },
    {
      id: "it",
      code: "460207901",
      short: "ZIT",
      name: "Základy informačních technologií",
      requirement: "P+C",
      color: "#22c55e",
      missingLecture: true,
      sessions: [
        { id: "it-c02", type: "C", group: "C/02", day: 1, slot: 3 },
        { id: "it-c03", type: "C", group: "C/03", day: 1, slot: 4 },
        { id: "it-c01", type: "C", group: "C/01", day: 2, slot: 1 },
        { id: "it-c04", type: "C", group: "C/04", day: 2, slot: 2 }
      ]
    },
    {
      id: "algebra",
      code: "470220501",
      short: "Lineárna algebra",
      name: "Lineární algebra",
      requirement: "P+C",
      color: "#f97316",
      sessions: [
        { id: "algebra-p01", type: "P", group: "P/01", day: 0, slot: 3 },
        { id: "algebra-c04", type: "C", group: "C/04", day: 0, slot: 4 },
        { id: "algebra-c05", type: "C", group: "C/05", day: 0, slot: 5 },
        { id: "algebra-c01", type: "C", group: "C/01", day: 0, slot: 5 },
        { id: "algebra-c02", type: "C", group: "C/02", day: 3, slot: 1 },
        { id: "algebra-c06", type: "C", group: "C/06", day: 3, slot: 2 },
        { id: "algebra-c07", type: "C", group: "C/07", day: 3, slot: 4 },
        { id: "algebra-c03", type: "C", group: "C/03", day: 3, slot: 5 }
      ]
    },
    {
      id: "law",
      code: "711043901",
      short: "Právo v ICT",
      name: "Právo v ICT",
      requirement: "C",
      color: "#ec4899",
      sessions: [
        { id: "law-c04", type: "C", group: "C/04", day: 0, slot: 4 },
        { id: "law-c16", type: "C", group: "C/16", day: 0, slot: 5 },
        { id: "law-c15", type: "C", group: "C/15", day: 0, slot: 6 },
        { id: "law-c03", type: "C", group: "C/03", day: 1, slot: 2 },
        { id: "law-c06", type: "C", group: "C/06", day: 2, slot: 1 },
        { id: "law-c07", type: "C", group: "C/07", day: 2, slot: 2 },
        { id: "law-c08", type: "C", group: "C/08", day: 2, slot: 3 },
        { id: "law-c11", type: "C", group: "C/11", day: 2, slot: 4 },
        { id: "law-c14", type: "C", group: "C/14", day: 3, slot: 3 },
        { id: "law-c12", type: "C", group: "C/12", day: 3, slot: 4 },
        { id: "law-c10", type: "C", group: "C/10", day: 3, slot: 5 },
        { id: "law-c09", type: "C", group: "C/09", day: 3, slot: 6 }
      ]
    },
    {
      id: "english",
      code: "712012401",
      short: "Angličtina",
      name: "Jazyk anglický I pro FEI - pokročilá úroveň",
      requirement: "C",
      color: "#14b8a6",
      sessions: [
        { id: "english-c07", type: "C", group: "C/07", day: 0, slot: 1, teacher: "Landry M.", room: "PORKA230" },
        { id: "english-c03", type: "C", group: "C/03", day: 0, slot: 1, teacher: "Pastorková K.", room: "PORJB240" },
        { id: "english-c01", type: "C", group: "C/01", day: 0, slot: 1, teacher: "Illík P.", room: "PORD105" },
        { id: "english-c11", type: "C", group: "C/11", day: 0, slot: 2, teacher: "Smutná K.", room: "PORK308" },
        { id: "english-c04", type: "C", group: "C/04", day: 0, slot: 2, teacher: "Pastorková K.", room: "PORJB240" },
        { id: "english-c02", type: "C", group: "C/02", day: 0, slot: 2, teacher: "Illík P.", room: "PORD105" },
        { id: "english-c18", type: "C", group: "C/18", day: 0, slot: 3, teacher: "Pachula J.", room: "PORB6" },
        { id: "english-c05", type: "C", group: "C/05", day: 0, slot: 3, teacher: "Pastorková K.", room: "PORJB240" },
        { id: "english-c21", type: "C", group: "C/21", day: 0, slot: 4, teacher: "Spurná K.", room: "PORJD358" },
        { id: "english-c17", type: "C", group: "C/17", day: 0, slot: 4, teacher: "Adámková J.", room: "PORD121" },
        { id: "english-c08", type: "C", group: "C/08", day: 0, slot: 4, teacher: "Šnicer M.", room: "PORKA215" },
        { id: "english-c09", type: "C", group: "C/09", day: 0, slot: 4, teacher: "Košťál M.", room: "PORKA204" },
        { id: "english-c12", type: "C", group: "C/12", day: 0, slot: 4, teacher: "Smutná K.", room: "PORK308" },
        { id: "english-c13", type: "C", group: "C/13", day: 0, slot: 5, teacher: "Košťál M.", room: "PORKA204" },
        { id: "english-c06", type: "C", group: "C/06", day: 0, slot: 5, teacher: "Pachula J.", room: "PORJD361" },
        { id: "english-c14", type: "C", group: "C/14", day: 1, slot: 2, teacher: "Spurná K.", room: "PORD109" },
        { id: "english-c15", type: "C", group: "C/15", day: 2, slot: 3, teacher: "Zouhar T.", room: "PORJD361" },
        { id: "english-c22", type: "C", group: "C/22", day: 2, slot: 4, teacher: "Landry M.", room: "PORJB240" },
        { id: "english-c20", type: "C", group: "C/20", day: 2, slot: 4, teacher: "Košťál M.", room: "PORRV202" },
        { id: "english-c19", type: "C", group: "C/19", day: 2, slot: 5, teacher: "Matyášková G.", room: "PORKA227" },
        { id: "english-c10", type: "C", group: "C/10", day: 3, slot: 2, teacher: "Landry M.", room: "PORD121" },
        { id: "english-c16", type: "C", group: "C/16", day: 4, slot: 2, teacher: "Chudašová G.", room: "PORJD358" }
      ]
    }
  ],
  templates: [
    {
      id: "a-compact",
      name: "A — Po–St, minimum dier",
      description: "Pôvodný favorit: súvislé bloky, štvrtok a piatok voľné.",
      sessionIds: [
        "logic-p01",
        "english-c07",
        "digital-p02",
        "algebra-p01",
        "algebra-c04",
        "programming-p01",
        "logic-c12",
        "it-c02",
        "programming-c08",
        "law-c06",
        "digital-c06"
      ],
      warnings: ["Chýba termín prednášky zo Základov informačních technologií, preto šablóna zatiaľ nie je úplná."]
    },
    {
      id: "a-english-wed",
      name: "A2 — Angličtina v stredu",
      description: "Ačko bez pondelkovej angličtiny; angličtina je v stredu po digitálnych systémoch.",
      sessionIds: [
        "logic-p01",
        "digital-p02",
        "algebra-p01",
        "algebra-c04",
        "programming-p01",
        "logic-c12",
        "it-c02",
        "programming-c08",
        "law-c06",
        "digital-c06",
        "english-c15"
      ],
      warnings: ["Chýba termín prednášky zo Základov informačních technologií, preto šablóna zatiaľ nie je úplná."]
    }
  ]
};

/* bundled from fixes.js — edit the source file, then run npm run build:userscript */
(() => {
  const data = window.ROZVRH_DATA;
  if (!data) return;

  // Rozsah výuky podľa zápisu predmetov VŠB-TUO:
  // prvé číslo = prednáška, druhé číslo = cvičenie.
  // ZIT má 0+2, teda iba cvičenie a žiadnu prednášku.
  const zit = data.subjects.find((subject) => subject.id === "it");
  if (zit) {
    zit.requirement = "C";
    delete zit.missingLecture;
  }

  // Staršie šablóny obsahovali upozornenie na údajne chýbajúcu prednášku ZIT.
  // Po oprave 0+2 toto upozornenie už neplatí.
  for (const template of data.templates || []) {
    if (!Array.isArray(template.warnings)) continue;
    template.warnings = template.warnings.filter(
      (warning) => !warning.includes("prednášky zo Základov informačních technologií")
    );
  }
})();

/* bundled from fixed-plans.js — edit the source file, then run npm run build:userscript */
window.ROZVRH_FIXED_PLANS = {"version":1,"subjects":["digital","logic","programming","it","algebra","law","english"],"plans":[["A001","A",0,[[2,2],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A002","A",33,[[2,2],[1,2],[1,4],[1,3],[0,4],[2,3],[0,1]]],["A003","A",33,[[2,0],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A004","A",35,[[2,2],[1,2],[1,4],[1,3],[0,5],[2,1],[0,1]]],["A005","A",35,[[2,3],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A006","A",40,[[2,1],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["A007","A",40,[[2,2],[1,2],[1,3],[1,4],[0,4],[2,1],[0,1]]],["A008","A",43,[[2,2],[1,0],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A009","A",43,[[2,2],[1,2],[0,5],[1,3],[0,4],[2,1],[0,1]]],["A010","A",45,[[2,3],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["A011","A",47,[[1,0],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A012","A",51,[[1,5],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A013","A",53,[[2,2],[2,3],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A014","A",54,[[2,2],[1,2],[2,4],[1,3],[0,4],[2,1],[0,1]]],["A015","A",56,[[2,2],[1,2],[1,4],[1,3],[0,4],[2,4],[0,1]]],["A016","A",56,[[2,2],[1,4],[1,2],[1,3],[0,4],[2,1],[0,1]]],["A017","A",58,[[2,4],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A018","A",58,[[2,2],[1,2],[1,6],[1,3],[0,4],[2,1],[0,1]]],["A019","A",59,[[2,2],[1,2],[0,4],[1,3],[0,5],[2,1],[0,1]]],["A020","A",59,[[2,2],[1,2],[1,4],[1,3],[0,4],[2,1],[0,5]]],["A021","A",61,[[2,2],[1,0],[1,2],[1,3],[0,4],[2,1],[0,1]]],["A022","A",63,[[2,0],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["A023","A",63,[[2,1],[1,2],[1,4],[1,3],[0,4],[2,3],[0,1]]],["A024","A",66,[[2,4],[1,2],[1,4],[1,3],[0,4],[2,3],[0,1]]],["A025","A",66,[[2,3],[1,2],[1,4],[1,3],[0,4],[2,4],[0,1]]],["A026","A",67,[[1,0],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["A027","A",68,[[2,4],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["A028","A",68,[[2,0],[1,2],[1,4],[1,3],[0,5],[2,1],[0,1]]],["A029","A",68,[[2,2],[1,2],[1,4],[1,3],[0,5],[2,3],[0,1]]],["A030","A",68,[[2,2],[1,3],[1,2],[1,4],[0,4],[2,1],[0,1]]],["A031","A",69,[[2,3],[2,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A032","A",70,[[2,3],[1,2],[1,4],[1,3],[0,5],[2,1],[0,1]]],["A033","A",70,[[1,6],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A034","A",71,[[1,5],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["A035","A",71,[[2,2],[2,3],[1,2],[1,3],[0,4],[2,1],[0,1]]],["A036","A",71,[[2,2],[1,2],[1,4],[1,3],[0,5],[2,1],[0,4]]],["A037","A",71,[[2,2],[1,0],[1,4],[1,3],[0,4],[1,2],[0,1]]],["A038","A",72,[[2,2],[2,4],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A039","A",72,[[2,2],[1,2],[2,4],[1,3],[0,4],[2,3],[0,1]]],["A040","A",73,[[2,2],[1,2],[2,5],[1,3],[0,4],[2,1],[0,1]]],["A041","A",73,[[2,3],[1,2],[1,4],[2,2],[0,4],[2,1],[0,1]]],["A042","A",73,[[2,2],[1,2],[0,5],[1,4],[0,4],[2,1],[0,1]]],["A043","A",73,[[2,2],[1,2],[1,3],[1,4],[0,4],[2,3],[0,1]]],["A044","A",73,[[2,0],[1,2],[1,3],[1,4],[0,4],[2,1],[0,1]]],["A045","A",73,[[0,5],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A046","A",74,[[2,3],[1,2],[2,4],[1,3],[0,4],[2,1],[0,1]]],["A047","A",75,[[2,1],[1,2],[1,4],[1,3],[0,5],[2,2],[0,1]]],["A048","A",75,[[2,2],[1,2],[1,3],[1,4],[0,5],[2,1],[0,1]]],["A049","A",75,[[2,3],[1,2],[1,3],[1,4],[0,4],[2,1],[0,1]]],["A050","A",76,[[2,2],[1,2],[0,5],[1,3],[0,4],[2,3],[0,1]]],["A051","A",76,[[2,2],[1,0],[1,4],[1,3],[0,4],[2,3],[0,1]]],["A052","A",76,[[2,0],[1,0],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A053","A",76,[[2,2],[0,1],[1,4],[1,3],[0,4],[2,1],[1,2]]],["A054","A",76,[[2,0],[1,2],[0,5],[1,3],[0,4],[2,1],[0,1]]],["A055","A",77,[[2,0],[2,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A056","A",77,[[2,2],[1,2],[1,4],[1,3],[0,4],[0,5],[0,1]]],["A057","A",77,[[2,2],[0,4],[1,4],[1,3],[0,5],[2,1],[0,1]]],["A058","A",78,[[2,3],[1,0],[1,4],[1,3],[0,4],[2,1],[0,1]]],["A059","A",78,[[2,2],[1,2],[1,6],[1,4],[0,4],[2,1],[0,1]]],["A060","A",78,[[2,2],[1,0],[1,4],[1,3],[0,5],[2,1],[0,1]]],["B001","B",514,[[3,2],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["B002","B",518,[[3,1],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["B003","B",522,[[2,2],[1,2],[1,4],[1,3],[0,4],[3,3],[0,1]]],["B004","B",522,[[3,0],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["B005","B",522,[[3,4],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["B006","B",526,[[2,2],[1,2],[1,4],[1,3],[0,4],[3,4],[0,1]]],["B007","B",526,[[3,5],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["B008","B",530,[[2,2],[1,2],[1,4],[1,3],[0,4],[3,5],[0,1]]],["B009","B",530,[[3,6],[1,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["B010","B",534,[[3,2],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["B011","B",534,[[2,2],[1,2],[1,4],[1,3],[0,4],[3,6],[0,1]]],["B012","B",536,[[2,2],[1,2],[3,4],[1,3],[0,4],[2,1],[0,1]]],["B013","B",538,[[3,1],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["B014","B",540,[[2,2],[1,2],[3,5],[1,3],[0,4],[2,1],[0,1]]],["B015","B",542,[[2,1],[1,2],[1,4],[1,3],[0,4],[3,3],[0,1]]],["B016","B",542,[[3,0],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["B017","B",542,[[3,4],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["B018","B",544,[[2,2],[1,2],[3,6],[1,3],[0,4],[2,1],[0,1]]],["B019","B",544,[[2,2],[1,2],[3,2],[1,3],[0,4],[2,1],[0,1]]],["B020","B",546,[[2,2],[3,2],[1,4],[1,3],[0,4],[2,1],[0,1]]],["B021","B",546,[[3,5],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["B022","B",546,[[2,1],[1,2],[1,4],[1,3],[0,4],[3,4],[0,1]]],["B023","B",547,[[2,3],[1,2],[1,4],[1,3],[0,4],[3,3],[0,1]]],["B024","B",547,[[3,2],[1,2],[1,4],[1,3],[0,4],[2,3],[0,1]]],["B025","B",548,[[2,2],[1,2],[3,1],[1,3],[0,4],[2,1],[0,1]]],["B026","B",549,[[3,2],[1,2],[1,4],[1,3],[0,5],[2,1],[0,1]]],["B027","B",550,[[2,2],[3,1],[1,4],[1,3],[0,4],[2,1],[0,1]]],["B028","B",550,[[3,6],[1,2],[1,4],[1,3],[0,4],[2,2],[0,1]]],["B029","B",550,[[2,1],[1,2],[1,4],[1,3],[0,4],[3,5],[0,1]]],["B030","B",551,[[2,3],[1,2],[1,4],[1,3],[0,4],[3,4],[0,1]]],["C001","C",844,[[2,2],[1,2],[1,4],[1,3],[0,4],[2,1],[4,2]]],["C002","C",877,[[2,2],[1,2],[1,4],[1,3],[0,4],[2,3],[4,2]]],["C003","C",877,[[2,0],[1,2],[1,4],[1,3],[0,4],[2,1],[4,2]]],["C004","C",879,[[2,2],[1,2],[1,4],[1,3],[0,5],[2,1],[4,2]]],["C005","C",879,[[2,3],[1,2],[1,4],[1,3],[0,4],[2,1],[4,2]]],["C006","C",880,[[2,2],[1,2],[0,1],[1,3],[0,4],[2,1],[4,2]]],["C007","C",882,[[2,2],[0,1],[1,4],[1,3],[0,4],[2,1],[4,2]]],["C008","C",884,[[2,2],[1,2],[1,3],[1,4],[0,4],[2,1],[4,2]]],["C009","C",884,[[2,1],[1,2],[1,4],[1,3],[0,4],[2,2],[4,2]]],["C010","C",887,[[2,2],[1,2],[0,5],[1,3],[0,4],[2,1],[4,2]]]]};

/* bundled from preferences.js — edit the source file, then run npm run build:userscript */
window.ROZVRH_PREFERENCES = {
  version: 2,
  source: "average-of-two-complete-1-to-5-exports",
  consensusRatings: {"A001":1.0,"A002":1.0,"A003":1.0,"A004":2.0,"A005":2.0,"A006":1.0,"A007":1.0,"A008":1.5,"A009":2.5,"A010":1.5,"A011":1.0,"A012":2.5,"A013":1.5,"A014":2.5,"A015":2.0,"A016":1.0,"A017":3.5,"A018":5.0,"A019":3.5,"A020":3.5,"A021":1.0,"A022":1.0,"A023":1.0,"A024":2.0,"A025":2.0,"A026":1.0,"A027":2.0,"A028":3.0,"A029":3.0,"A030":1.0,"A031":2.0,"A032":3.0,"A033":5.0,"A034":4.0,"A035":1.0,"A036":3.0,"A037":1.0,"A038":2.5,"A039":2.0,"A040":3.5,"A041":2.0,"A042":3.0,"A043":1.0,"A044":1.0,"A045":3.0,"A046":2.5,"A047":3.0,"A048":3.0,"A049":2.0,"A050":3.5,"A051":2.0,"A052":1.0,"A053":1.5,"A054":3.0,"A055":1.5,"A056":3.0,"A057":3.0,"A058":2.0,"A059":5.0,"A060":3.5,"B001":4.0,"B002":4.0,"B003":4.0,"B004":4.0,"B005":4.5,"B006":5.0,"B007":5.0,"B008":5.0,"B009":5.0,"B010":4.0,"B011":5.0,"B012":5.0,"B013":4.0,"B014":5.0,"B015":4.5,"B016":4.0,"B017":5.0,"B018":5.0,"B019":4.0,"B020":4.0,"B021":5.0,"B022":5.0,"B023":4.0,"B024":4.0,"B025":4.0,"B026":4.0,"B027":4.0,"B028":5.0,"B029":5.0,"B030":5.0,"C001":5.0,"C002":5.0,"C003":5.0,"C004":5.0,"C005":5.0,"C006":5.0,"C007":5.0,"C008":5.0,"C009":5.0,"C010":5.0},
  hardRejectAt: 5,
  subjectImportance: {
    it: 100,
    algebra: 90,
    programming: 80,
    digital: 70,
    law: 55,
    logic: 30,
    english: 20
  },
  lectureRequirements: [
    { key: "lecture:logic", subjectId: "logic", alternatives: ["logic-p01"] },
    { key: "lecture:algebra", subjectId: "algebra", alternatives: ["algebra-p01"] },
    { key: "lecture:programming:p01", subjectId: "programming", alternatives: ["programming-p01"] },
    { key: "lecture:programming:p02", subjectId: "programming", alternatives: ["programming-p02"] },
    { key: "lecture:digital", subjectId: "digital", alternatives: ["digital-p02", "digital-p01"] }
  ],
  slotPenalty: [8, 0, 2, 7, 18, 32, 48],
  thursdaySlotPenalty: [0, 8, 18, 35, 60, 95, 140],
  rules: {
    ratingWeight: 600,
    thursdayBasePenalty: 320,
    fridayBasePenalty: 2200,
    extraSchoolDayPenalty: 160,
    gapPenalty: 12,
    robustnessAveragePenalty: 260,
    robustnessWeakLinkPenalty: 520,
    concurrencyLimit: 2,
    batchMinimumMassRatio: 0.02
  }
};

/* bundled from scripts/userscript-runtime.js — edit the source file, then run npm run build:userscript */
(() => {
  "use strict";

  const PORTLET_BASE = "/wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection";
  const LOCAL_KEY = "edison-rozvrh-assistant-v1";
  const core = window.ROZVRH_OPTIMIZER;
  const optimizer = core.createOptimizer({
    data: window.ROZVRH_DATA,
    fixedPlans: window.ROZVRH_FIXED_PLANS,
    preferences: window.ROZVRH_PREFERENCES
  });

  const runtime = {
    mode: "OFF",
    registration: "UNKNOWN",
    obligations: new Map(),
    liveActivities: [],
    loadedSubjects: 0,
    message: "Inicializujem read-only dáta…",
    armedUntil: 0,
    abortControllers: new Set(),
    running: false,
    dryRunVisible: false,
    dryRunResult: null
  };

  function defaultLocalState() {
    return { locked: {}, unavailable: [], history: [] };
  }

  function loadLocalState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
      return parsed && typeof parsed === "object" ? { ...defaultLocalState(), ...parsed } : defaultLocalState();
    } catch {
      return defaultLocalState();
    }
  }

  let localState = loadLocalState();
  let panel;

  function saveLocalState() {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localState));
  }

  function optimizerState() {
    return { ...localState, liveActivities: runtime.liveActivities };
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function portletId() {
    const table = document.querySelector('[id$=":subjectsTable"]');
    return table?.id.replace(":subjectsTable", "") || "";
  }

  function discoverObligations() {
    const table = document.querySelector('[id$=":subjectsTable"]');
    if (!table) throw new Error("Na tejto stránke nevidím tabuľku predmetov EDISONu.");
    const found = new Map();
    for (const row of table.querySelectorAll("tr")) {
      const title = row.querySelector("abbr[title*='Číslo předmětu']")?.getAttribute("title") || "";
      const courseNumber = title.match(/\d{3}-\d{4}\/\d{2}/)?.[0];
      const code = courseNumber?.replace(/\D/g, "");
      const onclick = row.querySelector('a[onclick*="selectStudyYearObligation"]')?.getAttribute("onclick") || "";
      const studyYearObligationId = Number(onclick.match(/\((\d+)\)/)?.[1]);
      if (code && studyYearObligationId) found.set(code, { code, courseNumber, studyYearObligationId });
    }
    runtime.obligations = found;
    return found;
  }

  async function requestJson(method, path, { allowNetworkRetry = false } = {}) {
    const id = portletId();
    if (!id) throw Object.assign(new Error("Portlet ID nebol nájdený."), { code: "AUTH_EXPIRED" });
    const url = method === "GET" ? `${PORTLET_BASE}/${path}?${new URLSearchParams({ portletId: id, _: Date.now() })}` : `${PORTLET_BASE}/${path}`;
    const controller = new AbortController();
    runtime.abortControllers.add(controller);
    try {
      const response = await fetch(url, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: method === "PUT" ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json" } : { Accept: "application/json" },
        body: method === "PUT" ? new URLSearchParams({ portletId: id }) : undefined,
        signal: controller.signal,
        redirect: "follow"
      });
      const contentType = response.headers.get("content-type") || "";
      if (response.redirected || !contentType.toLowerCase().includes("json")) {
        throw Object.assign(new Error("EDISON nevrátil JSON; prihlásenie pravdepodobne vypršalo."), { code: "AUTH_EXPIRED", status: response.status, contentType });
      }
      const payload = await response.json();
      return { payload, status: response.status, contentType };
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(error, { code: "STOPPED" });
      if (error.code) throw error;
      if (allowNetworkRetry) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        return requestJson(method, path, { allowNetworkRetry: false });
      }
      throw Object.assign(error, { code: "NETWORK_ERROR" });
    } finally {
      runtime.abortControllers.delete(controller);
    }
  }

  async function mapLimit(items, limit, worker) {
    const result = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        result[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return result;
  }

  function mergeActivities(payload) {
    const incoming = core.extractActivityDtos(payload).map(optimizer.normalizeActivity).filter((item) => item.localSessionId);
    const merged = new Map(runtime.liveActivities.map((item) => [item.localSessionId, item]));
    incoming.forEach((item) => merged.set(item.localSessionId, item));
    runtime.liveActivities = [...merged.values()];
    syncSelectedFromServer();
  }

  function syncSelectedFromServer() {
    for (const activity of runtime.liveActivities.filter((item) => item.selected)) {
      if (activity.type === "C") localState.locked[activity.subjectId] = activity.concreteActivityId;
      else {
        const requirement = (window.ROZVRH_PREFERENCES.lectureRequirements || []).find((item) => item.alternatives.includes(activity.localSessionId));
        if (requirement) localState.locked[requirement.key] = activity.concreteActivityId;
      }
    }
    saveLocalState();
  }

  async function refreshData({ silent = false } = {}) {
    if (runtime.running) return;
    runtime.message = "Načítavam registračný stav a 7 predmetov…";
    runtime.loadedSubjects = 0;
    if (!silent) render();
    try {
      const refresh = await requestJson("GET", "refreshPage");
      runtime.registration = refresh.payload.opened === true ? "OPEN" : "CLOSED";
      mergeActivities(refresh.payload);
      const obligations = discoverObligations();
      const subjects = window.ROZVRH_DATA.subjects.filter((subject) => window.ROZVRH_FIXED_PLANS.subjects.includes(subject.id));
      const missing = subjects.filter((subject) => !obligations.has(subject.code));
      if (missing.length) throw new Error(`Chýba mapping: ${missing.map((item) => item.short).join(", ")}`);
      const responses = await mapLimit(subjects, 2, async (subject) => {
        const mapping = obligations.get(subject.code);
        const response = await requestJson("PUT", `selectStudyYearObligation/${mapping.studyYearObligationId}`);
        runtime.loadedSubjects += 1;
        mergeActivities(response.payload);
        render();
        return response.payload;
      });
      responses.forEach(mergeActivities);
      runtime.message = `Dáta načítané ${new Date().toLocaleTimeString("sk-SK")}.`;
    } catch (error) {
      if (error.code === "AUTH_EXPIRED") stop("AUTH_EXPIRED — znovu sa prihlás do EDISONu.");
      else runtime.message = `${error.code || "CHYBA"}: ${error.message}`;
    }
    render();
  }

  function stop(message = "STOP — ďalšie requesty sú zablokované.") {
    runtime.abortControllers.forEach((controller) => controller.abort());
    runtime.abortControllers.clear();
    runtime.running = false;
    runtime.mode = "STOPPED";
    runtime.armedUntil = 0;
    runtime.message = message;
    render();
  }

  function arm() {
    if (runtime.running) return;
    if (runtime.loadedSubjects !== 7) {
      runtime.message = "ARM odmietnutý: najprv musí byť načítaných 7/7 predmetov.";
      render();
      return;
    }
    if (runtime.registration !== "OPEN") {
      runtime.message = "ARM odmietnutý: EDISON hlási zatvorenú registráciu.";
      render();
      return;
    }
    runtime.mode = "ARMED";
    runtime.armedUntil = Date.now() + 60_000;
    runtime.message = "ARMED na 60 sekúnd. Zápis začne až po samostatnom kliknutí START.";
    render();
  }

  async function submitCandidate(candidate) {
    const activityId = candidate.activity.concreteActivityId;
    if (!Number.isFinite(activityId)) return { ok: false, code: "UNKNOWN_SERVER_ERROR", message: "Chýba concreteActivityId." };
    try {
      const response = await requestJson("PUT", `selectConcreteActivity/${activityId}`, { allowNetworkRetry: true });
      mergeActivities(response.payload);
      const outcome = core.classifyActivityResponse({ ...response, activityId });
      const value = activityId;
      if (outcome.ok) localState.locked[candidate.requirementKey] = value;
      else if (["FULL", "COLLISION"].includes(outcome.code) && !localState.unavailable.map(String).includes(String(value))) localState.unavailable.push(value);
      localState.history.push({ at: Date.now(), result: outcome.code, subjectId: candidate.subjectId, group: candidate.activity.group, concreteActivityId: value });
      saveLocalState();
      runtime.message = `${candidate.subject?.short || candidate.subjectId} ${candidate.activity.group}: ${outcome.code} — ${outcome.message}`;
      render();
      return outcome;
    } catch (error) {
      const code = error.code || "NETWORK_ERROR";
      const outcome = { ok: false, code, message: error.message };
      runtime.message = `${candidate.subject?.short || candidate.subjectId}: ${code} — ${error.message}`;
      render();
      return outcome;
    }
  }

  async function start() {
    if (runtime.mode !== "ARMED" || Date.now() > runtime.armedUntil) {
      runtime.mode = "OFF";
      runtime.message = "START odmietnutý: najprv klikni ARM; ARM platí 60 sekúnd.";
      render();
      return;
    }
    if (runtime.registration !== "OPEN") return stop("REGISTRATION_CLOSED — zápis sa nespustil.");
    runtime.mode = "RUNNING";
    runtime.running = true;
    render();
    while (runtime.running) {
      const result = optimizer.analyze(optimizerState());
      if (result.noAcceptableLayout) return stop("STOP: nezostal žiadny prijateľný layout (5/5 sa nepoužije). ");
      if (result.complete) return stop("HOTOVO: všetky požadované cvičenia aj prednášky sú potvrdené.");
      const batch = result.safeBatch.filter((item) => Number.isFinite(item.activity.concreteActivityId));
      if (!batch.length) return stop("STOP: ďalší bezpečný krok nemá concreteActivityId alebo nemá voľnú alternatívu.");
      runtime.message = `Posielam bezpečný batch ${batch.map((item) => `${item.subject?.short} ${item.activity.group}`).join(" + ")}…`;
      render();
      const outcomes = await Promise.all(batch.map(submitCandidate));
      const fatal = outcomes.find((outcome) => ["REGISTRATION_CLOSED", "AUTH_EXPIRED", "UNKNOWN_SERVER_ERROR"].includes(outcome.code));
      if (fatal) return stop(`${fatal.code} — ${fatal.message}`);
      if (outcomes.some((outcome) => outcome.code === "NETWORK_ERROR")) return stop("NETWORK_ERROR — po jednom kontrolovanom retry zastavujem.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  function safeLiveSnapshot() {
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      registration: runtime.registration,
      liveActivities: runtime.liveActivities.map((item) => ({
        subjectVersionScheduleCode: item.subjectVersionScheduleCode,
        concreteActivityId: item.concreteActivityId,
        concreteActivityCode: item.concreteActivityCode,
        group: item.group,
        weekDayTitle: item.weekDayTitle,
        scheduleWindowBeginTime: item.scheduleWindowBeginTime,
        concreteActivityCapacity: item.concreteActivityCapacity,
        studentsCount: item.studentsCount,
        hasFreePlaces: item.hasFreePlaces,
        hasCollision: item.hasCollision,
        selected: item.selected
      }))
    };
  }

  async function copyLiveSnapshot() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(safeLiveSnapshot()));
      runtime.message = "Bezpečný LIVE JSON skopírovaný — neobsahuje cookies, tokeny ani identitu.";
    } catch (error) {
      runtime.message = `Kopírovanie zlyhalo: ${error.message}`;
    }
    render();
  }

  async function dryRun() {
    runtime.dryRunVisible = true;
    await refreshData({ silent: true });
    runtime.dryRunResult = optimizer.analyze(optimizerState());
    runtime.message = "DRY RUN hotový. Nebol zavolaný selectConcreteActivity.";
    render();
  }

  function resetLocal() {
    stop("Lokálny stav vymazaný; serverové zápisy sa nemenia.");
    localState = defaultLocalState();
    saveLocalState();
    runtime.mode = "OFF";
    refreshData();
  }

  function metric(value) {
    return Number(value || 0).toLocaleString("sk-SK", { maximumFractionDigits: 2 });
  }

  function render() {
    if (!panel) return;
    const result = optimizer.analyze(optimizerState());
    const next = result.priorities[0];
    const capacity = next?.activity.concreteActivityCapacity == null ? "—" : `${next.activity.studentsCount ?? "?"} / ${next.activity.concreteActivityCapacity}`;
    const regClass = runtime.registration === "OPEN" ? "ok" : runtime.registration === "CLOSED" ? "bad" : "warn";
    const autoClass = runtime.mode === "RUNNING" ? "bad" : runtime.mode === "ARMED" ? "warn" : "";
    let branches = "";
    if (runtime.dryRunVisible && runtime.dryRunResult) {
      const dry = runtime.dryRunResult;
      branches = `<div class="era-dry"><strong>DRY RUN · Batch 1</strong><div>${dry.safeBatch.map((item) => `${escapeHtml(item.subject?.short)} ${escapeHtml(item.type)} ${escapeHtml(item.activity.group)}`).join(" + ") || "žiadny"}</div>${dry.batchOutcomes.map((branch) => `<small>${escapeHtml(branch.labels.join(" + "))} → ${branch.remainingCount} layoutov · mass ${metric(branch.qualityMass)}</small>`).join("")}</div>`;
    }
    panel.innerHTML = `<div class="era-head"><strong>EDISON Rozvrh Assistant</strong><button data-action="collapse" title="Minimalizovať">−</button></div>
      <div class="era-body">
        <div class="era-status"><span>● pripravený</span><span>● načítané predmety: ${runtime.loadedSubjects}/7</span><span class="${regClass}">● registrácia: ${runtime.registration.toLowerCase()}</span><span class="${autoClass}">● AUTO: ${runtime.mode}</span></div>
        <div class="era-message">${escapeHtml(runtime.message)}</div>
        <div class="era-next"><small>Ďalší odporúčaný krok</small><strong>${next ? `${escapeHtml(next.subject?.short)} · ${escapeHtml(next.type)} ${escapeHtml(next.activity.group)}` : result.complete ? "HOTOVO" : "—"}</strong><span>${next ? `${escapeHtml(window.ROZVRH_DATA.days[next.activity.day])} ${escapeHtml(window.ROZVRH_DATA.slots[next.activity.slot])} · ${escapeHtml(capacity)} · ID ${escapeHtml(next.activity.concreteActivityId ?? "—")}` : ""}</span><span>${next ? `risk ${escapeHtml(next.riskLevel)} · ${escapeHtml(next.reason)}` : ""}</span></div>
        <div class="era-metrics"><span>layouty<strong>${result.remainingCount}</strong></span><span>quality mass<strong>${metric(result.qualityMass)}</strong></span><span>best rating<strong>${result.bestRemainingRating ?? "—"}/5</strong></span><span>robust target<strong>${escapeHtml(result.targetInfo?.plan?.id || "—")}</strong></span></div>
        ${branches}
        <div class="era-actions"><button data-action="refresh">REFRESH DATA</button><button data-action="dry">DRY RUN</button><button data-action="copy">COPY LIVE JSON</button><button class="arm" data-action="arm">ARM</button><button class="start" data-action="start" ${runtime.mode !== "ARMED" ? "disabled" : ""}>START</button><button class="stop" data-action="stop">STOP</button><button data-action="reset">UNDO / RESET LOCAL STATE</button></div>
        <small class="era-foot">AUTO sa po reloade nikdy nespustí. STOP zastaví ďalšie requesty. Reset nikdy nevolá unselect endpoint.</small>
      </div>`;
  }

  function installPanel() {
    const style = document.createElement("style");
    style.textContent = `#edison-rozvrh-assistant{position:fixed;right:16px;bottom:16px;width:min(430px,calc(100vw - 24px));z-index:2147483647;background:#0b1220;color:#e5eefc;border:1px solid #334155;border-radius:14px;box-shadow:0 20px 60px #0008;font:13px/1.4 system-ui,sans-serif}#edison-rozvrh-assistant *{box-sizing:border-box}.era-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #334155}.era-head button{width:28px}.era-body{padding:12px}.era-status{display:grid;grid-template-columns:1fr 1fr;gap:4px;color:#94a3b8}.era-status .ok{color:#4ade80}.era-status .bad{color:#fb7185}.era-status .warn{color:#fbbf24}.era-message{margin:9px 0;padding:8px;background:#111c30;border-radius:8px;color:#cbd5e1}.era-next{display:flex;flex-direction:column;gap:3px;padding:10px;border:1px solid #334155;border-radius:10px}.era-next strong{font-size:17px}.era-next span{color:#a9b8cc}.era-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:8px 0}.era-metrics span{display:flex;flex-direction:column;padding:6px;background:#111c30;border-radius:7px;color:#94a3b8;font-size:10px}.era-metrics strong{color:#fff;font-size:13px}.era-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.era-actions button,.era-head button{border:1px solid #475569;border-radius:7px;background:#1e293b;color:#fff;padding:7px;cursor:pointer;font-weight:700}.era-actions button:disabled{opacity:.4;cursor:not-allowed}.era-actions .arm{border-color:#fbbf24}.era-actions .start{background:#166534;border-color:#4ade80}.era-actions .stop{background:#7f1d1d;border-color:#fb7185}.era-dry{display:flex;flex-direction:column;gap:4px;margin:8px 0;padding:8px;border:1px solid #38bdf8;border-radius:8px}.era-foot{display:block;margin-top:8px;color:#94a3b8}#edison-rozvrh-assistant.collapsed .era-body{display:none}`;
    document.head.appendChild(style);
    panel = document.createElement("aside");
    panel.id = "edison-rozvrh-assistant";
    panel.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "collapse") panel.classList.toggle("collapsed");
      if (action === "refresh") refreshData();
      if (action === "dry") dryRun();
      if (action === "copy") copyLiveSnapshot();
      if (action === "arm") arm();
      if (action === "start") start();
      if (action === "stop") stop();
      if (action === "reset") resetLocal();
    });
    document.body.appendChild(panel);
    render();
  }

  installPanel();
  refreshData();
})();
