(() => {
  "use strict";

  const data = window.ROZVRH_DATA;
  if (!data) {
    document.body.innerHTML = "<p>Chýbajú dáta rozvrhu.</p>";
    return;
  }

  const subjectById = new Map(data.subjects.map((subject) => [subject.id, subject]));
  const sessionById = new Map();
  for (const subject of data.subjects) {
    for (const session of subject.sessions) {
      sessionById.set(session.id, { ...session, subjectId: subject.id });
    }
  }

  const state = {
    view: "subjects",
    subjectId: data.subjects[0]?.id ?? null,
    typeFilter: "all",
    selectedSessionId: null,
    templateIndex: 0
  };

  const els = {
    tabs: [...document.querySelectorAll(".tab")],
    subjectsView: document.getElementById("subjectsView"),
    templatesView: document.getElementById("templatesView"),
    subjectSelect: document.getElementById("subjectSelect"),
    typeButtons: [...document.querySelectorAll("[data-type-filter]")],
    subjectMeta: document.getElementById("subjectMeta"),
    subjectSchedule: document.getElementById("subjectSchedule"),
    sessionDetail: document.getElementById("sessionDetail"),
    templateSelect: document.getElementById("templateSelect"),
    prevTemplate: document.getElementById("prevTemplate"),
    nextTemplate: document.getElementById("nextTemplate"),
    templateHeader: document.getElementById("templateHeader"),
    templateStats: document.getElementById("templateStats"),
    templateWarnings: document.getElementById("templateWarnings"),
    templateSchedule: document.getElementById("templateSchedule")
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function subjectForSession(session) {
    return subjectById.get(session.subjectId);
  }

  function renderSessionCard(session, options = {}) {
    const subject = subjectForSession(session);
    const selected = state.selectedSessionId === session.id;
    const title = options.includeSubject
      ? `${subject?.short ?? ""} · ${session.group}`
      : session.group;
    const detailBits = [];
    if (session.week) detailBits.push(session.week);
    if (session.room) detailBits.push(session.room);
    if (session.teacher) detailBits.push(session.teacher);

    return `
      <button
        type="button"
        class="session-card type-${session.type.toLowerCase()}${selected ? " is-selected" : ""}"
        data-session-id="${escapeHtml(session.id)}"
        style="--subject-color:${escapeHtml(subject?.color ?? "#94a3b8")}"
        aria-label="${escapeHtml(`${title}, ${data.days[session.day]}, ${data.slots[session.slot]}`)}"
      >
        <span class="session-topline">
          <strong>${escapeHtml(title)}</strong>
          <span class="type-badge">${escapeHtml(session.type)}</span>
        </span>
        ${detailBits.length ? `<span class="session-small">${escapeHtml(detailBits.join(" · "))}</span>` : ""}
      </button>
    `;
  }

  function renderDesktopGrid(events, includeSubject = false) {
    const groups = new Map();
    for (const event of events) {
      const key = `${event.day}-${event.slot}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }

    let html = `<div class="schedule-scroll"><div class="schedule-grid desktop-grid">`;
    html += `<div class="grid-corner">Čas</div>`;
    data.days.forEach((day) => {
      html += `<div class="grid-day">${escapeHtml(day)}</div>`;
    });

    data.slots.forEach((slotLabel, slotIndex) => {
      html += `<div class="grid-time">${escapeHtml(slotLabel)}</div>`;
      data.days.forEach((_, dayIndex) => {
        const cellEvents = groups.get(`${dayIndex}-${slotIndex}`) ?? [];
        html += `<div class="grid-cell ${cellEvents.length ? "has-events" : ""}">`;
        if (cellEvents.length) {
          html += `<div class="session-stack">`;
          cellEvents.forEach((event) => {
            html += renderSessionCard(event, { includeSubject });
          });
          html += `</div>`;
        }
        html += `</div>`;
      });
    });

    html += `</div></div>`;
    return html;
  }

  function renderMobileAgenda(events, includeSubject = false) {
    const byDay = new Map();
    events.forEach((event) => {
      if (!byDay.has(event.day)) byDay.set(event.day, []);
      byDay.get(event.day).push(event);
    });

    let html = `<div class="mobile-agenda">`;
    data.days.forEach((day, dayIndex) => {
      const dayEvents = (byDay.get(dayIndex) ?? []).sort(
        (a, b) => a.slot - b.slot || a.group.localeCompare(b.group)
      );
      if (!dayEvents.length) return;

      html += `<section class="agenda-day"><h3>${escapeHtml(day)}</h3>`;
      dayEvents.forEach((event) => {
        html += `
          <div class="agenda-row">
            <time>${escapeHtml(data.slots[event.slot])}</time>
            ${renderSessionCard(event, { includeSubject })}
          </div>
        `;
      });
      html += `</section>`;
    });
    html += `</div>`;
    return html;
  }

  function renderSchedule(target, events, includeSubject = false) {
    target.innerHTML =
      renderDesktopGrid(events, includeSubject) +
      renderMobileAgenda(events, includeSubject);
    bindSessionCards(target);
  }

  function bindSessionCards(scope) {
    scope.querySelectorAll("[data-session-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedSessionId =
          state.selectedSessionId === button.dataset.sessionId
            ? null
            : button.dataset.sessionId;
        if (state.view === "subjects") {
          renderSubjectView();
        } else {
          renderTemplateView();
        }
      });
    });
  }

  function renderSubjectMeta(subject, filteredEvents) {
    const pCount = subject.sessions.filter((session) => session.type === "P").length;
    const cCount = subject.sessions.filter((session) => session.type === "C").length;
    const missing = subject.missingLecture
      ? `<span class="warning-chip">Prednáška zatiaľ chýba v dátach</span>`
      : "";

    els.subjectMeta.innerHTML = `
      <div>
        <p class="eyebrow">${escapeHtml(subject.code)} · požiadavka ${escapeHtml(subject.requirement)}</p>
        <h2>${escapeHtml(subject.name)}</h2>
      </div>
      <div class="meta-chips">
        <span class="meta-chip">${pCount} ${pCount === 1 ? "prednáška" : "prednášky"}</span>
        <span class="meta-chip">${cCount} cvičení</span>
        <span class="meta-chip">${filteredEvents.length} zobrazených</span>
        ${missing}
      </div>
    `;
  }

  function renderSessionDetail(subject) {
    const session = state.selectedSessionId
      ? sessionById.get(state.selectedSessionId)
      : null;

    if (!session || session.subjectId !== subject.id) {
      els.sessionDetail.innerHTML = `
        <div>
          <strong>Klikni na termín</strong>
          <p>Vybraný blok sa tu zobrazí s presným dňom, časom a dostupnými detailmi.</p>
        </div>
      `;
      return;
    }

    els.sessionDetail.innerHTML = `
      <div>
        <p class="eyebrow">${session.type === "P" ? "Prednáška" : "Cvičenie"}</p>
        <h3>${escapeHtml(subject.name)} · ${escapeHtml(session.group)}</h3>
        <p>
          <strong>${escapeHtml(data.days[session.day])}</strong>,
          ${escapeHtml(data.slots[session.slot])}
          ${session.week ? ` · ${escapeHtml(session.week)}` : ""}
        </p>
        ${session.teacher ? `<p>Vyučujúci: ${escapeHtml(session.teacher)}</p>` : ""}
        ${session.room ? `<p>Miestnosť: ${escapeHtml(session.room)}</p>` : ""}
      </div>
    `;
  }

  function renderSubjectView() {
    const subject = subjectById.get(state.subjectId);
    if (!subject) return;

    const filteredEvents = subject.sessions
      .filter((session) => state.typeFilter === "all" || session.type === state.typeFilter)
      .map((session) => ({ ...session, subjectId: subject.id }));

    renderSubjectMeta(subject, filteredEvents);
    renderSchedule(els.subjectSchedule, filteredEvents, false);
    renderSessionDetail(subject);

    els.typeButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.typeFilter === state.typeFilter);
    });
  }

  function templateEvents(template) {
    return template.sessionIds
      .map((id) => sessionById.get(id))
      .filter(Boolean);
  }

  function templateMetrics(events) {
    if (!events.length) {
      return {
        activeDays: 0,
        earliest: "—",
        latest: "—",
        freeDays: data.days.length,
        conflicts: 0
      };
    }

    const activeDaySet = new Set(events.map((event) => event.day));
    const slotIndexes = events.map((event) => event.slot);
    let conflicts = 0;

    const seen = new Set();
    for (const event of events) {
      const key = `${event.day}-${event.slot}`;
      if (seen.has(key)) conflicts += 1;
      seen.add(key);
    }

    return {
      activeDays: activeDaySet.size,
      earliest: data.slots[Math.min(...slotIndexes)].split("–")[0],
      latest: data.slots[Math.max(...slotIndexes)].split("–")[1],
      freeDays: data.days.length - activeDaySet.size,
      conflicts
    };
  }

  function renderTemplateStats(events) {
    const metrics = templateMetrics(events);
    const thursdayFree = !events.some((event) => event.day === 3);
    const fridayFree = !events.some((event) => event.day === 4);

    els.templateStats.innerHTML = `
      <div class="stat"><span>Školské dni</span><strong>${metrics.activeDays}</strong></div>
      <div class="stat"><span>Najskôr</span><strong>${escapeHtml(metrics.earliest)}</strong></div>
      <div class="stat"><span>Najneskôr</span><strong>${escapeHtml(metrics.latest)}</strong></div>
      <div class="stat"><span>Voľno</span><strong>${metrics.freeDays} dni</strong></div>
      <div class="stat ${thursdayFree ? "good" : ""}"><span>Štvrtok</span><strong>${thursdayFree ? "voľno" : "škola"}</strong></div>
      <div class="stat ${fridayFree ? "good" : ""}"><span>Piatok</span><strong>${fridayFree ? "voľno" : "škola"}</strong></div>
      <div class="stat ${metrics.conflicts ? "bad" : "good"}"><span>Kolízie</span><strong>${metrics.conflicts}</strong></div>
    `;
  }

  function renderTemplateWarnings(template, events) {
    const warnings = [...(template.warnings ?? [])];
    const metrics = templateMetrics(events);
    if (metrics.conflicts) {
      warnings.push(`Šablóna obsahuje ${metrics.conflicts} časovú kolíziu/kolízie.`);
    }

    els.templateWarnings.innerHTML = warnings.length
      ? `<div class="warning-box">${warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}</div>`
      : `<div class="ok-box">Šablóna je bez známych kolízií a rešpektuje 15-minútové prestávky medzi susednými blokmi.</div>`;
  }

  function renderTemplateView() {
    const templates = data.templates ?? [];
    if (!templates.length) {
      els.templateHeader.innerHTML = `<h2>Zatiaľ nie sú nahrané žiadne šablóny.</h2>`;
      els.templateStats.innerHTML = "";
      els.templateWarnings.innerHTML = "";
      els.templateSchedule.innerHTML = "";
      els.prevTemplate.disabled = true;
      els.nextTemplate.disabled = true;
      return;
    }

    state.templateIndex = Math.max(0, Math.min(state.templateIndex, templates.length - 1));
    const template = templates[state.templateIndex];
    const events = templateEvents(template);

    els.templateSelect.value = template.id;
    els.prevTemplate.disabled = templates.length <= 1;
    els.nextTemplate.disabled = templates.length <= 1;

    els.templateHeader.innerHTML = `
      <p class="eyebrow">Šablóna ${state.templateIndex + 1} z ${templates.length}</p>
      <h2>${escapeHtml(template.name)}</h2>
      <p>${escapeHtml(template.description ?? "")}</p>
    `;

    renderTemplateStats(events);
    renderTemplateWarnings(template, events);
    renderSchedule(els.templateSchedule, events, true);
  }

  function switchView(view) {
    state.view = view;
    state.selectedSessionId = null;
    els.tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === view));
    els.subjectsView.hidden = view !== "subjects";
    els.templatesView.hidden = view !== "templates";

    if (view === "subjects") {
      renderSubjectView();
    } else {
      renderTemplateView();
    }
  }

  function fillControls() {
    els.subjectSelect.innerHTML = data.subjects
      .map((subject) => `<option value="${escapeHtml(subject.id)}">${escapeHtml(subject.name)}</option>`)
      .join("");
    els.subjectSelect.value = state.subjectId;

    const templates = data.templates ?? [];
    els.templateSelect.innerHTML = templates
      .map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`)
      .join("");
  }

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  els.subjectSelect.addEventListener("change", () => {
    state.subjectId = els.subjectSelect.value;
    state.selectedSessionId = null;
    renderSubjectView();
  });

  els.typeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.typeFilter = button.dataset.typeFilter;
      state.selectedSessionId = null;
      renderSubjectView();
    });
  });

  els.templateSelect.addEventListener("change", () => {
    const index = data.templates.findIndex((template) => template.id === els.templateSelect.value);
    if (index >= 0) state.templateIndex = index;
    state.selectedSessionId = null;
    renderTemplateView();
  });

  els.prevTemplate.addEventListener("click", () => {
    const count = data.templates.length;
    if (!count) return;
    state.templateIndex = (state.templateIndex - 1 + count) % count;
    state.selectedSessionId = null;
    renderTemplateView();
  });

  els.nextTemplate.addEventListener("click", () => {
    const count = data.templates.length;
    if (!count) return;
    state.templateIndex = (state.templateIndex + 1) % count;
    state.selectedSessionId = null;
    renderTemplateView();
  });

  fillControls();
  renderSubjectView();
})();