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
