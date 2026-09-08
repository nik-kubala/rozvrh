(() => {
  "use strict";

  const core = window.ROZVRH_OPTIMIZER;
  if (!core?.createOptimizer || core.__teacherPreferencePatchApplied) return;
  core.__teacherPreferencePatchApplied = true;

  const originalCreateOptimizer = core.createOptimizer.bind(core);

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  function teacherNames(activity) {
    const values = [activity?.teacherShortNamesString, activity?.teacherShortNamesAbbrev];
    return [...new Set(values.flatMap((value) => String(value || "").split(",").map((name) => fold(name)).filter(Boolean)))];
  }

  core.createOptimizer = function createOptimizerWithTeacherPreferences(options) {
    const optimizer = originalCreateOptimizer(options);
    const teacherPreferences = options?.preferences?.teacherPreferences || {};
    const preferred = new Set((teacherPreferences.preferred || []).map(fold));
    const lastChoice = new Set((teacherPreferences.lastChoice || []).map(fold));
    const originalAnalyze = optimizer.analyze.bind(optimizer);

    function teacherRank(activity) {
      const names = teacherNames(activity);
      if (names.some((name) => preferred.has(name))) return 0;
      if (names.some((name) => lastChoice.has(name))) return 2;
      return 1;
    }

    function unavailableSet(state) {
      return new Set((state?.unavailable || []).map(String));
    }

    function canUse(activity, unavailable) {
      if (!activity || activity.type !== "C") return false;
      if (activity.hasFreePlaces === false || activity.hasCollision === true) return false;
      if (unavailable.has(String(activity.localSessionId)) || unavailable.has(String(activity.concreteActivityId))) return false;
      return true;
    }

    function rewritePriority(priority, result, state) {
      if (!priority || priority.type !== "C" || !priority.activity) return priority;
      const unavailable = unavailableSet(state);
      const current = priority.activity;
      const currentRank = teacherRank(current);
      const candidates = (result.liveActivities || []).filter((activity) =>
        activity.subjectId === priority.subjectId &&
        activity.type === "C" &&
        activity.day === priority.coord?.day &&
        activity.slot === priority.coord?.slot &&
        canUse(activity, unavailable)
      );
      if (candidates.length < 2) return priority;

      const better = candidates
        .filter((activity) => teacherRank(activity) < currentRank)
        .sort((a, b) =>
          teacherRank(a) - teacherRank(b) ||
          core.capacityPressure(b) - core.capacityPressure(a) ||
          String(a.group || "").localeCompare(String(b.group || ""))
        )[0];

      if (!better) return priority;
      priority.activity = better;
      priority.capacityPressure = core.capacityPressure(better);
      return priority;
    }

    optimizer.analyze = function analyzeWithTeacherPreferences(state = {}) {
      const result = originalAnalyze(state);
      const seen = new Set();
      for (const list of [result.exercisePriorities, result.priorities, result.safeBatch]) {
        for (const priority of list || []) {
          if (seen.has(priority)) continue;
          seen.add(priority);
          rewritePriority(priority, result, state);
        }
      }
      return result;
    };

    return optimizer;
  };
})();
