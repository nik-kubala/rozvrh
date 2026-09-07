(() => {
  "use strict";

  const utils = window.ROZVRH_PLAN_UTILS;
  if (!utils) return;

  const { data, plans, subjectById, planEvents, metrics } = utils;
  const STORAGE_KEY = "rozvrh-plan-review-v1";
  const BACKUP_KEY = "rozvrh-plan-review-backup-v2";

  const tab = document.getElementById("planReviewTab");
  const view = document.getElementById("planReviewView");
  if (!tab || !view) return;

  const els = {
    current: document.getElementById("planReviewCurrent"),
    schedule: document.getElementById("planReviewSchedule"),
    stats: document.getElementById("planReviewStats"),
    progress: document.getElementById("planReviewProgress"),
    rating1: document.getElementById("planReviewRating1"),
    rating2: document.getElementById("planReviewRating2"),
    rating3: document.getElementById("planReviewRating3"),
    prev: document.getElementById("planReviewPrev"),
    next: document.getElementById("planReviewNext"),
    reset: document.getElementById("planReviewReset"),
    export: document.getElementById("planReviewExport"),
    import: document.getElementById("planReviewImport"),
    importFile: document.getElementById("planReviewImportFile"),
    statusFilter: document.getElementById("planReviewStatusFilter"),
    tierFilter: document.getElementById("planReviewTierFilter")
  };

  function defaultState() {
    return {
      decisions: {},
      ratings: {},
      currentId: plans[0]?.id || null,
      statusFilter: "all",
      tierFilter: "all",
      lastSavedAt: null
    };
  }

  function normalizeState(parsed) {
    const base = defaultState();
    if (!parsed || typeof parsed !== "object") return base;

    const ratings = parsed.ratings && typeof parsed.ratings === "object" ? { ...parsed.ratings } : {};
    const decisions = parsed.decisions && typeof parsed.decisions === "object" ? { ...parsed.decisions } : {};

    // Migrácia pôvodného dvojstavového hodnotenia.
    for (const plan of plans) {
      const rawRating = Number(ratings[plan.id]);
      if (rawRating >= 1 && rawRating <= 3) {
        ratings[plan.id] = rawRating;
        continue;
      }
      if (decisions[plan.id] === "approved") ratings[plan.id] = 1;
      if (decisions[plan.id] === "rejected") ratings[plan.id] = 3;
    }

    const migratedFilter = ["1", "2", "3", "unreviewed", "all"].includes(parsed.statusFilter)
      ? parsed.statusFilter
      : "all";

    return {
      decisions,
      ratings,
      currentId: parsed.currentId || base.currentId,
      statusFilter: migratedFilter,
      tierFilter: ["A", "B", "C", "all"].includes(parsed.tierFilter) ? parsed.tierFilter : "all",
      lastSavedAt: parsed.lastSavedAt || null
    };
  }

  function loadState() {
    for (const key of [STORAGE_KEY, BACKUP_KEY]) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        return normalizeState(JSON.parse(raw));
      } catch {
        // Skús druhú lokálnu kópiu.
      }
    }
    return defaultState();
  }

  let state = loadState();

  // plan-review.js si ponechá pôvodné poradie na prezeranie. Pre LIVE vytvoríme
  // samostatné pole, ktoré môže byť zoradené 1 -> 2 -> ostatné bez zmeny review poradia.
  const registrationPlans = [...plans];
  utils.plans = registrationPlans;

  function ratingFor(planOrId) {
    const id = typeof planOrId === "string" ? planOrId : planOrId?.id;
    const value = Number(state.ratings[id]);
    return value >= 1 && value <= 3 ? value : 0;
  }

  function syncCompatibilityDecisions() {
    const decisions = {};
    for (const plan of plans) {
      const rating = ratingFor(plan);
      if (rating === 1 || rating === 2) decisions[plan.id] = "approved";
      if (rating === 3) decisions[plan.id] = "rejected";
    }
    state.decisions = decisions;
  }

  function syncRegistrationPlanOrder() {
    registrationPlans.sort((a, b) => {
      const ar = ratingFor(a);
      const br = ratingFor(b);
      const rank = (rating) => rating === 1 ? 0 : rating === 2 ? 1 : 2;
      const rankDiff = rank(ar) - rank(br);
      if (rankDiff) return rankDiff;
      if (a.score !== b.score) return a.score - b.score;
      return a.id.localeCompare(b.id);
    });
  }

  function saveState() {
    syncCompatibilityDecisions();
    state.lastSavedAt = new Date().toISOString();
    const serialized = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, serialized);
    localStorage.setItem(BACKUP_KEY, serialized);
    syncRegistrationPlanOrder();
    window.dispatchEvent(new CustomEvent("rozvrh-plan-review-changed"));
  }

  syncCompatibilityDecisions();
  syncRegistrationPlanOrder();

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function planStatus(plan) {
    const rating = ratingFor(plan);
    return rating ? String(rating) : "unreviewed";
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

  function ratingLabel(rating) {
    if (rating === 1) return "1 · výborný";
    if (rating === 2) return "2 · prijateľný fallback";
    if (rating === 3) return "3 · nechcem";
    return "neohodnotený";
  }

  function renderCurrent(plan, list) {
    if (!plan) {
      els.current.innerHTML = `<div class="review-empty"><h2>Tomuto filtru nezodpovedá žiadny rozvrh.</h2><p>Zmeň filter hore.</p></div>`;
      els.schedule.innerHTML = "";
      els.stats.innerHTML = "";
      els.rating1.disabled = true;
      els.rating2.disabled = true;
      els.rating3.disabled = true;
      return;
    }

    const rating = ratingFor(plan);
    const index = list.findIndex((item) => item.id === plan.id);
    const original = plans[0];
    const changed = Object.keys(plan.bySubject).filter((subjectId) => {
      const a = original.bySubject[subjectId];
      const b = plan.bySubject[subjectId];
      return a.day !== b.day || a.slot !== b.slot;
    });

    const statusClass = rating ? `rating-${rating}` : "unreviewed";

    els.current.innerHTML = `
      <div class="review-card-head">
        <div>
          <p class="eyebrow">Rozvrh ${escapeHtml(plan.id)} · ${index + 1}/${list.length} v aktuálnom filtri</p>
          <h2>${escapeHtml(tierText(plan.tier))}</h2>
          <p>${changed.length ? `Oproti A001 sa mení: ${escapeHtml(changed.map((id) => subjectById.get(id)?.short || id).join(", "))}.` : "Toto je pôvodné Ačko bez zmien."}</p>
        </div>
        <span class="review-status ${statusClass}">${escapeHtml(ratingLabel(rating))}</span>
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
    els.rating1.disabled = false;
    els.rating2.disabled = false;
    els.rating3.disabled = false;
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

  function counts() {
    const result = { 1: 0, 2: 0, 3: 0, unreviewed: 0 };
    for (const plan of plans) {
      const rating = ratingFor(plan);
      if (rating) result[rating] += 1;
      else result.unreviewed += 1;
    }
    return result;
  }

  function renderProgress() {
    const c = counts();
    const reviewed = c[1] + c[2] + c[3];
    const pct = Math.round((reviewed / plans.length) * 100);
    const saved = state.lastSavedAt
      ? new Date(state.lastSavedAt).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "zatiaľ nič";

    els.progress.innerHTML = `
      <div class="review-counts">
        <div class="count-1"><span>1 · výborné</span><strong>${c[1]}</strong></div>
        <div class="count-2"><span>2 · fallback</span><strong>${c[2]}</strong></div>
        <div class="count-3"><span>3 · nechcem</span><strong>${c[3]}</strong></div>
        <div><span>Zostáva</span><strong>${c.unreviewed}</strong></div>
        <div><span>Hotovo</span><strong>${pct}%</strong></div>
      </div>
      <div class="progress-bar"><span style="width:${pct}%"></span></div>
      <p class="review-save-note">Automaticky uložené po každom hodnotení · posledný zápis: ${escapeHtml(saved)}. Pre istotu môžeš kedykoľvek exportovať JSON zálohu.</p>`;
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
      if (!ratingFor(plan)) return plan;
    }
    return null;
  }

  function decide(rating) {
    const list = filteredPlans();
    const plan = currentPlan(list);
    if (!plan) return;
    state.ratings[plan.id] = rating;
    const next = findNextUnreviewed(plan.id);
    if (next) state.currentId = next.id;
    saveState();
    render();
  }

  function exportRatings() {
    saveState();
    const c = counts();
    const payload = {
      format: "rozvrh-ratings-v1",
      fixedPlansVersion: window.ROZVRH_FIXED_PLANS?.version ?? null,
      exportedAt: new Date().toISOString(),
      totalPlans: plans.length,
      summary: {
        rating1: c[1],
        rating2: c[2],
        rating3: c[3],
        unreviewed: c.unreviewed
      },
      ratings: { ...state.ratings },
      plans: plans
        .filter((plan) => ratingFor(plan))
        .map((plan) => ({ id: plan.id, tier: plan.tier, score: plan.score, rating: ratingFor(plan) }))
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `rozvrh-hodnotenia-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importRatings(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = parsed?.ratings;
      if (!incoming || typeof incoming !== "object") throw new Error("Súbor neobsahuje ratings.");

      const validIds = new Set(plans.map((plan) => plan.id));
      const ratings = {};
      for (const [id, rawRating] of Object.entries(incoming)) {
        const rating = Number(rawRating);
        if (validIds.has(id) && rating >= 1 && rating <= 3) ratings[id] = rating;
      }

      if (!Object.keys(ratings).length) throw new Error("Nenašli sa žiadne platné hodnotenia.");
      if (!window.confirm(`Importovať ${Object.keys(ratings).length} hodnotení a nahradiť aktuálny výber?`)) return;

      state.ratings = ratings;
      state.currentId = plans.find((plan) => !ratingFor(plan))?.id || plans[0]?.id || null;
      state.statusFilter = "all";
      state.tierFilter = "all";
      saveState();
      render();
    } catch (error) {
      window.alert(`Import sa nepodaril: ${error?.message || error}`);
    } finally {
      if (els.importFile) els.importFile.value = "";
    }
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

  els.rating1.addEventListener("click", () => decide(1));
  els.rating2.addEventListener("click", () => decide(2));
  els.rating3.addEventListener("click", () => decide(3));
  els.prev.addEventListener("click", () => move(-1));
  els.next.addEventListener("click", () => move(1));
  els.export.addEventListener("click", exportRatings);
  els.import.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", () => importRatings(els.importFile.files?.[0]));

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
    if (!window.confirm("Naozaj vymazať všetky hodnotenia 1/2/3? Pred resetom si môžeš spraviť export.")) return;
    state = defaultState();
    saveState();
    render();
  });

  render();
})();