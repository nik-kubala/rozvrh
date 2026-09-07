(() => {
  "use strict";

  const utils = window.ROZVRH_PLAN_UTILS;
  if (!utils) return;

  const { data, plans, subjectById, planEvents, metrics } = utils;
  const STORAGE_KEY = "rozvrh-plan-review-v1";

  const tab = document.getElementById("planReviewTab");
  const view = document.getElementById("planReviewView");
  if (!tab || !view) return;

  const els = {
    current: document.getElementById("planReviewCurrent"),
    schedule: document.getElementById("planReviewSchedule"),
    stats: document.getElementById("planReviewStats"),
    progress: document.getElementById("planReviewProgress"),
    approve: document.getElementById("planReviewApprove"),
    reject: document.getElementById("planReviewReject"),
    prev: document.getElementById("planReviewPrev"),
    next: document.getElementById("planReviewNext"),
    reset: document.getElementById("planReviewReset"),
    statusFilter: document.getElementById("planReviewStatusFilter"),
    tierFilter: document.getElementById("planReviewTierFilter")
  };

  function defaultState() {
    return { decisions: {}, currentId: plans[0]?.id || null, statusFilter: "all", tierFilter: "all" };
  }

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return defaultState();
      return {
        decisions: parsed.decisions && typeof parsed.decisions === "object" ? parsed.decisions : {},
        currentId: parsed.currentId || plans[0]?.id || null,
        statusFilter: parsed.statusFilter || "all",
        tierFilter: parsed.tierFilter || "all"
      };
    } catch {
      return defaultState();
    }
  }

  let state = loadState();

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent("rozvrh-plan-review-changed"));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function planStatus(plan) {
    return state.decisions[plan.id] || "unreviewed";
  }

  function filteredPlans() {
    return plans.filter((plan) => {
      const statusOk = state.statusFilter === "all" || planStatus(plan) === state.statusFilter;
      const tierOk = state.tierFilter === "all" || plan.tier === state.tierFilter;
      return statusOk && tierOk;
    });
  }

  function currentPlan(list = filteredPlans()) {
    if (!list.length) return null;
    const byId = list.find((plan) => plan.id === state.currentId);
    if (byId) return byId;
    state.currentId = list[0].id;
    return list[0];
  }

  function tierText(tier) {
    if (tier === "A") return "Po–St, štvrtok aj piatok voľno";
    if (tier === "B") return "núdzový variant so štvrtkom";
    return "núdzový variant s piatkom";
  }

  function renderCurrent(plan, list) {
    if (!plan) {
      els.current.innerHTML = `<div class="review-empty"><h2>Tomuto filtru nezodpovedá žiadny rozvrh.</h2><p>Zmeň filter hore.</p></div>`;
      els.schedule.innerHTML = "";
      els.stats.innerHTML = "";
      els.approve.disabled = true;
      els.reject.disabled = true;
      return;
    }

    const status = planStatus(plan);
    const index = list.findIndex((item) => item.id === plan.id);
    const original = plans[0];
    const changed = Object.keys(plan.bySubject).filter((subjectId) => {
      const a = original.bySubject[subjectId];
      const b = plan.bySubject[subjectId];
      return a.day !== b.day || a.slot !== b.slot;
    });

    const statusLabel = status === "approved" ? "✓ schválený" : status === "rejected" ? "× zamietnutý" : "neposúdený";
    const statusClass = status === "approved" ? "approved" : status === "rejected" ? "rejected" : "unreviewed";

    els.current.innerHTML = `
      <div class="review-card-head">
        <div>
          <p class="eyebrow">Rozvrh ${escapeHtml(plan.id)} · ${index + 1}/${list.length} v aktuálnom filtri</p>
          <h2>${escapeHtml(tierText(plan.tier))}</h2>
          <p>${changed.length ? `Oproti A001 sa mení: ${escapeHtml(changed.map((id) => subjectById.get(id)?.short || id).join(", "))}.` : "Toto je pôvodné Ačko bez zmien."}</p>
        </div>
        <span class="review-status ${statusClass}">${statusLabel}</span>
      </div>`;

    const m = metrics(plan);
    els.stats.innerHTML = `
      <div class="stat"><span>Kategória</span><strong>${escapeHtml(plan.tier)}</strong></div>
      <div class="stat"><span>Školské dni</span><strong>${m.activeDays}</strong></div>
      <div class="stat"><span>Diery</span><strong>${m.gaps}</strong></div>
      <div class="stat"><span>Najskôr</span><strong>${escapeHtml(m.earliest)}</strong></div>
      <div class="stat"><span>Najneskôr</span><strong>${escapeHtml(m.latest)}</strong></div>
      <div class="stat ${m.thursdayFree ? "good" : "bad"}"><span>Štvrtok</span><strong>${m.thursdayFree ? "voľno" : "škola"}</strong></div>
      <div class="stat ${m.fridayFree ? "good" : "bad"}"><span>Piatok</span><strong>${m.fridayFree ? "voľno" : "škola"}</strong></div>`;

    renderSchedule(plan);
    els.approve.disabled = false;
    els.reject.disabled = false;
  }

  function renderSchedule(plan) {
    const events = planEvents(plan);
    const byDay = new Map();
    for (const event of events) {
      if (!byDay.has(event.day)) byDay.set(event.day, []);
      byDay.get(event.day).push(event);
    }

    let html = `<div class="registration-week review-week">`;
    data.days.forEach((day, dayIndex) => {
      const dayEvents = (byDay.get(dayIndex) || []).sort((a, b) => a.slot - b.slot);
      html += `<section class="registration-day"><h3>${escapeHtml(day)}</h3>`;
      if (!dayEvents.length) {
        html += `<p class="free-day">Voľno</p>`;
      } else {
        for (const event of dayEvents) {
          const subject = subjectById.get(event.subjectId);
          html += `<div class="registration-event ${event.type === "P" ? "lecture" : "exercise"}" style="--subject-color:${escapeHtml(subject?.color || "#94a3b8")}">
            <span class="event-time">${escapeHtml(data.slots[event.slot])}</span>
            <strong>${escapeHtml(subject?.short || "")}</strong>
            <span>${escapeHtml(event.group)} · ${event.type}</span>
          </div>`;
        }
      }
      html += `</section>`;
    });
    html += `</div>`;
    els.schedule.innerHTML = html;
  }

  function renderProgress() {
    const statuses = plans.reduce((acc, plan) => {
      acc[planStatus(plan)] += 1;
      return acc;
    }, { approved: 0, rejected: 0, unreviewed: 0 });
    const reviewed = statuses.approved + statuses.rejected;
    const pct = Math.round((reviewed / plans.length) * 100);

    els.progress.innerHTML = `
      <div class="review-counts">
        <div><span>Schválené</span><strong>${statuses.approved}</strong></div>
        <div><span>Zamietnuté</span><strong>${statuses.rejected}</strong></div>
        <div><span>Zostáva</span><strong>${statuses.unreviewed}</strong></div>
        <div><span>Hotovo</span><strong>${pct}%</strong></div>
      </div>
      <div class="progress-bar"><span style="width:${pct}%"></span></div>`;
  }

  function render() {
    els.statusFilter.value = state.statusFilter;
    els.tierFilter.value = state.tierFilter;
    const list = filteredPlans();
    const plan = currentPlan(list);
    renderProgress();
    renderCurrent(plan, list);
    els.prev.disabled = list.length <= 1;
    els.next.disabled = list.length <= 1;
  }

  function move(delta) {
    const list = filteredPlans();
    if (!list.length) return;
    const plan = currentPlan(list);
    let index = list.findIndex((item) => item.id === plan.id);
    index = (index + delta + list.length) % list.length;
    state.currentId = list[index].id;
    saveState();
    render();
  }

  function findNextUnreviewed(afterId) {
    const tierFiltered = plans.filter((plan) => state.tierFilter === "all" || plan.tier === state.tierFilter);
    if (!tierFiltered.length) return null;
    const start = Math.max(0, tierFiltered.findIndex((plan) => plan.id === afterId));
    for (let offset = 1; offset <= tierFiltered.length; offset += 1) {
      const plan = tierFiltered[(start + offset) % tierFiltered.length];
      if (planStatus(plan) === "unreviewed") return plan;
    }
    return null;
  }

  function decide(status) {
    const list = filteredPlans();
    const plan = currentPlan(list);
    if (!plan) return;
    state.decisions[plan.id] = status;
    const next = findNextUnreviewed(plan.id);
    if (next) state.currentId = next.id;
    saveState();
    render();
  }

  function showReview() {
    document.querySelectorAll(".tab").forEach((button) => button.classList.remove("is-active"));
    document.getElementById("registrationTab")?.classList.remove("is-active");
    tab.classList.add("is-active");
    document.getElementById("subjectsView").hidden = true;
    document.getElementById("templatesView").hidden = true;
    document.getElementById("registrationView").hidden = true;
    view.hidden = false;
    render();
  }

  tab.addEventListener("click", showReview);
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      tab.classList.remove("is-active");
      view.hidden = true;
    });
  });
  document.getElementById("registrationTab")?.addEventListener("click", () => {
    tab.classList.remove("is-active");
    view.hidden = true;
  });

  els.approve.addEventListener("click", () => decide("approved"));
  els.reject.addEventListener("click", () => decide("rejected"));
  els.prev.addEventListener("click", () => move(-1));
  els.next.addEventListener("click", () => move(1));

  els.statusFilter.addEventListener("change", () => {
    state.statusFilter = els.statusFilter.value;
    const list = filteredPlans();
    state.currentId = list[0]?.id || null;
    saveState();
    render();
  });

  els.tierFilter.addEventListener("change", () => {
    state.tierFilter = els.tierFilter.value;
    const list = filteredPlans();
    state.currentId = list[0]?.id || null;
    saveState();
    render();
  });

  els.reset.addEventListener("click", () => {
    state = defaultState();
    saveState();
    render();
  });

  render();
})();