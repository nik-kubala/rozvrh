(() => {
  "use strict";

  const PORTLET_BASE = "/wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection";
  const LOCAL_KEY = "edison-rozvrh-assistant-v1";
  const core = window.ROZVRH_OPTIMIZER;
  const optimizer = core.createOptimizer({
    data: window.ROZVRH_DATA,
    fixedPlans: window.ROZVRH_FIXED_PLANS,
    preferences: window.ROZVRH_PREFERENCES
  });

  const runtime = {
    mode: "OFF",
    registration: "UNKNOWN",
    obligations: new Map(),
    liveActivities: [],
    loadedSubjects: 0,
    message: "Inicializujem read-only dáta…",
    armedUntil: 0,
    abortControllers: new Set(),
    running: false,
    dryRunVisible: false,
    dryRunResult: null
  };

  function defaultLocalState() {
    return { locked: {}, unavailable: [], history: [] };
  }

  function loadLocalState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
      return parsed && typeof parsed === "object" ? { ...defaultLocalState(), ...parsed } : defaultLocalState();
    } catch {
      return defaultLocalState();
    }
  }

  let localState = loadLocalState();
  let panel;

  function saveLocalState() {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localState));
  }

  function optimizerState() {
    return { ...localState, liveActivities: runtime.liveActivities };
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function portletId() {
    const table = document.querySelector('[id$=":subjectsTable"]');
    return table?.id.replace(":subjectsTable", "") || "";
  }

  function discoverObligations() {
    const table = document.querySelector('[id$=":subjectsTable"]');
    if (!table) throw new Error("Na tejto stránke nevidím tabuľku predmetov EDISONu.");
    const found = new Map();
    for (const row of table.querySelectorAll("tr")) {
      const title = row.querySelector("abbr[title*='Číslo předmětu']")?.getAttribute("title") || "";
      const courseNumber = title.match(/\d{3}-\d{4}\/\d{2}/)?.[0];
      const code = courseNumber?.replace(/\D/g, "");
      const onclick = row.querySelector('a[onclick*="selectStudyYearObligation"]')?.getAttribute("onclick") || "";
      const studyYearObligationId = Number(onclick.match(/\((\d+)\)/)?.[1]);
      if (code && studyYearObligationId) found.set(code, { code, courseNumber, studyYearObligationId });
    }
    runtime.obligations = found;
    return found;
  }

  async function requestJson(method, path, { allowNetworkRetry = false } = {}) {
    const id = portletId();
    if (!id) throw Object.assign(new Error("Portlet ID nebol nájdený."), { code: "AUTH_EXPIRED" });
    const url = method === "GET" ? `${PORTLET_BASE}/${path}?${new URLSearchParams({ portletId: id, _: Date.now() })}` : `${PORTLET_BASE}/${path}`;
    const controller = new AbortController();
    runtime.abortControllers.add(controller);
    try {
      const response = await fetch(url, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: method === "PUT" ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json" } : { Accept: "application/json" },
        body: method === "PUT" ? new URLSearchParams({ portletId: id }) : undefined,
        signal: controller.signal,
        redirect: "follow"
      });
      const contentType = response.headers.get("content-type") || "";
      if (response.redirected || !contentType.toLowerCase().includes("json")) {
        throw Object.assign(new Error("EDISON nevrátil JSON; prihlásenie pravdepodobne vypršalo."), { code: "AUTH_EXPIRED", status: response.status, contentType });
      }
      const payload = await response.json();
      return { payload, status: response.status, contentType };
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(error, { code: "STOPPED" });
      if (error.code) throw error;
      if (allowNetworkRetry) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        return requestJson(method, path, { allowNetworkRetry: false });
      }
      throw Object.assign(error, { code: "NETWORK_ERROR" });
    } finally {
      runtime.abortControllers.delete(controller);
    }
  }

  async function mapLimit(items, limit, worker) {
    const result = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        result[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return result;
  }

  function mergeActivities(payload) {
    const incoming = core.extractActivityDtos(payload).map(optimizer.normalizeActivity).filter((item) => item.localSessionId);
    const merged = new Map(runtime.liveActivities.map((item) => [item.localSessionId, item]));
    incoming.forEach((item) => merged.set(item.localSessionId, item));
    runtime.liveActivities = [...merged.values()];
    syncSelectedFromServer();
  }

  function syncSelectedFromServer() {
    for (const activity of runtime.liveActivities.filter((item) => item.selected)) {
      if (activity.type === "C") localState.locked[activity.subjectId] = activity.concreteActivityId;
      else {
        const requirement = (window.ROZVRH_PREFERENCES.lectureRequirements || []).find((item) => item.alternatives.includes(activity.localSessionId));
        if (requirement) localState.locked[requirement.key] = activity.concreteActivityId;
      }
    }
    saveLocalState();
  }

  async function refreshData({ silent = false } = {}) {
    if (runtime.running) return;
    runtime.message = "Načítavam registračný stav a 7 predmetov…";
    runtime.loadedSubjects = 0;
    if (!silent) render();
    try {
      const refresh = await requestJson("GET", "refreshPage");
      runtime.registration = refresh.payload.opened === true ? "OPEN" : "CLOSED";
      mergeActivities(refresh.payload);
      const obligations = discoverObligations();
      const subjects = window.ROZVRH_DATA.subjects.filter((subject) => window.ROZVRH_FIXED_PLANS.subjects.includes(subject.id));
      const missing = subjects.filter((subject) => !obligations.has(subject.code));
      if (missing.length) throw new Error(`Chýba mapping: ${missing.map((item) => item.short).join(", ")}`);
      const responses = await mapLimit(subjects, 2, async (subject) => {
        const mapping = obligations.get(subject.code);
        const response = await requestJson("PUT", `selectStudyYearObligation/${mapping.studyYearObligationId}`);
        runtime.loadedSubjects += 1;
        mergeActivities(response.payload);
        render();
        return response.payload;
      });
      responses.forEach(mergeActivities);
      runtime.message = `Dáta načítané ${new Date().toLocaleTimeString("sk-SK")}.`;
    } catch (error) {
      if (error.code === "AUTH_EXPIRED") stop("AUTH_EXPIRED — znovu sa prihlás do EDISONu.");
      else runtime.message = `${error.code || "CHYBA"}: ${error.message}`;
    }
    render();
  }

  function stop(message = "STOP — ďalšie requesty sú zablokované.") {
    runtime.abortControllers.forEach((controller) => controller.abort());
    runtime.abortControllers.clear();
    runtime.running = false;
    runtime.mode = "STOPPED";
    runtime.armedUntil = 0;
    runtime.message = message;
    render();
  }

  function arm() {
    if (runtime.running) return;
    if (runtime.loadedSubjects !== 7) {
      runtime.message = "ARM odmietnutý: najprv musí byť načítaných 7/7 predmetov.";
      render();
      return;
    }
    if (runtime.registration !== "OPEN") {
      runtime.message = "ARM odmietnutý: EDISON hlási zatvorenú registráciu.";
      render();
      return;
    }
    runtime.mode = "ARMED";
    runtime.armedUntil = Date.now() + 60_000;
    runtime.message = "ARMED na 60 sekúnd. Zápis začne až po samostatnom kliknutí START.";
    render();
  }

  async function submitCandidate(candidate) {
    const activityId = candidate.activity.concreteActivityId;
    if (!Number.isFinite(activityId)) return { ok: false, code: "UNKNOWN_SERVER_ERROR", message: "Chýba concreteActivityId." };
    try {
      const response = await requestJson("PUT", `selectConcreteActivity/${activityId}`, { allowNetworkRetry: true });
      mergeActivities(response.payload);
      const outcome = core.classifyActivityResponse({ ...response, activityId });
      const value = activityId;
      if (outcome.ok) localState.locked[candidate.requirementKey] = value;
      else if (["FULL", "COLLISION"].includes(outcome.code) && !localState.unavailable.map(String).includes(String(value))) localState.unavailable.push(value);
      localState.history.push({ at: Date.now(), result: outcome.code, subjectId: candidate.subjectId, group: candidate.activity.group, concreteActivityId: value });
      saveLocalState();
      runtime.message = `${candidate.subject?.short || candidate.subjectId} ${candidate.activity.group}: ${outcome.code} — ${outcome.message}`;
      render();
      return outcome;
    } catch (error) {
      const code = error.code || "NETWORK_ERROR";
      const outcome = { ok: false, code, message: error.message };
      runtime.message = `${candidate.subject?.short || candidate.subjectId}: ${code} — ${error.message}`;
      render();
      return outcome;
    }
  }

  async function start() {
    if (runtime.mode !== "ARMED" || Date.now() > runtime.armedUntil) {
      runtime.mode = "OFF";
      runtime.message = "START odmietnutý: najprv klikni ARM; ARM platí 60 sekúnd.";
      render();
      return;
    }
    if (runtime.registration !== "OPEN") return stop("REGISTRATION_CLOSED — zápis sa nespustil.");
    runtime.mode = "RUNNING";
    runtime.running = true;
    render();
    while (runtime.running) {
      const result = optimizer.analyze(optimizerState());
      if (result.noAcceptableLayout) return stop("STOP: nezostal žiadny prijateľný layout (5/5 sa nepoužije). ");
      if (result.complete) return stop("HOTOVO: všetky požadované cvičenia aj prednášky sú potvrdené.");
      const batch = result.safeBatch.filter((item) => Number.isFinite(item.activity.concreteActivityId));
      if (!batch.length) return stop("STOP: ďalší bezpečný krok nemá concreteActivityId alebo nemá voľnú alternatívu.");
      runtime.message = `Posielam bezpečný batch ${batch.map((item) => `${item.subject?.short} ${item.activity.group}`).join(" + ")}…`;
      render();
      const outcomes = await Promise.all(batch.map(submitCandidate));
      const fatal = outcomes.find((outcome) => ["REGISTRATION_CLOSED", "AUTH_EXPIRED", "UNKNOWN_SERVER_ERROR"].includes(outcome.code));
      if (fatal) return stop(`${fatal.code} — ${fatal.message}`);
      if (outcomes.some((outcome) => outcome.code === "NETWORK_ERROR")) return stop("NETWORK_ERROR — po jednom kontrolovanom retry zastavujem.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  function safeLiveSnapshot() {
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      registration: runtime.registration,
      liveActivities: runtime.liveActivities.map((item) => ({
        subjectVersionScheduleCode: item.subjectVersionScheduleCode,
        concreteActivityId: item.concreteActivityId,
        concreteActivityCode: item.concreteActivityCode,
        group: item.group,
        weekDayTitle: item.weekDayTitle,
        scheduleWindowBeginTime: item.scheduleWindowBeginTime,
        concreteActivityCapacity: item.concreteActivityCapacity,
        studentsCount: item.studentsCount,
        hasFreePlaces: item.hasFreePlaces,
        hasCollision: item.hasCollision,
        selected: item.selected
      }))
    };
  }

  async function copyLiveSnapshot() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(safeLiveSnapshot()));
      runtime.message = "Bezpečný LIVE JSON skopírovaný — neobsahuje cookies, tokeny ani identitu.";
    } catch (error) {
      runtime.message = `Kopírovanie zlyhalo: ${error.message}`;
    }
    render();
  }

  async function dryRun() {
    runtime.dryRunVisible = true;
    await refreshData({ silent: true });
    runtime.dryRunResult = optimizer.analyze(optimizerState());
    runtime.message = "DRY RUN hotový. Nebol zavolaný selectConcreteActivity.";
    render();
  }

  function resetLocal() {
    stop("Lokálny stav vymazaný; serverové zápisy sa nemenia.");
    localState = defaultLocalState();
    saveLocalState();
    runtime.mode = "OFF";
    refreshData();
  }

  function metric(value) {
    return Number(value || 0).toLocaleString("sk-SK", { maximumFractionDigits: 2 });
  }

  function render() {
    if (!panel) return;
    const result = optimizer.analyze(optimizerState());
    const next = result.priorities[0];
    const capacity = next?.activity.concreteActivityCapacity == null ? "—" : `${next.activity.studentsCount ?? "?"} / ${next.activity.concreteActivityCapacity}`;
    const regClass = runtime.registration === "OPEN" ? "ok" : runtime.registration === "CLOSED" ? "bad" : "warn";
    const autoClass = runtime.mode === "RUNNING" ? "bad" : runtime.mode === "ARMED" ? "warn" : "";
    let branches = "";
    if (runtime.dryRunVisible && runtime.dryRunResult) {
      const dry = runtime.dryRunResult;
      branches = `<div class="era-dry"><strong>DRY RUN · Batch 1</strong><div>${dry.safeBatch.map((item) => `${escapeHtml(item.subject?.short)} ${escapeHtml(item.type)} ${escapeHtml(item.activity.group)}`).join(" + ") || "žiadny"}</div>${dry.batchOutcomes.map((branch) => `<small>${escapeHtml(branch.labels.join(" + "))} → ${branch.remainingCount} layoutov · mass ${metric(branch.qualityMass)}</small>`).join("")}</div>`;
    }
    panel.innerHTML = `<div class="era-head"><strong>EDISON Rozvrh Assistant</strong><button data-action="collapse" title="Minimalizovať">−</button></div>
      <div class="era-body">
        <div class="era-status"><span>● pripravený</span><span>● načítané predmety: ${runtime.loadedSubjects}/7</span><span class="${regClass}">● registrácia: ${runtime.registration.toLowerCase()}</span><span class="${autoClass}">● AUTO: ${runtime.mode}</span></div>
        <div class="era-message">${escapeHtml(runtime.message)}</div>
        <div class="era-next"><small>Ďalší odporúčaný krok</small><strong>${next ? `${escapeHtml(next.subject?.short)} · ${escapeHtml(next.type)} ${escapeHtml(next.activity.group)}` : result.complete ? "HOTOVO" : "—"}</strong><span>${next ? `${escapeHtml(window.ROZVRH_DATA.days[next.activity.day])} ${escapeHtml(window.ROZVRH_DATA.slots[next.activity.slot])} · ${escapeHtml(capacity)} · ID ${escapeHtml(next.activity.concreteActivityId ?? "—")}` : ""}</span><span>${next ? `risk ${escapeHtml(next.riskLevel)} · ${escapeHtml(next.reason)}` : ""}</span></div>
        <div class="era-metrics"><span>layouty<strong>${result.remainingCount}</strong></span><span>quality mass<strong>${metric(result.qualityMass)}</strong></span><span>best rating<strong>${result.bestRemainingRating ?? "—"}/5</strong></span><span>robust target<strong>${escapeHtml(result.targetInfo?.plan?.id || "—")}</strong></span></div>
        ${branches}
        <div class="era-actions"><button data-action="refresh">REFRESH DATA</button><button data-action="dry">DRY RUN</button><button data-action="copy">COPY LIVE JSON</button><button class="arm" data-action="arm">ARM</button><button class="start" data-action="start" ${runtime.mode !== "ARMED" ? "disabled" : ""}>START</button><button class="stop" data-action="stop">STOP</button><button data-action="reset">UNDO / RESET LOCAL STATE</button></div>
        <small class="era-foot">AUTO sa po reloade nikdy nespustí. STOP zastaví ďalšie requesty. Reset nikdy nevolá unselect endpoint.</small>
      </div>`;
  }

  function installPanel() {
    const style = document.createElement("style");
    style.textContent = `#edison-rozvrh-assistant{position:fixed;right:16px;bottom:16px;width:min(430px,calc(100vw - 24px));z-index:2147483647;background:#0b1220;color:#e5eefc;border:1px solid #334155;border-radius:14px;box-shadow:0 20px 60px #0008;font:13px/1.4 system-ui,sans-serif}#edison-rozvrh-assistant *{box-sizing:border-box}.era-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #334155}.era-head button{width:28px}.era-body{padding:12px}.era-status{display:grid;grid-template-columns:1fr 1fr;gap:4px;color:#94a3b8}.era-status .ok{color:#4ade80}.era-status .bad{color:#fb7185}.era-status .warn{color:#fbbf24}.era-message{margin:9px 0;padding:8px;background:#111c30;border-radius:8px;color:#cbd5e1}.era-next{display:flex;flex-direction:column;gap:3px;padding:10px;border:1px solid #334155;border-radius:10px}.era-next strong{font-size:17px}.era-next span{color:#a9b8cc}.era-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:8px 0}.era-metrics span{display:flex;flex-direction:column;padding:6px;background:#111c30;border-radius:7px;color:#94a3b8;font-size:10px}.era-metrics strong{color:#fff;font-size:13px}.era-actions{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.era-actions button,.era-head button{border:1px solid #475569;border-radius:7px;background:#1e293b;color:#fff;padding:7px;cursor:pointer;font-weight:700}.era-actions button:disabled{opacity:.4;cursor:not-allowed}.era-actions .arm{border-color:#fbbf24}.era-actions .start{background:#166534;border-color:#4ade80}.era-actions .stop{background:#7f1d1d;border-color:#fb7185}.era-dry{display:flex;flex-direction:column;gap:4px;margin:8px 0;padding:8px;border:1px solid #38bdf8;border-radius:8px}.era-foot{display:block;margin-top:8px;color:#94a3b8}#edison-rozvrh-assistant.collapsed .era-body{display:none}`;
    document.head.appendChild(style);
    panel = document.createElement("aside");
    panel.id = "edison-rozvrh-assistant";
    panel.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "collapse") panel.classList.toggle("collapsed");
      if (action === "refresh") refreshData();
      if (action === "dry") dryRun();
      if (action === "copy") copyLiveSnapshot();
      if (action === "arm") arm();
      if (action === "start") start();
      if (action === "stop") stop();
      if (action === "reset") resetLocal();
    });
    document.body.appendChild(panel);
    render();
  }

  installPanel();
  refreshData();
})();
