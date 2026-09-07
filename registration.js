(() => {
  "use strict";

  const core = window.ROZVRH_OPTIMIZER;
  const data = window.ROZVRH_DATA;
  const fixedPlans = window.ROZVRH_FIXED_PLANS;
  const preferences = window.ROZVRH_PREFERENCES;
  if (!core || !data || !fixedPlans || !preferences) return;

  const optimizer = core.createOptimizer({ data, fixedPlans, preferences });
  const STORAGE_KEY = "rozvrh-registration-v4";

  function defaultState() {
    return { locked: {}, unavailable: [], history: [], liveActivities: [] };
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      return parsed && typeof parsed === "object" ? { ...defaultState(), ...parsed } : defaultState();
    } catch {
      return defaultState();
    }
  }

  let state = loadState();
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
    reset: document.getElementById("registrationReset"),
    importLive: document.getElementById("registrationImportLive"),
    dryRun: document.getElementById("registrationDryRun"),
    dryRunOutput: document.getElementById("registrationDryRunOutput")
  };

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function formatNumber(value, digits = 2) {
    return Number(value || 0).toLocaleString("sk-SK", { maximumFractionDigits: digits });
  }

  function formatActivity(activity) {
    if (!activity) return "—";
    return `${data.days[activity.day]} · ${data.slots[activity.slot]} · ${activity.group}`;
  }

  function capacityText(activity) {
    if (!activity || activity.concreteActivityCapacity == null) return "kapacita neznáma";
    return `${activity.studentsCount ?? "?"} / ${activity.concreteActivityCapacity}`;
  }

  function riskLabel(level) {
    return ({ CRITICAL: "Kritické", HIGH: "Vysoké", MEDIUM: "Stredné", LOW: "Nízke" })[level] || level;
  }

  function riskClass(level) {
    return ({ CRITICAL: "critical", HIGH: "important", MEDIUM: "medium", LOW: "low" })[level] || "low";
  }

  function renderCurrent(result) {
    const current = result.priorities[0];
    if (result.noAcceptableLayout) {
      els.current.innerHTML = `<div class="registration-empty bad-state"><p class="eyebrow">Žiadny prijateľný layout</p><h2>Ďalší automatický krok je zablokovaný.</h2><p>Rozvrhy 5/5 sa nikdy nepoužijú. Vráť posledný krok alebo skontroluj LIVE dáta.</p></div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }
    if (!current) {
      els.current.innerHTML = `<div class="registration-empty success-state"><p class="eyebrow">Hotovo</p><h2>Všetky požadované cvičenia a prednášky sú potvrdené.</h2><p>TVA ani Bezpečnost v elektrotechnice nie sú súčasťou optimalizéra.</p></div>`;
      els.yes.disabled = true;
      els.no.disabled = true;
      return;
    }
    const target = result.targetInfo?.plan;
    els.current.innerHTML = `<div class="registration-now">
      <div class="registration-now-top"><div><p class="eyebrow">Ďalší krok · ${escapeHtml(current.type)} · robustný cieľ ${escapeHtml(target?.id || "prednášky")}</p><h2>${escapeHtml(current.subject?.name || current.subjectId)} · ${escapeHtml(current.activity.group)}</h2></div><span class="impact-badge ${riskClass(current.riskLevel)}">${escapeHtml(riskLabel(current.riskLevel))}</span></div>
      <div class="registration-time">${escapeHtml(formatActivity(current.activity))}</div>
      <div class="live-metric-grid">
        <span>LIVE kapacita <strong>${escapeHtml(capacityText(current.activity))}</strong></span>
        <span>activity ID <strong>${escapeHtml(current.activity.concreteActivityId ?? "neznáme")}</strong></span>
        <span>fallbacky po zlyhaní <strong>${escapeHtml(current.afterFailureCount ?? "—")}</strong></span>
        <span>risk score <strong>${formatNumber(current.riskScore, 0)}</strong></span>
      </div>
      <p class="registration-reason"><strong>Prečo teraz:</strong> ${escapeHtml(current.reason)}</p>
    </div>`;
    els.yes.disabled = false;
    els.no.disabled = false;
  }

  function renderPriority(result) {
    if (!result.priorities.length) {
      els.priority.innerHTML = `<p class="muted-copy">Žiadne ďalšie kroky.</p>`;
      return;
    }
    els.priority.innerHTML = result.priorities.map((item, index) => `<div class="priority-row${index === 0 ? " is-next" : ""}">
      <span class="priority-number">${index + 1}</span>
      <div class="priority-main"><strong>${escapeHtml(item.subject?.short || item.subjectId)} · ${escapeHtml(item.type)} ${escapeHtml(item.activity.group)}</strong><span>${escapeHtml(formatActivity(item.activity))} · ${escapeHtml(capacityText(item.activity))}</span><small>${escapeHtml(item.reason)} · ID ${escapeHtml(item.activity.concreteActivityId ?? "—")}</small></div>
      <span class="impact-badge ${riskClass(item.riskLevel)}">${escapeHtml(riskLabel(item.riskLevel))}</span>
    </div>`).join("");
  }

  function renderProgress(result) {
    const exerciseLocked = fixedPlans.subjects.filter((id) => state.locked[id]).length;
    const lectureRequirements = preferences.lectureRequirements || [];
    const lectureLocked = lectureRequirements.filter((item) => state.locked[item.key]).length;
    const percent = Math.round(((exerciseLocked + lectureLocked) / (fixedPlans.subjects.length + lectureRequirements.length)) * 100);
    els.progress.innerHTML = `<div class="progress-bar" aria-label="${percent} % hotovo"><span style="width:${percent}%"></span></div><div class="progress-stats">
      <div><span>Cvičenia</span><strong>${exerciseLocked}/${fixedPlans.subjects.length}</strong></div>
      <div><span>Prednášky</span><strong>${lectureLocked}/${lectureRequirements.length}</strong></div>
      <div><span>Kvalitné layouty</span><strong>${result.remainingCount}</strong></div>
      <div><span>Quality mass</span><strong>${formatNumber(result.qualityMass)}</strong></div>
      <div><span>Best rating</span><strong>${result.bestRemainingRating ?? "—"}/5</strong></div>
      <div><span>LIVE jednotky</span><strong>${result.liveActivities.length}</strong></div>
    </div>`;
  }

  function resolveLockedActivity(key, result) {
    const value = state.locked[key];
    if (!value) return null;
    return result.liveActivities.find((item) => String(item.concreteActivityId) === String(value) || item.localSessionId === value) || optimizer.sessionById.get(String(value)) || null;
  }

  function renderSchedule(result) {
    const plan = result.targetInfo?.plan;
    if (!plan) {
      els.schedule.innerHTML = "";
      return;
    }
    const events = [];
    for (const subjectId of fixedPlans.subjects) {
      const locked = resolveLockedActivity(subjectId, result);
      if (locked) events.push({ ...locked, subjectId, type: "C", locked: true });
      else {
        const coord = plan.bySubject[subjectId];
        const local = optimizer.subjectById.get(subjectId)?.sessions.find((session) => session.type === "C" && session.day === coord.day && session.slot === coord.slot);
        if (local) events.push({ ...local, subjectId, type: "C" });
      }
    }
    for (const requirement of preferences.lectureRequirements || []) {
      const locked = resolveLockedActivity(requirement.key, result);
      const local = locked || optimizer.sessionById.get(requirement.alternatives[0]);
      if (local) events.push({ ...local, subjectId: requirement.subjectId, type: "P", locked: Boolean(locked) });
    }
    const byDay = new Map();
    events.forEach((event) => {
      if (!byDay.has(event.day)) byDay.set(event.day, []);
      byDay.get(event.day).push(event);
    });
    let html = `<div class="registration-best-plan"><strong>${escapeHtml(plan.id)}</strong> · rating ${optimizer.consensusRating(plan)}/5 · robust score ${formatNumber(result.targetInfo.robustScore, 0)} · ${result.remainingCount} layoutov · quality mass ${formatNumber(result.qualityMass)}</div><div class="registration-week">`;
    data.days.forEach((day, dayIndex) => {
      html += `<section class="registration-day"><h3>${escapeHtml(day)}</h3>`;
      const dayEvents = (byDay.get(dayIndex) || []).sort((a, b) => a.slot - b.slot || a.type.localeCompare(b.type));
      if (!dayEvents.length) html += `<p class="free-day">Voľno</p>`;
      dayEvents.forEach((event) => {
        const subject = optimizer.subjectById.get(event.subjectId);
        html += `<div class="registration-event ${event.type === "P" ? "lecture" : "exercise"}${event.locked ? " locked" : ""}" style="--subject-color:${escapeHtml(subject?.color || "#94a3b8")}"><span class="event-time">${escapeHtml(data.slots[event.slot])}</span><strong>${escapeHtml(subject?.short || event.subjectId)}</strong><span>${escapeHtml(event.group)} · ${event.type}${event.locked ? " ✓" : ""}</span></div>`;
      });
      html += `</section>`;
    });
    els.schedule.innerHTML = `${html}</div>`;
  }

  function renderHistory() {
    const items = state.history.slice(-8).reverse();
    els.history.innerHTML = items.length ? items.map((entry) => `<div class="history-row ${entry.result === "SUCCESS" ? "yes" : "no"}"><span>${entry.result === "SUCCESS" ? "✓" : "×"}</span><strong>${escapeHtml(entry.subjectId)}</strong><span>${escapeHtml(entry.group || "")} · ${escapeHtml(entry.result)}</span></div>`).join("") : `<p class="muted-copy">Zatiaľ bez lokálnych rozhodnutí.</p>`;
  }

  function renderDryRun(result) {
    if (!els.dryRunOutput) return;
    if (!result.safeBatch.length) {
      els.dryRunOutput.innerHTML = `<p>Žiadny bezpečný batch.</p>`;
      return;
    }
    const batch = result.safeBatch.map((item) => `${item.subject?.short || item.subjectId} ${item.activity.group} (${formatActivity(item.activity)})`).join(" + ");
    const branches = result.batchOutcomes.map((branch) => `<li>${escapeHtml(branch.labels.join(" + "))} → ${branch.remainingCount} layoutov, mass ${formatNumber(branch.qualityMass)}, best ${branch.bestRating ?? "—"}/5</li>`).join("");
    els.dryRunOutput.innerHTML = `<div class="dry-run-card"><strong>Batch 1: ${escapeHtml(batch)}</strong>${branches ? `<ul>${branches}</ul>` : `<p>Prednášky sa zámerne posielajú po jednej.</p>`}</div>`;
  }

  function renderAll(showDryRun = false) {
    const result = optimizer.analyze(state);
    renderCurrent(result);
    renderPriority(result);
    renderProgress(result);
    renderSchedule(result);
    renderHistory();
    if (showDryRun) renderDryRun(result);
    els.undo.disabled = undoStack.length === 0;
    return result;
  }

  function applyManual(resultCode) {
    const result = renderAll();
    const current = result.priorities[0];
    if (!current) return;
    undoStack.push(snapshot());
    const value = current.activity.concreteActivityId ?? current.activity.localSessionId;
    if (resultCode === "SUCCESS") state.locked[current.requirementKey] = value;
    else if (!state.unavailable.map(String).includes(String(value))) state.unavailable.push(value);
    state.history.push({ result: resultCode, subjectId: current.subjectId, group: current.activity.group, at: Date.now() });
    save();
    renderAll();
  }

  function importLive(payload) {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    const activities = Array.isArray(parsed) ? parsed : parsed?.liveActivities;
    if (!Array.isArray(activities)) throw new Error("JSON neobsahuje pole liveActivities.");
    undoStack.push(snapshot());
    state.liveActivities = activities;
    save();
    renderAll(true);
  }

  window.ROZVRH_LIVE_IMPORT = importLive;
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab, #planReviewTab").forEach((button) => button.classList.remove("is-active"));
    tab.classList.add("is-active");
    ["subjectsView", "templatesView", "planReviewView"].forEach((id) => { const element = document.getElementById(id); if (element) element.hidden = true; });
    view.hidden = false;
    renderAll();
  });
  document.querySelectorAll(".tab, #planReviewTab").forEach((button) => button.addEventListener("click", () => { if (button !== tab) { tab.classList.remove("is-active"); view.hidden = true; } }));
  els.yes.addEventListener("click", () => applyManual("SUCCESS"));
  els.no.addEventListener("click", () => applyManual("FAILURE"));
  els.undo.addEventListener("click", () => { const previous = undoStack.pop(); if (previous) { state = previous; save(); renderAll(); } });
  els.reset.addEventListener("click", () => { state = defaultState(); undoStack.length = 0; save(); renderAll(); });
  els.dryRun?.addEventListener("click", () => renderAll(true));
  els.importLive?.addEventListener("click", () => {
    const payload = window.prompt("Vlož bezpečný LIVE JSON z EDISON Assistantu (bez cookies a tokenov):");
    if (!payload) return;
    try { importLive(payload); } catch (error) { window.alert(error.message); }
  });
  renderAll();
})();
