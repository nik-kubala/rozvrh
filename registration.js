(() => {
  "use strict";

  const utils = window.ROZVRH_PLAN_UTILS;
  const prefs = window.ROZVRH_PREFERENCES;
  if (!utils || !prefs) return;

  const {
    data,
    raw,
    plans,
    subjectById,
    sessionById,
    lectureAnchors,
    sessionsAt,
    metrics
  } = utils;

  const STORAGE_KEY = "rozvrh-registration-v3";
  const hardRejectAt = Number(prefs.hardRejectAt || 5);
  const importance = prefs.subjectImportance || {};
  const slotPenalty = prefs.slotPenalty || [8, 0, 2, 7, 18, 32, 48];
  const thursdaySlotPenalty = prefs.thursdaySlotPenalty || [0, 8, 18, 35, 60, 95, 140];
  const rules = prefs.rules || {};

  const preferredTemplate =
    (data.templates || []).find((template) => template.id === "a-compact") ||
    (data.templates || [])[0] ||
    { sessionIds: [] };

  const preferredExerciseBySubject = new Map();
  for (const id of preferredTemplate.sessionIds || []) {
    const session = sessionById.get(id);
    if (session?.type === "C") preferredExerciseBySubject.set(session.subjectId, session);
  }

  function consensusRating(planOrId) {
    const id = typeof planOrId === "string" ? planOrId : planOrId?.id;
    const value = Number(prefs.consensusRatings?.[id]);
    return Number.isFinite(value) ? value : 5;
  }

  function defaultRegistrationState() {
    return { locked: {}, blocked: [], history: [] };
  }

  function loadRegistrationState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return defaultRegistrationState();
      return {
        locked: parsed.locked && typeof parsed.locked === "object" ? parsed.locked : {},
        blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
        history: Array.isArray(parsed.history) ? parsed.history : []
      };
    } catch {
      return defaultRegistrationState();
    }
  }

  let registrationState = loadRegistrationState();
  const undoStack = [];

  const tab = document.getElementById("registrationTab");
  const view = document.getElementById("registrationView");
  if (!tab || !view) return;

  const els = {
    current: document.getElementById("registrationCurrent"),
    yes: document.getElementById("registrationYes"),
    no: document.getElementById("registrationNo"),
    priority: document.getElementById("registrationPriority"),
    progress: document.getElementById("registrationProgress"),
    schedule: document.getElementById("registrationSchedule"),
    history: document.getElementById("registrationHistory"),
    undo: document.getElementById("registrationUndo"),
    reset: document.getElementById("registrationReset")
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function saveRegistrationState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registrationState));
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(registrationState));
  }

  function sameCoord(a, b) {
    return a && b && a.day === b.day && a.slot === b.slot;
  }

  function coordKey(coord) {
    return `${coord.day}:${coord.slot}`;
  }

  function availableSessions(subjectId, coord, extraBlockedId = null) {
    const blocked = new Set(registrationState.blocked);
    if (extraBlockedId) blocked.add(extraBlockedId);
    return sessionsAt(subjectId, coord.day, coord.slot).filter((session) => !blocked.has(session.id));
  }

  function planIsFeasible(plan, extraBlockedId = null) {
    for (const subjectId of raw.subjects) {
      const coord = plan.bySubject[subjectId];
      const lockedId = registrationState.locked[subjectId];
      if (lockedId) {
        const locked = sessionById.get(lockedId);
        if (!locked || locked.day !== coord.day || locked.slot !== coord.slot) return false;
      } else if (!availableSessions(subjectId, coord, extraBlockedId).length) {
        return false;
      }
    }
    return true;
  }

  function planScheduleCost(plan) {
    let cost = 0;
    for (const subjectId of raw.subjects) {
      const coord = plan.bySubject[subjectId];
      cost += Number(slotPenalty[coord.slot] || 0);

      if (coord.day === 3) {
        cost += Number(rules.thursdayBasePenalty || 320);
        cost += Number(thursdaySlotPenalty[coord.slot] || 0);
      } else if (coord.day === 4) {
        cost += Number(rules.fridayBasePenalty || 2200);
      }
    }

    const m = metrics(plan);
    cost += Math.max(0, m.activeDays - 3) * Number(rules.extraSchoolDayPenalty || 160);
    cost += m.gaps * Number(rules.gapPenalty || 12);
    return cost;
  }

  const planMeta = new Map();
  for (const plan of plans) {
    const rating = consensusRating(plan);
    const scheduleCost = planScheduleCost(plan);
    const cost = Math.max(0, rating - 1) * Number(rules.ratingWeight || 600) + scheduleCost;
    const qualityWeight = Math.exp(-Math.max(0, rating - 1) * 0.72) * Math.exp(-scheduleCost / 1000);
    planMeta.set(plan.id, { rating, scheduleCost, cost, qualityWeight });
  }

  function meta(plan) {
    return planMeta.get(plan.id) || { rating: 5, scheduleCost: 9999, cost: 9999, qualityWeight: 0.0001 };
  }

  function planCost(plan) {
    return meta(plan).cost;
  }

  function qualityMass(list) {
    return list.reduce((sum, plan) => sum + meta(plan).qualityWeight, 0);
  }

  function usablePlans() {
    return [...plans]
      .filter((plan) => consensusRating(plan) < hardRejectAt)
      .sort((a, b) => planCost(a) - planCost(b) || a.id.localeCompare(b.id));
  }

  function remainingPlans(extraBlockedId = null) {
    return usablePlans().filter((plan) => planIsFeasible(plan, extraBlockedId));
  }

  function preferredSession(subjectId, coord, blockedId = null) {
    const available = availableSessions(subjectId, coord, blockedId);
    if (!available.length) return null;
    const preferred = preferredExerciseBySubject.get(subjectId);
    if (preferred && preferred.day === coord.day && preferred.slot === coord.slot) {
      const exact = available.find((session) => session.id === preferred.id);
      if (exact) return exact;
    }
    return available[0];
  }

  function changedSubjects(planA, planB) {
    if (!planA || !planB) return [];
    return raw.subjects.filter((subjectId) => !sameCoord(planA.bySubject[subjectId], planB.bySubject[subjectId]));
  }

  function supportMass(remaining, subjectId, coord) {
    return qualityMass(remaining.filter((plan) => sameCoord(plan.bySubject[subjectId], coord)));
  }

  function chooseTargetPlan(remaining) {
    if (!remaining.length) return null;
    const totalMass = Math.max(qualityMass(remaining), 1e-9);
    const unlocked = raw.subjects.filter((subjectId) => !registrationState.locked[subjectId]);
    const candidates = remaining.slice(0, Math.min(50, remaining.length));

    let best = null;
    for (const plan of candidates) {
      const supports = unlocked.map((subjectId) => {
        const coord = plan.bySubject[subjectId];
        return supportMass(remaining, subjectId, coord) / totalMass;
      });
      const avgSupport = supports.length ? supports.reduce((a, b) => a + b, 0) / supports.length : 1;
      const minSupport = supports.length ? Math.min(...supports) : 1;
      const robustnessPenalty =
        (1 - avgSupport) * Number(rules.robustnessAveragePenalty || 260) +
        (1 - minSupport) * Number(rules.robustnessWeakLinkPenalty || 520);
      const robustScore = planCost(plan) + robustnessPenalty;

      if (!best || robustScore < best.robustScore) {
        best = { plan, avgSupport, minSupport, robustScore };
      }
    }
    return best;
  }

  function bestPlanCost(list) {
    if (!list.length) return Infinity;
    return Math.min(...list.map(planCost));
  }

  function buildPriorities(remaining, targetInfo) {
    if (!remaining.length || !targetInfo?.plan) return [];
    const target = targetInfo.plan;
    const totalMass = Math.max(qualityMass(remaining), 1e-9);
    const currentBestCost = bestPlanCost(remaining);
    const priorities = [];

    for (const subjectId of raw.subjects) {
      if (registrationState.locked[subjectId]) continue;
      const subject = subjectById.get(subjectId);
      const coord = target.bySubject[subjectId];
      const available = availableSessions(subjectId, coord);
      const session = preferredSession(subjectId, coord);
      if (!session) continue;

      const sameTimeAlternatives = Math.max(0, available.length - 1);
      const afterYes = remaining.filter((plan) => sameCoord(plan.bySubject[subjectId], coord));
      const afterNo = remaining.filter((plan) => planIsFeasible(plan, session.id));
      const afterYesMass = qualityMass(afterYes);
      const afterNoMass = qualityMass(afterNo);
      const noPreserveRatio = afterNoMass / totalMass;
      const yesPreserveRatio = afterYesMass / totalMass;
      const lossOnNoRatio = Math.max(0, 1 - noPreserveRatio);
      const fallback = chooseTargetPlan(afterNo)?.plan || null;
      const changes = fallback ? changedSubjects(target, fallback).length : 99;
      const regretNo = afterNo.length ? Math.max(0, bestPlanCost(afterNo) - currentBestCost) : 5000;
      const distinctCoords = new Set(remaining.map((plan) => coordKey(plan.bySubject[subjectId]))).size;
      const scarcity = 1 / Math.max(1, distinctCoords);
      const subjectImportance = Number(importance[subjectId] || 40);

      let priorityScore =
        subjectImportance * 5.5 +
        lossOnNoRatio * 650 +
        Math.min(regretNo, 1200) * 0.35 +
        scarcity * 90 +
        yesPreserveRatio * 70 -
        sameTimeAlternatives * 90;

      if (!afterNo.length) priorityScore += 10000;

      priorities.push({
        subject,
        subjectId,
        coord,
        session,
        available,
        sameTimeAlternatives,
        afterNo,
        afterYes,
        afterNoMass,
        afterYesMass,
        noPreserveRatio,
        yesPreserveRatio,
        lossOnNoRatio,
        fallback,
        changes,
        regretNo,
        distinctCoords,
        subjectImportance,
        priorityScore,
        total: remaining.length
      });
    }

    priorities.sort((a, b) =>
      b.priorityScore - a.priorityScore ||
      b.subjectImportance - a.subjectImportance ||
      a.subject.name.localeCompare(b.subject.name)
    );

    return priorities;
  }

  function impactLevel(item) {
    if (item.afterNo.length === 0) return ["Kritické", "critical"];
    if (item.lossOnNoRatio >= 0.55 || item.regretNo >= 500 || item.changes >= 3) return ["Kritické", "critical"];
    if (item.lossOnNoRatio >= 0.3 || item.regretNo >= 250 || item.changes >= 2) return ["Dôležité", "important"];
    if (item.lossOnNoRatio >= 0.12 || item.subjectImportance >= 70) return ["Stredné", "medium"];
    return ["Nízke", "low"];
  }

  function formatSession(session) {
    return `${data.days[session.day]} · ${data.slots[session.slot]} · ${session.group}`;
  }

  function formatRating(value) {
    return Number(value).toLocaleString("sk-SK", { maximumFractionDigits: 1 });
  }

  function impactText(item) {
    if (item.sameTimeAlternatives > 0) {
      return `Ak ${item.session.group} nevyjde, v rovnakom čase ostáva ešte ${item.sameTimeAlternatives} ${item.sameTimeAlternatives === 1 ? "skupina" : "skupiny"}. Layout tým zatiaľ nestrácaš.`;
    }
    if (!item.afterNo.length) {
      return "Ak tento termín nevyjde, nezostane žiadny tebou prijateľný pevný rozvrh.";
    }

    const preserved = Math.round(item.noPreserveRatio * 100);
    const changed = item.fallback
      ? changedSubjects(item.afterYes[0] || null, item.fallback)
          .filter((subjectId) => subjectId !== item.subjectId)
          .map((subjectId) => subjectById.get(subjectId)?.short || subjectId)
      : [];
    const extra = changed.length ? ` Najlepší fallback mení aj: ${changed.join(", ")}.` : "";
    return `Po NIE zostane ${item.afterNo.length}/${item.total} layoutov a približne ${preserved} % váhy kvalitných možností.${extra}`;
  }

  function renderCurrent(usable, remaining, priorities, targetInfo) {
    const done = Object.keys(registrationState.locked).length;

    if (!usable.length) {
      els.current.innerHTML = `<div class="registration-empty bad-state"><h2>Nie sú žiadne použiteľné pevné rozvrhy.</h2></div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }

    if (!remaining.length) {
      els.current.innerHTML = `<div class="registration-empty bad-state">
        <p class="eyebrow">Došli fallbacky</p>
        <h2>Aktuálne ÁNO/NIE už nezodpovedajú žiadnemu tebou prijateľnému rozvrhu.</h2>
        <p>Vráť posledný krok. Rozvrhy, ktoré si v oboch hodnoteniach označil 5/5, sú zámerne úplne zakázané.</p>
      </div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }

    if (!priorities.length) {
      els.current.innerHTML = `<div class="registration-empty success-state">
        <p class="eyebrow">Cvičenia hotové</p>
        <h2>Všetkých ${done} cvičení je potvrdených.</h2>
        <p>Finálny rozvrh zodpovedá robustnému layoutu ${escapeHtml(targetInfo?.plan?.id || remaining[0].id)}. Teraz môžeš riešiť prednášky.</p>
      </div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }

    const item = priorities[0];
    const [label, cls] = impactLevel(item);
    const target = targetInfo.plan;
    els.current.innerHTML = `<div class="registration-now">
      <div class="registration-now-top">
        <div>
          <p class="eyebrow">Teraz klikni · robustný cieľ ${escapeHtml(target.id)} · priemer ${escapeHtml(formatRating(consensusRating(target)))}/5</p>
          <h2>${escapeHtml(item.subject.name)}</h2>
        </div>
        <span class="impact-badge ${cls}">${label}</span>
      </div>
      <div class="registration-time">${escapeHtml(formatSession(item.session))}</div>
      <p class="registration-reason"><strong>Ak nevýjde:</strong> ${escapeHtml(impactText(item))}</p>
    </div>`;
    els.yes.disabled = false;
    els.no.disabled = false;
  }

  function renderPriority(priorities) {
    if (!priorities.length) {
      els.priority.innerHTML = `<p class="muted-copy">Nie sú žiadne ďalšie cvičenia na zápis.</p>`;
      return;
    }

    els.priority.innerHTML = priorities.map((item, index) => {
      const [label, cls] = impactLevel(item);
      const preserved = Math.round(item.noPreserveRatio * 100);
      return `<div class="priority-row${index === 0 ? " is-next" : ""}">
        <span class="priority-number">${index + 1}</span>
        <div class="priority-main">
          <strong>${escapeHtml(item.subject.short)}</strong>
          <span>${escapeHtml(formatSession(item.session))}</span>
          <small>po NIE: ${item.afterNo.length}/${item.total} layoutov · ~${preserved} % kvalitnej váhy · dôležitosť ${item.subjectImportance}</small>
        </div>
        <span class="impact-badge ${cls}">${label}</span>
      </div>`;
    }).join("");
  }

  function renderProgress(usable, remaining) {
    const lockedCount = Object.keys(registrationState.locked).length;
    const blockedCount = registrationState.blocked.length;
    const percent = Math.round((lockedCount / raw.subjects.length) * 100);
    const veryGoodRemaining = remaining.filter((plan) => consensusRating(plan) <= 2).length;

    els.progress.innerHTML = `<div class="progress-bar" aria-label="${percent} % cvičení zapísaných"><span style="width:${percent}%"></span></div>
      <div class="progress-stats">
        <div><span>Zapísané</span><strong>${lockedCount}/${raw.subjects.length}</strong></div>
        <div><span>Pevné použiteľné</span><strong>${usable.length}</strong></div>
        <div><span>Stále možné</span><strong>${remaining.length}</strong></div>
        <div><span>Z toho priemer ≤2</span><strong>${veryGoodRemaining}</strong></div>
        <div><span>Nevyšli termíny</span><strong>${blockedCount}</strong></div>
      </div>`;
  }

  function displayExercise(plan, subjectId) {
    const lockedId = registrationState.locked[subjectId];
    if (lockedId) return sessionById.get(lockedId) || null;
    const coord = plan.bySubject[subjectId];
    const available = availableSessions(subjectId, coord);
    if (!available.length) return null;
    const preferred = preferredSession(subjectId, coord);
    return {
      ...preferred,
      group: available.map((session) => session.group).join(" / ")
    };
  }

  function renderSchedule(remaining, targetInfo) {
    if (!remaining.length || !targetInfo?.plan) {
      els.schedule.innerHTML = "";
      return;
    }

    const plan = targetInfo.plan;
    const exercises = raw.subjects.map((subjectId) => displayExercise(plan, subjectId)).filter(Boolean);
    const events = [...lectureAnchors, ...exercises].sort((a, b) => a.day - b.day || a.slot - b.slot);
    const byDay = new Map();
    for (const event of events) {
      if (!byDay.has(event.day)) byDay.set(event.day, []);
      byDay.get(event.day).push(event);
    }

    const avgSupport = Math.round(targetInfo.avgSupport * 100);
    const minSupport = Math.round(targetInfo.minSupport * 100);
    let html = `<div class="registration-best-plan"><strong>${escapeHtml(plan.id)}</strong> · priemer ${escapeHtml(formatRating(consensusRating(plan)))}/5 · ${remaining.length} layoutov stále možných · podpora cieľa priemerne ${avgSupport} %, najslabší blok ${minSupport} %</div>`;
    html += `<div class="registration-week">`;
    data.days.forEach((day, dayIndex) => {
      const dayEvents = (byDay.get(dayIndex) || []).sort((a, b) => a.slot - b.slot);
      html += `<section class="registration-day"><h3>${escapeHtml(day)}</h3>`;
      if (!dayEvents.length) {
        html += `<p class="free-day">Voľno</p>`;
      } else {
        for (const event of dayEvents) {
          const subject = subjectById.get(event.subjectId);
          const isLocked = event.type === "C" && Boolean(registrationState.locked[event.subjectId]);
          html += `<div class="registration-event ${event.type === "P" ? "lecture" : "exercise"}${isLocked ? " locked" : ""}" style="--subject-color:${escapeHtml(subject?.color || "#94a3b8")}">
            <span class="event-time">${escapeHtml(data.slots[event.slot])}</span>
            <strong>${escapeHtml(subject?.short || "")}</strong>
            <span>${escapeHtml(event.group)} · ${event.type === "P" ? "P" : isLocked ? "C ✓" : "C"}</span>
          </div>`;
        }
      }
      html += `</section>`;
    });
    html += `</div>`;
    els.schedule.innerHTML = html;
  }

  function renderHistory() {
    const items = registrationState.history.slice(-8).reverse();
    if (!items.length) {
      els.history.innerHTML = `<p class="muted-copy">Zatiaľ si nič nepotvrdil ani nezamietol.</p>`;
      return;
    }

    els.history.innerHTML = items.map((entry) => {
      const session = sessionById.get(entry.sessionId);
      const subject = session ? subjectById.get(session.subjectId) : null;
      return `<div class="history-row ${entry.result === "yes" ? "yes" : "no"}">
        <span>${entry.result === "yes" ? "✓" : "×"}</span>
        <strong>${escapeHtml(subject?.short || "")}</strong>
        <span>${escapeHtml(session ? formatSession(session) : entry.sessionId)}</span>
      </div>`;
    }).join("");
  }

  function renderAll() {
    const usable = usablePlans();
    const remaining = usable.filter((plan) => planIsFeasible(plan));
    const targetInfo = chooseTargetPlan(remaining);
    const priorities = buildPriorities(remaining, targetInfo);
    renderCurrent(usable, remaining, priorities, targetInfo);
    renderPriority(priorities);
    renderProgress(usable, remaining);
    renderSchedule(remaining, targetInfo);
    renderHistory();
    els.undo.disabled = undoStack.length === 0;
    return { usable, remaining, targetInfo, priorities };
  }

  function applyResult(result) {
    const { priorities } = renderAll();
    const current = priorities[0];
    if (!current) return;

    undoStack.push(snapshot());
    if (undoStack.length > 40) undoStack.shift();

    if (result === "yes") {
      registrationState.locked[current.subjectId] = current.session.id;
    } else if (!registrationState.blocked.includes(current.session.id)) {
      registrationState.blocked.push(current.session.id);
    }

    registrationState.history.push({ result, sessionId: current.session.id, at: Date.now() });
    saveRegistrationState();
    renderAll();
  }

  function showRegistration() {
    document.querySelectorAll(".tab").forEach((button) => button.classList.remove("is-active"));
    document.getElementById("planReviewTab")?.classList.remove("is-active");
    tab.classList.add("is-active");
    document.getElementById("subjectsView").hidden = true;
    document.getElementById("templatesView").hidden = true;
    document.getElementById("planReviewView").hidden = true;
    view.hidden = false;
    renderAll();
  }

  tab.addEventListener("click", showRegistration);

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      tab.classList.remove("is-active");
      view.hidden = true;
    });
  });

  document.getElementById("planReviewTab")?.addEventListener("click", () => {
    tab.classList.remove("is-active");
    view.hidden = true;
  });

  els.yes.addEventListener("click", () => applyResult("yes"));
  els.no.addEventListener("click", () => applyResult("no"));

  els.undo.addEventListener("click", () => {
    const previous = undoStack.pop();
    if (!previous) return;
    registrationState = previous;
    saveRegistrationState();
    renderAll();
  });

  els.reset.addEventListener("click", () => {
    registrationState = defaultRegistrationState();
    undoStack.length = 0;
    saveRegistrationState();
    renderAll();
  });

  renderAll();
})();