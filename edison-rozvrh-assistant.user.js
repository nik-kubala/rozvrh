// ==UserScript==
// @name         EDISON Rozvrh Assistant
// @namespace    https://github.com/nik-kubala/rozvrh
// @version      2.1.0
// @description  Jedným klikom spustí adaptívny zápis rozvrhu VŠB-TUO; sám obnoví LIVE dáta a bezpečne čaká na 10:00.
// @author       nik-kubala
// @match        https://edison.sso.vsb.cz/wps/*
// @updateURL    https://raw.githubusercontent.com/nik-kubala/rozvrh/main/edison-rozvrh-assistant.user.js
// @downloadURL  https://raw.githubusercontent.com/nik-kubala/rozvrh/main/edison-rozvrh-assistant.user.js
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
  const PORTLET_FALLBACK = "ns_Z7_SHD09B1A084V90ITII3I3Q30P7_";
  const OPEN_AT = new Date("2026-09-08T10:00:00+02:00").getTime();
  const PREFLIGHT_LEAD_MS = 10_000;
  const FRESH_FOR_START_MS = 30_000;
  const BOUNDARY_RETRY_UNTIL_MS = 6_000;
  const BOUNDARY_RETRY_DELAY_MS = 350;
  const BOUNDARY_RETRY_LIMIT = 6;
  const core = window.ROZVRH_OPTIMIZER;

  // Current-semester fallback only. Dynamic DOM discovery is preferred; every
  // fallback mapping is validated against the returned subject data before use.
  const KNOWN_OBLIGATIONS = new Map([
    ["440210401", 7860483], // ZDS
    ["460205103", 7860492], // ULM
    ["460205205", 7860487], // UPR
    ["460207901", 7860488], // ZIT
    ["470220501", 7860490], // LA
    ["711043901", 7860499], // PvICT
    ["712012401", 7860493]  // A/I-FEI
  ]);

  if (!core || !window.ROZVRH_DATA || !window.ROZVRH_FIXED_PLANS || !window.ROZVRH_PREFERENCES) {
    console.error("EDISON Rozvrh Assistant: bundled optimizer data are missing.");
    return;
  }

  const optimizer = core.createOptimizer({
    data: window.ROZVRH_DATA,
    fixedPlans: window.ROZVRH_FIXED_PLANS,
    preferences: window.ROZVRH_PREFERENCES
  });

  const runtime = {
    mode: "LOADING",
    registration: "UNKNOWN",
    obligations: new Map(),
    liveActivities: [],
    loadedSubjects: 0,
    message: "Načítavam EDISON dáta…",
    abortControllers: new Set(),
    running: false,
    loadingPromise: null,
    lastLoadedAt: 0,
    history: [],
    preflightTimer: null,
    startTimer: null,
    everStarted: false
  };

  let localState = { locked: {}, unavailable: [] };
  let panel;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function portletId() {
    const exact = document.querySelector('[id$=":subjectsTable"]');
    if (exact?.id) return exact.id.replace(/:subjectsTable$/, "");

    const loose = document.querySelector('[id*="subjectsTable"]');
    if (loose?.id) return loose.id.replace(/:subjectsTable.*$/, "");

    const hidden = document.querySelector('input[name="portletId"]');
    if (hidden?.value) return hidden.value;

    // Try to derive the namespace from any element close to the schedule portlet.
    const scheduleLink = document.querySelector('[onclick*="selectStudyYearObligation"]');
    let node = scheduleLink;
    for (let i = 0; node && i < 7; i += 1, node = node.parentElement) {
      const ownId = node.id || "";
      const match = ownId.match(/^(ns_Z7_[A-Z0-9]+_?)(?::|$)/i);
      if (match) return match[1].endsWith("_") ? match[1] : `${match[1]}_`;
      const child = node.querySelector?.('[id^="ns_Z7_"]');
      const childMatch = child?.id?.match(/^(ns_Z7_[A-Z0-9]+_?)(?::|$)/i);
      if (childMatch) return childMatch[1].endsWith("_") ? childMatch[1] : `${childMatch[1]}_`;
    }

    // This is the exact portlet namespace observed for the VŠB schedule-selection
    // portlet. Keeping it as a final fallback avoids a false PAGE_NOT_READY when
    // EDISON renders the subject list lazily.
    return PORTLET_FALLBACK;
  }

  function courseCodeNear(element) {
    let node = element;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const titles = Array.from(node.querySelectorAll?.("abbr[title]") || [])
        .map((item) => item.getAttribute("title") || "")
        .join(" ");
      const text = `${titles} ${node.textContent || ""}`;
      const match = text.match(/\d{3}-\d{4}\/\d{2}/);
      if (match) return match[0].replace(/\D/g, "");
    }
    return "";
  }

  function discoverObligations() {
    const found = new Map();

    // Do not depend on a specific table id. EDISON can render the portlet after
    // document-idle or wrap it differently; the action links are the stable part.
    for (const link of document.querySelectorAll('[onclick*="selectStudyYearObligation"]')) {
      const onclick = link.getAttribute("onclick") || "";
      const id = Number(
        onclick.match(/selectStudyYearObligation\s*\(\s*(\d+)\s*\)/)?.[1]
        || onclick.match(/\((\d+)\)/)?.[1]
      );
      const code = courseCodeNear(link);
      if (code && Number.isFinite(id)) found.set(code, id);
    }

    // Current-semester validated fallback. This makes the script usable even when
    // the list is not yet present in the DOM, which is exactly what caused the
    // PAGE_NOT_READY screenshot.
    for (const [code, id] of KNOWN_OBLIGATIONS) {
      if (!found.has(code)) found.set(code, id);
    }

    runtime.obligations = found;
    return found;
  }

  async function requestJson(method, path, { allowNetworkRetry = false } = {}) {
    const id = portletId();
    if (!id) throw Object.assign(new Error("Portlet ID nebol nájdený."), { code: "PAGE_NOT_READY" });

    const url = method === "GET"
      ? `${PORTLET_BASE}/${path}?${new URLSearchParams({ portletId: id, _: Date.now() })}`
      : `${PORTLET_BASE}/${path}`;

    const controller = new AbortController();
    runtime.abortControllers.add(controller);

    try {
      const headers = {
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest"
      };
      if (method === "PUT") headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";

      const response = await fetch(url, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: method === "PUT" ? new URLSearchParams({ portletId: id }) : undefined,
        signal: controller.signal,
        redirect: "follow"
      });

      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error(`EDISON vrátil HTTP ${response.status}.`), { code: "AUTH_EXPIRED", status: response.status });
      }

      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        const folded = text.toLowerCase();
        const looksLikeLogin = /<html|<form|login|prihl|přihl|sso|ltpatoken/.test(folded);
        const code = looksLikeLogin ? "AUTH_EXPIRED" : "UNKNOWN_SERVER_ERROR";
        throw Object.assign(new Error(`${code}: EDISON nevrátil JSON. ${text.slice(0, 180).replace(/\s+/g, " ")}`), {
          code,
          status: response.status,
          contentType
        });
      }

      return { payload, status: response.status, contentType, redirected: response.redirected };
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(error, { code: "STOPPED" });
      if (error.code) throw error;
      if (allowNetworkRetry) {
        await sleep(500);
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

  function normalizedDtos(payload) {
    return core.extractActivityDtos(payload)
      .map(optimizer.normalizeActivity)
      .filter((item) => item.subjectId && item.localSessionId && Number.isFinite(item.concreteActivityId));
  }

  function mergeActivities(payload) {
    const incoming = normalizedDtos(payload);
    const merged = new Map(runtime.liveActivities.map((item) => [item.localSessionId, item]));
    incoming.forEach((item) => merged.set(item.localSessionId, item));
    runtime.liveActivities = [...merged.values()];
  }

  function reconcileServerSelections() {
    const nextLocked = {};
    for (const activity of runtime.liveActivities.filter((item) => item.selected === true)) {
      if (activity.type === "C") {
        nextLocked[activity.subjectId] = activity.concreteActivityId;
      } else {
        const requirement = (window.ROZVRH_PREFERENCES.lectureRequirements || [])
          .find((item) => item.alternatives.includes(activity.localSessionId));
        if (requirement) nextLocked[requirement.key] = activity.concreteActivityId;
      }
    }
    localState.locked = nextLocked;
  }

  function optimizerState() {
    const unavailable = new Set(localState.unavailable.map(String));
    for (const activity of runtime.liveActivities) {
      if (activity.selected) continue;
      if (activity.hasCollision === true || activity.hasFreePlaces === false) {
        unavailable.add(String(activity.concreteActivityId));
        unavailable.add(String(activity.localSessionId));
      }
    }
    return {
      locked: { ...localState.locked },
      unavailable: [...unavailable],
      liveActivities: runtime.liveActivities
    };
  }

  async function loadAllSubjects({ resetFailures = true, label = "Načítavam 7 predmetov…" } = {}) {
    if (runtime.loadingPromise) return runtime.loadingPromise;
    if (runtime.running) return;

    const preserveWaiting = runtime.mode === "WAITING";
    if (!preserveWaiting) runtime.mode = "LOADING";
    runtime.message = label;
    runtime.loadedSubjects = 0;
    render();

    runtime.loadingPromise = (async () => {
      try {
        const obligations = discoverObligations();
        const subjects = window.ROZVRH_DATA.subjects
          .filter((subject) => window.ROZVRH_FIXED_PLANS.subjects.includes(subject.id));
        const missing = subjects.filter((subject) => !obligations.has(String(subject.code)));
        if (missing.length) {
          throw Object.assign(new Error(`Chýba EDISON mapping: ${missing.map((item) => item.short).join(", ")}`), { code: "MAPPING_ERROR" });
        }

        const responses = await mapLimit(subjects, 2, async (subject) => {
          const obligationId = obligations.get(String(subject.code));
          const response = await requestJson("PUT", `selectStudyYearObligation/${obligationId}`);
          const activities = normalizedDtos(response.payload).filter((activity) => activity.subjectId === subject.id);
          if (!activities.length) {
            throw Object.assign(
              new Error(`EDISON obligation ${obligationId} nevrátil očakávaný predmet ${subject.short}.`),
              { code: "MAPPING_ERROR" }
            );
          }
          runtime.loadedSubjects += 1;
          render();
          return { subject, activities };
        });

        // Authoritative full snapshot: no stale IDs or capacities survive a refresh.
        const fresh = new Map();
        for (const { activities } of responses) {
          for (const activity of activities) fresh.set(activity.localSessionId, activity);
        }
        runtime.liveActivities = [...fresh.values()];

        const missingExercises = subjects.filter((subject) =>
          !runtime.liveActivities.some((activity) => activity.subjectId === subject.id && activity.type === "C"));
        if (missingExercises.length) {
          throw Object.assign(new Error(`Nenamapovali sa cvičenia: ${missingExercises.map((item) => item.short).join(", ")}`), { code: "MAPPING_ERROR" });
        }

        const missingLectures = (window.ROZVRH_PREFERENCES.lectureRequirements || []).filter((requirement) =>
          !(requirement.alternatives || []).some((id) => runtime.liveActivities.some((activity) => activity.localSessionId === id)));
        if (missingLectures.length) {
          throw Object.assign(new Error(`Nenamapovali sa prednášky: ${missingLectures.map((item) => item.key).join(", ")}`), { code: "MAPPING_ERROR" });
        }

        reconcileServerSelections();
        if (resetFailures) localState.unavailable = [];
        runtime.loadedSubjects = subjects.length;
        runtime.lastLoadedAt = Date.now();
        if (!preserveWaiting) runtime.mode = "READY";
        runtime.message = preserveWaiting
          ? `Predštartové LIVE dáta sú čerstvé: 7/7. Čakám na 10:00 — nič neklikaj.`
          : `Pripravené: 7/7 predmetov · ${runtime.liveActivities.length} LIVE jednotiek.`;
      } catch (error) {
        runtime.loadedSubjects = 0;
        if (!preserveWaiting) runtime.mode = "ERROR";
        runtime.message = `${error.code || "CHYBA"}: ${error.message}`;
        throw error;
      } finally {
        runtime.loadingPromise = null;
        render();
      }
    })();

    return runtime.loadingPromise;
  }

  function stop(message = "STOP — ďalšie zápisové requesty sú zastavené.") {
    runtime.abortControllers.forEach((controller) => controller.abort());
    runtime.abortControllers.clear();
    if (runtime.startTimer) clearTimeout(runtime.startTimer);
    runtime.startTimer = null;
    runtime.running = false;
    runtime.mode = "STOPPED";
    runtime.message = message;
    render();
  }

  function exercisePassedCount() {
    return window.ROZVRH_FIXED_PLANS.subjects.filter((id) => Boolean(localState.locked[id])).length;
  }

  function lecturePassedCount() {
    return (window.ROZVRH_PREFERENCES.lectureRequirements || [])
      .filter((item) => Boolean(localState.locked[item.key])).length;
  }

  async function selectOnce(candidate) {
    const activityId = Number(candidate.activity.concreteActivityId);
    if (!Number.isFinite(activityId)) {
      return { ok: false, code: "UNKNOWN_SERVER_ERROR", message: "Chýba concreteActivityId." };
    }

    try {
      const response = await requestJson("PUT", `selectConcreteActivity/${activityId}`, { allowNetworkRetry: true });
      mergeActivities(response.payload);
      const outcome = core.classifyActivityResponse({ ...response, activityId });
      if (outcome.ok) runtime.registration = "OPEN";
      else if (outcome.code === "REGISTRATION_CLOSED") runtime.registration = "CLOSED";
      return outcome;
    } catch (error) {
      return { ok: false, code: error.code || "NETWORK_ERROR", message: error.message };
    }
  }

  async function submitCandidate(candidate) {
    const activityId = Number(candidate.activity.concreteActivityId);
    let outcome = null;

    for (let attempt = 0; attempt <= BOUNDARY_RETRY_LIMIT; attempt += 1) {
      outcome = await selectOnce(candidate);
      const insideOpenBoundary = Date.now() >= OPEN_AT - 1_000 && Date.now() <= OPEN_AT + BOUNDARY_RETRY_UNTIL_MS;
      if (outcome.code !== "REGISTRATION_CLOSED" || !insideOpenBoundary || attempt >= BOUNDARY_RETRY_LIMIT) break;
      runtime.message = `EDISON ešte hlási zatvorené — opakujem ${candidate.subject?.short || candidate.subjectId} o ${BOUNDARY_RETRY_DELAY_MS} ms…`;
      render();
      await sleep(BOUNDARY_RETRY_DELAY_MS);
    }

    if (outcome.ok) {
      localState.locked[candidate.requirementKey] = activityId;
    } else if (["FULL", "COLLISION"].includes(outcome.code)) {
      if (!localState.unavailable.map(String).includes(String(activityId))) localState.unavailable.push(activityId);
    }

    runtime.history.push({
      at: Date.now(),
      result: outcome.code,
      subjectId: candidate.subjectId,
      group: candidate.activity.group,
      concreteActivityId: activityId
    });

    runtime.message = `${candidate.subject?.short || candidate.subjectId} ${candidate.activity.group}: ${outcome.code}`;
    render();
    return outcome;
  }

  async function runRegistration() {
    runtime.mode = "RUNNING";
    runtime.running = true;
    runtime.everStarted = true;
    runtime.message = "ZÁPIS BEŽÍ — nič neklikaj. Fallbacky prepočítavam po každej odpovedi.";
    render();

    while (runtime.running) {
      const result = optimizer.analyze(optimizerState());

      if (result.noAcceptableLayout) {
        return stop("STOP: nezostal žiadny z tvojich prijateľných hodnotených rozvrhov. Rating 5/5 nepoužijem.");
      }
      if (result.complete) {
        runtime.running = false;
        runtime.mode = "DONE";
        runtime.message = `HOTOVO — cvičenia ${exercisePassedCount()}/7 PASSED, prednášky ${lecturePassedCount()}/${(window.ROZVRH_PREFERENCES.lectureRequirements || []).length} PASSED.`;
        render();
        return;
      }

      const batch = result.safeBatch
        .filter((item) => Number.isFinite(Number(item.activity.concreteActivityId)))
        .slice(0, 2);
      if (!batch.length) {
        return stop("STOP: optimizer nemá bezpečný ďalší LIVE termín s concreteActivityId.");
      }

      runtime.message = `Zapisujem: ${batch.map((item) => `${item.subject?.short} ${item.activity.group}`).join(" + ")}…`;
      render();
      const outcomes = await Promise.all(batch.map(submitCandidate));

      const fatal = outcomes.find((outcome) => [
        "REGISTRATION_CLOSED",
        "AUTH_EXPIRED",
        "UNKNOWN_SERVER_ERROR",
        "PAGE_NOT_READY",
        "MAPPING_ERROR"
      ].includes(outcome.code));
      if (fatal) return stop(`${fatal.code} — ${fatal.message}`);
      if (outcomes.some((outcome) => outcome.code === "NETWORK_ERROR")) {
        return stop("NETWORK_ERROR — po jednom kontrolovanom retry zastavujem, aby som neposlal duplicitné zápisy.");
      }

      await sleep(20);
    }
  }

  async function ensureFreshThenRun() {
    try {
      if (runtime.loadingPromise) await runtime.loadingPromise;
      const stale = Date.now() - runtime.lastLoadedAt > FRESH_FOR_START_MS;
      if (runtime.loadedSubjects !== 7 || stale) {
        await loadAllSubjects({ resetFailures: true, label: "Posledná LIVE kontrola 7/7 pred zápisom…" });
      }
      if (runtime.loadedSubjects !== 7) {
        throw Object.assign(new Error("Nemám načítaných 7/7 predmetov."), { code: "MAPPING_ERROR" });
      }
      await runRegistration();
    } catch (error) {
      runtime.running = false;
      runtime.mode = "ERROR";
      runtime.message = `${error.code || "CHYBA"}: ${error.message}`;
      render();
    }
  }

  async function start() {
    // One click means one start. Once waiting/running, the main control is disabled
    // and can never accidentally toggle into STOP from the same user action.
    if (runtime.running || runtime.mode === "WAITING" || runtime.mode === "RUNNING" || runtime.mode === "DONE") return;

    try {
      if (runtime.loadingPromise) await runtime.loadingPromise;
      const stale = Date.now() - runtime.lastLoadedAt > FRESH_FOR_START_MS;
      if (runtime.loadedSubjects !== 7 || stale) {
        await loadAllSubjects({ resetFailures: true, label: "Predštartová kontrola 7/7 predmetov…" });
      }
      if (runtime.loadedSubjects !== 7) {
        throw Object.assign(new Error("Nemám načítaných 7/7 predmetov."), { code: "MAPPING_ERROR" });
      }

      if (Date.now() < OPEN_AT) {
        runtime.mode = "WAITING";
        runtime.message = "START prijatý. O 10:00 sa zápis spustí sám. Už nič neklikaj.";
        render();
        runtime.startTimer = setTimeout(async () => {
          runtime.startTimer = null;
          if (runtime.mode !== "WAITING") return;
          await ensureFreshThenRun();
        }, Math.max(0, OPEN_AT - Date.now()));
        return;
      }

      await ensureFreshThenRun();
    } catch (error) {
      runtime.running = false;
      runtime.mode = "ERROR";
      runtime.message = `${error.code || "CHYBA"}: ${error.message}`;
      render();
    }
  }

  function formatTimeUntilOpen() {
    const diff = OPEN_AT - Date.now();
    if (diff <= 0) return "otvorenie 10:00 dosiahnuté";
    const total = Math.ceil(diff / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `do 10:00: ${h ? `${h}h ` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function render() {
    if (!panel) return;
    const result = optimizer.analyze(optimizerState());
    const next = result.priorities[0];
    const cPassed = exercisePassedCount();
    const pTotal = (window.ROZVRH_PREFERENCES.lectureRequirements || []).length;
    const pPassed = lecturePassedCount();
    const capacity = next?.activity.concreteActivityCapacity == null
      ? "—"
      : `${next.activity.studentsCount ?? "?"}/${next.activity.concreteActivityCapacity}`;

    let buttonLabel = "ŠTART ZÁPIS";
    let buttonClass = "start";
    let buttonDisabled = runtime.mode === "LOADING";
    if (runtime.mode === "WAITING") {
      buttonLabel = "ČAKÁM NA 10:00 — SPUSTÍ SA SÁM";
      buttonClass = "waiting";
      buttonDisabled = true;
    } else if (runtime.mode === "RUNNING") {
      buttonLabel = "ZÁPIS BEŽÍ — NIČ NEKLIKAJ";
      buttonClass = "running";
      buttonDisabled = true;
    } else if (runtime.mode === "DONE") {
      buttonLabel = "HOTOVO ✓";
      buttonClass = "done";
      buttonDisabled = true;
    }

    const exerciseClass = cPassed === 7 ? "passed" : "";
    const lectureClass = pPassed === pTotal ? "passed" : "";
    const lastLoaded = runtime.lastLoadedAt ? new Date(runtime.lastLoadedAt).toLocaleTimeString("sk-SK") : "—";

    panel.innerHTML = `<div class="era-head"><strong>EDISON Rozvrh Assistant</strong><span>${escapeHtml(formatTimeUntilOpen())}</span></div>
      <div class="era-body">
        <div class="era-message">${escapeHtml(runtime.message)}</div>
        <div class="era-progress">
          <div class="${exerciseClass}"><span>Cvičenia</span><strong>${cPassed}/7 ${cPassed === 7 ? "PASSED ✓" : ""}</strong></div>
          <div class="${lectureClass}"><span>Prednášky</span><strong>${pPassed}/${pTotal} ${pPassed === pTotal ? "PASSED ✓" : ""}</strong></div>
        </div>
        <div class="era-status"><span>LIVE dáta <strong>${runtime.loadedSubjects}/7</strong></span><span>načítané <strong>${escapeHtml(lastLoaded)}</strong></span><span>layouty <strong>${result.remainingCount}</strong></span><span>best <strong>${result.bestRemainingRating ?? "—"}/5</strong></span></div>
        <div class="era-next"><small>Aktuálne by išiel ako ďalší</small><strong>${next ? `${escapeHtml(next.subject?.short)} · ${escapeHtml(next.type)} ${escapeHtml(next.activity.group)}` : result.complete ? "HOTOVO" : "—"}</strong><span>${next ? `${escapeHtml(window.ROZVRH_DATA.days[next.activity.day])} ${escapeHtml(window.ROZVRH_DATA.slots[next.activity.slot])} · kapacita ${escapeHtml(capacity)} · risk ${escapeHtml(next.riskLevel)}` : ""}</span><small>${next ? escapeHtml(next.reason) : ""}</small></div>
        <button class="era-main ${buttonClass}" data-action="main" ${buttonDisabled ? "disabled" : ""}>${escapeHtml(buttonLabel)}</button>
        <small class="era-foot">EDISON tlačidlo „Obnovit“ nemusíš klikať. Assistant si LIVE dáta načíta sám a 10 s pred 10:00 ich automaticky obnoví. START stlač iba raz.</small>
      </div>`;
  }

  function installPanel() {
    const style = document.createElement("style");
    style.textContent = `#edison-rozvrh-assistant{position:fixed;right:16px;bottom:16px;width:min(440px,calc(100vw - 24px));z-index:2147483647;background:#0b1220;color:#e5eefc;border:1px solid #334155;border-radius:14px;box-shadow:0 20px 60px #0009;font:13px/1.4 system-ui,sans-serif}#edison-rozvrh-assistant *{box-sizing:border-box}.era-head{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:11px 13px;border-bottom:1px solid #334155}.era-head span{color:#93c5fd;font-size:11px}.era-body{padding:12px}.era-message{margin-bottom:9px;padding:9px;background:#111c30;border-radius:8px;color:#dbeafe}.era-progress{display:grid;grid-template-columns:1fr 1fr;gap:7px}.era-progress>div{display:flex;flex-direction:column;padding:10px;background:#111827;border:1px solid #334155;border-radius:9px}.era-progress span{color:#94a3b8;font-size:11px}.era-progress strong{font-size:17px}.era-progress .passed{background:#052e1b;border-color:#22c55e}.era-progress .passed strong{color:#86efac}.era-status{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:8px 0}.era-status span{display:flex;flex-direction:column;padding:6px;background:#111c30;border-radius:7px;color:#94a3b8;font-size:10px}.era-status strong{color:#fff;font-size:12px}.era-next{display:flex;flex-direction:column;gap:3px;padding:10px;border:1px solid #334155;border-radius:10px}.era-next strong{font-size:16px}.era-next span,.era-next small{color:#a9b8cc}.era-main{width:100%;margin-top:10px;padding:13px;border-radius:9px;border:1px solid #4ade80;background:#166534;color:#fff;font-weight:900;font-size:16px;cursor:pointer}.era-main.waiting{background:#1d4ed8;border-color:#60a5fa}.era-main.running{background:#7c3aed;border-color:#c4b5fd}.era-main.done{background:#14532d;border-color:#86efac}.era-main:disabled{opacity:.85;cursor:default}.era-foot{display:block;margin-top:8px;color:#94a3b8}`;
    document.head.appendChild(style);
    panel = document.createElement("aside");
    panel.id = "edison-rozvrh-assistant";
    panel.addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="main"]');
      if (button && !button.disabled) start();
    });
    document.body.appendChild(panel);
    render();
  }

  function scheduleAutomaticPreflight() {
    if (runtime.preflightTimer) clearTimeout(runtime.preflightTimer);
    const delay = OPEN_AT - Date.now() - PREFLIGHT_LEAD_MS;
    if (delay <= 0) return;
    runtime.preflightTimer = setTimeout(async () => {
      runtime.preflightTimer = null;
      if (runtime.running) return;
      try {
        await loadAllSubjects({ resetFailures: true, label: "Automatická predštartová LIVE kontrola 09:59:50…" });
      } catch {
        // If this fails, the 10:00 start path performs one final fresh load too.
      }
    }, delay);
  }

  async function initialLoad() {
    try {
      await loadAllSubjects({ resetFailures: true, label: "Úvodná read-only kontrola 7/7 predmetov…" });
    } catch (firstError) {
      // EDISON often renders portal fragments lazily. One delayed retry catches that
      // without requiring the user to click the page's own refresh button.
      await sleep(1200);
      try {
        await loadAllSubjects({ resetFailures: true, label: "Opakujem načítanie EDISON dát…" });
      } catch {
        // The panel already contains the concrete error. START retries once more.
      }
    }
  }

  installPanel();
  initialLoad();
  scheduleAutomaticPreflight();
  setInterval(render, 1000);
})();
