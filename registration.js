(() => {
  "use strict";

  const data = window.ROZVRH_DATA;
  if (!data) return;

  const STORAGE_KEY = "rozvrh-registration-v1";
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

  const preferredExerciseBySubject = new Map();
  const lectureAnchors = [];
  for (const id of preferredTemplate.sessionIds || []) {
    const session = sessionById.get(id);
    if (!session) continue;
    if (session.type === "C") preferredExerciseBySubject.set(session.subjectId, session);
    if (session.type === "P") lectureAnchors.push(session);
  }

  const exerciseSubjects = data.subjects.filter(
    (subject) => subject.sessions.some((session) => session.type === "C")
  );

  const baselineEvents = [
    ...lectureAnchors,
    ...exerciseSubjects
      .map((subject) => preferredExerciseBySubject.get(subject.id))
      .filter(Boolean)
  ];

  function dayMetrics(events) {
    const result = new Map();
    for (let day = 0; day < data.days.length; day += 1) {
      const slots = [...new Set(events.filter((event) => event.day === day).map((event) => event.slot))].sort((a, b) => a - b);
      if (!slots.length) continue;
      const min = slots[0];
      const max = slots[slots.length - 1];
      result.set(day, {
        min,
        max,
        gaps: Math.max(0, max - min + 1 - slots.length)
      });
    }
    return result;
  }

  const baselineMetrics = dayMetrics(baselineEvents);

  function defaultRegistrationState() {
    return {
      locked: {},
      blocked: [],
      history: []
    };
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

  function slotKey(session) {
    return `${session.day}-${session.slot}`;
  }

  const anchorSlots = new Set(lectureAnchors.map(slotKey));

  function localSessionCost(subjectId, session) {
    const preferred = preferredExerciseBySubject.get(subjectId);
    if (!preferred) return 0;
    if (session.id === preferred.id) return 0;
    if (session.day === preferred.day && session.slot === preferred.slot) return 0.25;

    const dayDiff = Math.abs(session.day - preferred.day);
    const slotDiff = Math.abs(session.slot - preferred.slot);
    if (dayDiff === 0) return 12 + 8 * slotDiff;
    return 12 + 22 * dayDiff + 4 * slotDiff;
  }

  function globalSchedulePenalty(exercises) {
    const events = [...lectureAnchors, ...exercises];
    const metrics = dayMetrics(events);
    let penalty = 0;

    if (metrics.has(3)) penalty += 400;
    if (metrics.has(4)) penalty += 650;

    for (let day = 0; day < data.days.length; day += 1) {
      const current = metrics.get(day);
      const baseline = baselineMetrics.get(day);
      if (!current) continue;

      if (!baseline) {
        penalty += 80;
        continue;
      }

      if (current.min < baseline.min) penalty += (baseline.min - current.min) * 5;
      if (current.max > baseline.max) penalty += (current.max - baseline.max) * 5;
      penalty += current.gaps * 10;
    }

    return penalty;
  }

  function hasConflicts(exercises) {
    const occupied = new Set(anchorSlots);
    for (const session of exercises) {
      const key = slotKey(session);
      if (occupied.has(key)) return true;
      occupied.add(key);
    }
    return false;
  }

  function findBestPlan(extraBlockedId = null) {
    const blocked = new Set(registrationState.blocked);
    if (extraBlockedId) blocked.add(extraBlockedId);

    const subjectEntries = [];
    for (const subject of exerciseSubjects) {
      const lockedId = registrationState.locked[subject.id];
      let options;

      if (lockedId) {
        const lockedSession = sessionById.get(lockedId);
        if (!lockedSession || blocked.has(lockedId)) return null;
        options = [lockedSession];
      } else {
        options = subject.sessions
          .filter((session) => session.type === "C" && !blocked.has(session.id))
          .map((session) => ({ ...session, subjectId: subject.id }))
          .filter((session) => !anchorSlots.has(slotKey(session)));
      }

      if (!options.length) return null;
      options.sort((a, b) => localSessionCost(subject.id, a) - localSessionCost(subject.id, b));
      subjectEntries.push({ subject, options });
    }

    subjectEntries.sort((a, b) => a.options.length - b.options.length);

    const minSuffix = new Array(subjectEntries.length + 1).fill(0);
    for (let index = subjectEntries.length - 1; index >= 0; index -= 1) {
      const entry = subjectEntries[index];
      const minLocal = Math.min(...entry.options.map((session) => localSessionCost(entry.subject.id, session)));
      minSuffix[index] = minSuffix[index + 1] + minLocal;
    }

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let nodes = 0;
    const NODE_LIMIT = 180000;
    const chosen = [];
    const occupied = new Set(anchorSlots);

    function visit(index, localCost) {
      if (nodes >= NODE_LIMIT) return;
      nodes += 1;

      if (localCost + minSuffix[index] > bestScore + 1e-9) return;

      if (index >= subjectEntries.length) {
        if (hasConflicts(chosen)) return;
        const score = localCost + globalSchedulePenalty(chosen);
        if (score < bestScore) {
          bestScore = score;
          best = [...chosen];
        }
        return;
      }

      const entry = subjectEntries[index];
      for (const session of entry.options) {
        const key = slotKey(session);
        if (occupied.has(key)) continue;

        const nextLocal = localCost + localSessionCost(entry.subject.id, session);
        if (nextLocal + minSuffix[index + 1] > bestScore + 1e-9) continue;

        occupied.add(key);
        chosen.push(session);
        visit(index + 1, nextLocal);
        chosen.pop();
        occupied.delete(key);
      }
    }

    visit(0, 0);
    if (!best) return null;

    const bySubject = {};
    for (const session of best) bySubject[session.subjectId] = session;
    return { sessions: best, bySubject, score: bestScore, limited: nodes >= NODE_LIMIT };
  }

  function changedSubjects(planA, planB) {
    if (!planA || !planB) return [];
    return exerciseSubjects.filter((subject) => {
      const a = planA.bySubject[subject.id];
      const b = planB.bySubject[subject.id];
      return a?.id !== b?.id;
    });
  }

  function impactText(bestPlan, alternativePlan, session) {
    if (!alternativePlan) return "Bez tohto termínu už nezostáva žiadna platná kombinácia cvičení.";

    const changes = changedSubjects(bestPlan, alternativePlan);
    const thursday = alternativePlan.sessions.some((event) => event.day === 3);
    const friday = alternativePlan.sessions.some((event) => event.day === 4);
    const alternatives = changes
      .filter((subject) => subject.id !== session.subjectId)
      .map((subject) => subject.short);

    const bits = [];
    if (alternatives.length) bits.push(`musel by sa zmeniť aj ${alternatives.join(", ")}`);
    if (thursday) bits.push("objavila by sa škola vo štvrtok");
    if (friday) bits.push("objavila by sa škola v piatok");
    if (!bits.length) {
      const alt = alternativePlan.bySubject[session.subjectId];
      if (alt && alt.day === session.day && alt.slot === session.slot) {
        bits.push("existuje iná skupina v úplne rovnakom čase");
      } else {
        bits.push("náhrada mení iba tento predmet alebo mierne posúva čas v škole");
      }
    }
    return bits.join("; ") + ".";
  }

  function buildPriorities(bestPlan) {
    if (!bestPlan) return [];
    const priorities = [];

    for (const subject of exerciseSubjects) {
      if (registrationState.locked[subject.id]) continue;
      const session = bestPlan.bySubject[subject.id];
      if (!session) continue;

      const alternative = findBestPlan(session.id);
      const regret = alternative ? alternative.score - bestPlan.score : Number.POSITIVE_INFINITY;
      const changes = alternative ? changedSubjects(bestPlan, alternative).length : 99;
      priorities.push({ subject, session, alternative, regret, changes });
    }

    priorities.sort((a, b) => {
      if (!Number.isFinite(a.regret) && Number.isFinite(b.regret)) return -1;
      if (Number.isFinite(a.regret) && !Number.isFinite(b.regret)) return 1;
      if (b.regret !== a.regret) return b.regret - a.regret;
      if (b.changes !== a.changes) return b.changes - a.changes;
      return a.subject.name.localeCompare(b.subject.name);
    });

    return priorities;
  }

  function impactLevel(item) {
    if (!Number.isFinite(item.regret) || item.regret >= 40 || item.changes >= 3) return ["Kritické", "critical"];
    if (item.regret >= 20 || item.changes >= 2) return ["Dôležité", "important"];
    if (item.regret >= 5) return ["Stredné", "medium"];
    return ["Nízke", "low"];
  }

  function formatSession(session) {
    return `${data.days[session.day]} · ${data.slots[session.slot]} · ${session.group}`;
  }

  function renderCurrent(bestPlan, priorities) {
    const done = Object.keys(registrationState.locked).length;
    if (!bestPlan) {
      els.current.innerHTML = `
        <div class="registration-empty bad-state">
          <p class="eyebrow">Nie je platný plán</p>
          <h2>Aktuálne odpovede už neumožňujú zostaviť rozvrh bez kolízií.</h2>
          <p>Vráť posledný krok a vyber inú možnosť.</p>
        </div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }

    if (!priorities.length) {
      els.current.innerHTML = `
        <div class="registration-empty success-state">
          <p class="eyebrow">Cvičenia hotové</p>
          <h2>Všetkých ${done} cvičení je zamknutých.</h2>
          <p>Teraz môžeš v pokoji zapísať prednášky. Aktuálny finálny plán je zobrazený nižšie.</p>
        </div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }

    const item = priorities[0];
    const [label, cls] = impactLevel(item);
    els.current.innerHTML = `
      <div class="registration-now">
        <div class="registration-now-top">
          <div>
            <p class="eyebrow">Teraz klikni</p>
            <h2>${escapeHtml(item.subject.name)}</h2>
          </div>
          <span class="impact-badge ${cls}">${label}</span>
        </div>
        <div class="registration-time">${escapeHtml(formatSession(item.session))}</div>
        <p class="registration-reason"><strong>Ak nevýjde:</strong> ${escapeHtml(impactText(bestPlan, item.alternative, item.session))}</p>
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
      return `
        <div class="priority-row${index === 0 ? " is-next" : ""}">
          <span class="priority-number">${index + 1}</span>
          <div class="priority-main">
            <strong>${escapeHtml(item.subject.short)}</strong>
            <span>${escapeHtml(formatSession(item.session))}</span>
          </div>
          <span class="impact-badge ${cls}">${label}</span>
        </div>`;
    }).join("");
  }

  function renderProgress(bestPlan) {
    const lockedCount = Object.keys(registrationState.locked).length;
    const blockedCount = registrationState.blocked.length;
    const percent = Math.round((lockedCount / exerciseSubjects.length) * 100);

    els.progress.innerHTML = `
      <div class="progress-bar" aria-label="${percent} % cvičení zapísaných"><span style="width:${percent}%"></span></div>
      <div class="progress-stats">
        <div><span>Zapísané</span><strong>${lockedCount}/${exerciseSubjects.length}</strong></div>
        <div><span>Nevyšli</span><strong>${blockedCount}</strong></div>
        <div><span>Štvrtok</span><strong>${bestPlan && !bestPlan.sessions.some((s) => s.day === 3) ? "voľno" : "škola"}</strong></div>
        <div><span>Piatok</span><strong>${bestPlan && !bestPlan.sessions.some((s) => s.day === 4) ? "voľno" : "škola"}</strong></div>
      </div>`;
  }

  function renderSchedule(bestPlan) {
    if (!bestPlan) {
      els.schedule.innerHTML = "";
      return;
    }

    const events = [...lectureAnchors, ...bestPlan.sessions]
      .sort((a, b) => a.day - b.day || a.slot - b.slot);
    const byDay = new Map();
    for (const event of events) {
      if (!byDay.has(event.day)) byDay.set(event.day, []);
      byDay.get(event.day).push(event);
    }

    let html = `<div class="registration-week">`;
    data.days.forEach((day, dayIndex) => {
      const dayEvents = byDay.get(dayIndex) || [];
      html += `<section class="registration-day"><h3>${escapeHtml(day)}</h3>`;
      if (!dayEvents.length) {
        html += `<p class="free-day">Voľno</p>`;
      } else {
        for (const event of dayEvents) {
          const subject = subjectById.get(event.subjectId);
          const isLocked = event.type === "C" && registrationState.locked[event.subjectId] === event.id;
          html += `
            <div class="registration-event ${event.type === "P" ? "lecture" : "exercise"}${isLocked ? " locked" : ""}" style="--subject-color:${escapeHtml(subject?.color || "#94a3b8")}">
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
    const bestPlan = findBestPlan();
    const priorities = buildPriorities(bestPlan);
    renderCurrent(bestPlan, priorities);
    renderPriority(priorities);
    renderProgress(bestPlan);
    renderSchedule(bestPlan);
    renderHistory();
    els.undo.disabled = undoStack.length === 0;
    return { bestPlan, priorities };
  }

  function applyResult(result) {
    const { priorities } = renderAll();
    const current = priorities[0];
    if (!current) return;

    undoStack.push(snapshot());
    if (undoStack.length > 30) undoStack.shift();

    if (result === "yes") {
      registrationState.locked[current.subject.id] = current.session.id;
    } else {
      if (!registrationState.blocked.includes(current.session.id)) {
        registrationState.blocked.push(current.session.id);
      }
    }

    registrationState.history.push({
      result,
      sessionId: current.session.id,
      at: Date.now()
    });
    saveRegistrationState();
    renderAll();
  }

  function showRegistration() {
    document.querySelectorAll(".tab").forEach((button) => button.classList.remove("is-active"));
    tab.classList.add("is-active");
    document.getElementById("subjectsView").hidden = true;
    document.getElementById("templatesView").hidden = true;
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
    if (!window.confirm("Naozaj vymazať celý priebeh zápisu a začať odznova?")) return;
    undoStack.push(snapshot());
    registrationState = defaultRegistrationState();
    saveRegistrationState();
    renderAll();
  });

  renderAll();
})();
