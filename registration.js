(() => {
  "use strict";

  const utils = window.ROZVRH_PLAN_UTILS;
  if (!utils) return;

  const {
    data,
    raw,
    plans,
    subjectById,
    sessionById,
    lectureAnchors,
    sessionsAt
  } = utils;

  const REVIEW_KEY = "rozvrh-plan-review-v1";
  const STORAGE_KEY = "rozvrh-registration-v2";

  const preferredTemplate =
    (data.templates || []).find((template) => template.id === "a-compact") ||
    (data.templates || [])[0] ||
    { sessionIds: [] };

  const preferredExerciseBySubject = new Map();
  for (const id of preferredTemplate.sessionIds || []) {
    const session = sessionById.get(id);
    if (session?.type === "C") preferredExerciseBySubject.set(session.subjectId, session);
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

  function approvedPlanIds() {
    try {
      const parsed = JSON.parse(localStorage.getItem(REVIEW_KEY) || "null");
      const decisions = parsed?.decisions || {};
      return new Set(Object.entries(decisions).filter(([, status]) => status === "approved").map(([id]) => id));
    } catch {
      return new Set();
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

  function approvedPlans() {
    const approved = approvedPlanIds();
    return plans.filter((plan) => approved.has(plan.id));
  }

  function remainingPlans(extraBlockedId = null) {
    return approvedPlans().filter((plan) => planIsFeasible(plan, extraBlockedId));
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

  function buildPriorities(remaining) {
    if (!remaining.length) return [];
    const best = remaining[0];
    const priorities = [];

    for (const subjectId of raw.subjects) {
      if (registrationState.locked[subjectId]) continue;
      const subject = subjectById.get(subjectId);
      const coord = best.bySubject[subjectId];
      const available = availableSessions(subjectId, coord);
      const session = preferredSession(subjectId, coord);
      if (!session) continue;

      const sameTimeAlternatives = Math.max(0, available.length - 1);
      let afterNo;
      if (sameTimeAlternatives > 0) {
        afterNo = remaining;
      } else {
        afterNo = remaining.filter((plan) => {
          const other = plan.bySubject[subjectId];
          return !sameCoord(other, coord);
        });
      }

      const afterYes = remaining.filter((plan) => sameCoord(plan.bySubject[subjectId], coord));
      const lossOnNo = remaining.length - afterNo.length;
      const fallback = afterNo[0] || null;
      const changes = fallback ? changedSubjects(best, fallback).length : 99;

      priorities.push({
        subject,
        subjectId,
        coord,
        session,
        available,
        sameTimeAlternatives,
        afterNo,
        afterYes,
        lossOnNo,
        fallback,
        changes,
        total: remaining.length
      });
    }

    priorities.sort((a, b) => {
      if (b.lossOnNo !== a.lossOnNo) return b.lossOnNo - a.lossOnNo;
      if (a.sameTimeAlternatives !== b.sameTimeAlternatives) return a.sameTimeAlternatives - b.sameTimeAlternatives;
      if (b.changes !== a.changes) return b.changes - a.changes;
      return a.subject.name.localeCompare(b.subject.name);
    });

    return priorities;
  }

  function impactLevel(item) {
    if (item.afterNo.length === 0) return ["Kritické", "critical"];
    const ratio = item.lossOnNo / Math.max(1, item.total);
    if (ratio >= 0.65 || item.changes >= 3) return ["Kritické", "critical"];
    if (ratio >= 0.35 || item.changes >= 2) return ["Dôležité", "important"];
    if (ratio >= 0.15) return ["Stredné", "medium"];
    return ["Nízke", "low"];
  }

  function formatSession(session) {
    return `${data.days[session.day]} · ${data.slots[session.slot]} · ${session.group}`;
  }

  function impactText(item) {
    if (item.sameTimeAlternatives > 0) {
      return `Ak ${item.session.group} nevyjde, v rovnakom čase ostáva ešte ${item.sameTimeAlternatives} ${item.sameTimeAlternatives === 1 ? "skupina" : "skupiny"}; žiadny schválený layout tým zatiaľ nestratíš.`;
    }
    if (!item.afterNo.length) {
      return "Ak tento termín nevyjde, z aktuálne možných schválených rozvrhov nezostane ani jeden.";
    }
    const changed = changedSubjects(item.afterYes[0] || null, item.fallback)
      .filter((subjectId) => subjectId !== item.subjectId)
      .map((subjectId) => subjectById.get(subjectId)?.short || subjectId);
    const extra = changed.length ? ` Najlepší fallback ${item.fallback.id} mení aj: ${changed.join(", ")}.` : ` Najlepší fallback je ${item.fallback.id}.`;
    return `Po NIE zostane ${item.afterNo.length} z ${item.total} aktuálne možných schválených rozvrhov.${extra}`;
  }

  function renderCurrent(approved, remaining, priorities) {
    const done = Object.keys(registrationState.locked).length;

    if (!approved.length) {
      els.current.innerHTML = `<div class="registration-empty bad-state">
        <p class="eyebrow">Najprv schváľ fallbacky</p>
        <h2>Zatiaľ nemáš schválený ani jeden pevný rozvrh.</h2>
        <p>Prejdi do „Schváliť rozvrhy“ a označ tie, ktoré by si bol ochotný používať. LIVE potom bude pracovať výhradne s nimi.</p>
      </div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }

    if (!remaining.length) {
      els.current.innerHTML = `<div class="registration-empty bad-state">
        <p class="eyebrow">Došli schválené fallbacky</p>
        <h2>Aktuálne ÁNO/NIE už nezodpovedajú žiadnemu rozvrhu, ktorý si schválil.</h2>
        <p>Vráť posledný krok alebo schváľ ďalšie fallback rozvrhy.</p>
      </div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }

    if (!priorities.length) {
      els.current.innerHTML = `<div class="registration-empty success-state">
        <p class="eyebrow">Cvičenia hotové</p>
        <h2>Všetkých ${done} cvičení je potvrdených.</h2>
        <p>Finálny rozvrh zodpovedá schválenému layoutu ${escapeHtml(remaining[0].id)}. Teraz môžeš riešiť prednášky.</p>
      </div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }

    const item = priorities[0];
    const [label, cls] = impactLevel(item);
    els.current.innerHTML = `<div class="registration-now">
      <div class="registration-now-top">
        <div>
          <p class="eyebrow">Teraz klikni · cieľový layout ${escapeHtml(remaining[0].id)}</p>
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
      return `<div class="priority-row${index === 0 ? " is-next" : ""}">
        <span class="priority-number">${index + 1}</span>
        <div class="priority-main">
          <strong>${escapeHtml(item.subject.short)}</strong>
          <span>${escapeHtml(formatSession(item.session))}</span>
          <small>po NIE: ${item.afterNo.length}/${item.total} layoutov</small>
        </div>
        <span class="impact-badge ${cls}">${label}</span>
      </div>`;
    }).join("");
  }

  function renderProgress(approved, remaining) {
    const lockedCount = Object.keys(registrationState.locked).length;
    const blockedCount = registrationState.blocked.length;
    const percent = Math.round((lockedCount / raw.subjects.length) * 100);

    els.progress.innerHTML = `<div class="progress-bar" aria-label="${percent} % cvičení zapísaných"><span style="width:${percent}%"></span></div>
      <div class="progress-stats">
        <div><span>Zapísané</span><strong>${lockedCount}/${raw.subjects.length}</strong></div>
        <div><span>Schválené</span><strong>${approved.length}</strong></div>
        <div><span>Stále možné</span><strong>${remaining.length}</strong></div>
        <div><span>Nevyšli</span><strong>${blockedCount}</strong></div>
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

  function renderSchedule(remaining) {
    if (!remaining.length) {
      els.schedule.innerHTML = "";
      return;
    }

    const plan = remaining[0];
    const exercises = raw.subjects.map((subjectId) => displayExercise(plan, subjectId)).filter(Boolean);
    const events = [...lectureAnchors, ...exercises].sort((a, b) => a.day - b.day || a.slot - b.slot);
    const byDay = new Map();
    for (const event of events) {
      if (!byDay.has(event.day)) byDay.set(event.day, []);
      byDay.get(event.day).push(event);
    }

    let html = `<div class="registration-best-plan"><strong>${escapeHtml(plan.id)}</strong> · kategória ${escapeHtml(plan.tier)} · ${remaining.length} schválených layoutov stále možných</div>`;
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
    const approved = approvedPlans();
    const remaining = approved.filter((plan) => planIsFeasible(plan));
    const priorities = buildPriorities(remaining);
    renderCurrent(approved, remaining, priorities);
    renderPriority(priorities);
    renderProgress(approved, remaining);
    renderSchedule(remaining);
    renderHistory();
    els.undo.disabled = undoStack.length === 0;
    return { approved, remaining, priorities };
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

  window.addEventListener("rozvrh-plan-review-changed", () => {
    if (!view.hidden) renderAll();
  });

  renderAll();
})();