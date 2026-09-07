(() => {
  "use strict";

  const data = window.ROZVRH_DATA;
  const raw = window.ROZVRH_FIXED_PLANS;
  if (!data || !raw) return;

  const subjectById = new Map(data.subjects.map((subject) => [subject.id, subject]));
  const sessionById = new Map();
  for (const subject of data.subjects) {
    for (const session of subject.sessions) {
      sessionById.set(session.id, { ...session, subjectId: subject.id });
    }
  }

  const preferredTemplate =
    (data.templates || []).find((template) => template.id === "a-compact") ||
    (data.templates || [])[0] ||
    { sessionIds: [] };

  const lectureAnchors = (preferredTemplate.sessionIds || [])
    .map((id) => sessionById.get(id))
    .filter((session) => session?.type === "P");

  const plans = raw.plans.map(([id, tier, score, coords], rank) => {
    const bySubject = {};
    raw.subjects.forEach((subjectId, index) => {
      const [day, slot] = coords[index];
      bySubject[subjectId] = { day, slot };
    });
    return { id, tier, score, rank, bySubject };
  });

  function sessionsAt(subjectId, day, slot) {
    const subject = subjectById.get(subjectId);
    if (!subject) return [];
    return subject.sessions
      .filter((session) => session.type === "C" && session.day === day && session.slot === slot)
      .map((session) => ({ ...session, subjectId }));
  }

  function groupLabel(subjectId, day, slot) {
    const groups = sessionsAt(subjectId, day, slot).map((session) => session.group);
    return groups.join(" / ") || "—";
  }

  function planExerciseEvents(plan) {
    return raw.subjects.map((subjectId) => {
      const coord = plan.bySubject[subjectId];
      const sessions = sessionsAt(subjectId, coord.day, coord.slot);
      return {
        subjectId,
        type: "C",
        day: coord.day,
        slot: coord.slot,
        group: groupLabel(subjectId, coord.day, coord.slot),
        sessionIds: sessions.map((session) => session.id)
      };
    });
  }

  function planEvents(plan) {
    return [...lectureAnchors, ...planExerciseEvents(plan)]
      .sort((a, b) => a.day - b.day || a.slot - b.slot);
  }

  function metrics(plan) {
    const events = planEvents(plan);
    const byDay = new Map();
    for (const event of events) {
      if (!byDay.has(event.day)) byDay.set(event.day, []);
      byDay.get(event.day).push(event.slot);
    }

    let gaps = 0;
    let earliest = null;
    let latest = null;
    for (const slots of byDay.values()) {
      const unique = [...new Set(slots)].sort((a, b) => a - b);
      if (!unique.length) continue;
      gaps += Math.max(0, unique[unique.length - 1] - unique[0] + 1 - unique.length);
      earliest = earliest === null ? unique[0] : Math.min(earliest, unique[0]);
      latest = latest === null ? unique[unique.length - 1] : Math.max(latest, unique[unique.length - 1]);
    }

    return {
      activeDays: byDay.size,
      gaps,
      thursdayFree: !byDay.has(3),
      fridayFree: !byDay.has(4),
      earliest: earliest === null ? "—" : data.slots[earliest].split("–")[0],
      latest: latest === null ? "—" : data.slots[latest].split("–")[1]
    };
  }

  window.ROZVRH_PLAN_UTILS = {
    data,
    raw,
    plans,
    subjectById,
    sessionById,
    lectureAnchors,
    sessionsAt,
    groupLabel,
    planExerciseEvents,
    planEvents,
    metrics
  };
})();