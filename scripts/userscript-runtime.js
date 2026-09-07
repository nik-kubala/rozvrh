(() => {
  "use strict";

  const PORTLET_BASE = "/wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection";
  const PORTLET_FALLBACK = "ns_Z7_SHD09B1A084V90ITII3I3Q30P7_";
  const OPEN_AT = new Date("2026-09-08T10:00:00+02:00").getTime();
  const PREFLIGHT_LEAD_MS = 10_000;
  const FRESH_FOR_START_MS = 30_000;
  const BOUNDARY_RETRY_UNTIL_MS = 6_000;
  const BOUNDARY_RETRY_DELAY_MS = 350;
  const BOUNDARY_RETRY_LIMIT = 6;
  const core = window.ROZVRH_OPTIMIZER;

  // Current-semester fallback only. Dynamic DOM discovery is preferred; every
  // fallback mapping is validated against the returned subject data before use.
  const KNOWN_OBLIGATIONS = new Map([
    ["440210401", 7860483], // ZDS
    ["460205103", 7860492], // ULM
    ["460205205", 7860487], // UPR
    ["460207901", 7860488], // ZIT
    ["470220501", 7860490], // LA
    ["711043901", 7860499], // PvICT
    ["712012401", 7860493]  // A/I-FEI
  ]);

  if (!core || !window.ROZVRH_DATA || !window.ROZVRH_FIXED_PLANS || !window.ROZVRH_PREFERENCES) {
    console.error("EDISON Rozvrh Assistant: bundled optimizer data are missing.");
    return;
  }

  const optimizer = core.createOptimizer({
    data: window.ROZVRH_DATA,
    fixedPlans: window.ROZVRH_FIXED_PLANS,
    preferences: window.ROZVRH_PREFERENCES
  });

  const runtime = {
    mode: "LOADING",
    registration: "UNKNOWN",
    obligations: new Map(),
    liveActivities: [],
    loadedSubjects: 0,
    message: "Načítavam EDISON dáta…",
    abortControllers: new Set(),
    running: false,
    loadingPromise: null,
    lastLoadedAt: 0,
    history: [],
    preflightTimer: null,
    startTimer: null,
    everStarted: false
  };

  let localState = { locked: {}, unavailable: [] };
  let panel;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function portletId() {
    const exact = document.querySelector('[id$=":subjectsTable"]');
    if (exact?.id) return exact.id.replace(/:subjectsTable$/, "");

    const loose = document.querySelector('[id*="subjectsTable"]');
    if (loose?.id) return loose.id.replace(/:subjectsTable.*$/, "");

    const hidden = document.querySelector('input[name="portletId"]');
    if (hidden?.value) return hidden.value;

    // Try to derive the namespace from any element close to the schedule portlet.
    const scheduleLink = document.querySelector('[onclick*="selectStudyYearObligation"]');
    let node = scheduleLink;
    for (let i = 0; node && i < 7; i += 1, node = node.parentElement) {
      const ownId = node.id || "";
      const match = ownId.match(/^(ns_Z7_[A-Z0-9]+_?)(?::|$)/i);
      if (match) return match[1].endsWith("_") ? match[1] : `${match[1]}_`;
      const child = node.querySelector?.('[id^="ns_Z7_"]');
      const childMatch = child?.id?.match(/^(ns_Z7_[A-Z0-9]+_?)(?::|$)/i);
      if (childMatch) return childMatch[1].endsWith("_") ? childMatch[1] : `${childMatch[1]}_`;
    }

    // This is the exact portlet namespace observed for the VŠB schedule-selection
    // portlet. Keeping it as a final fallback avoids a false PAGE_NOT_READY when
    // EDISON renders the subject list lazily.
    return PORTLET_FALLBACK;
  }

  function courseCodeNear(element) {
    let node = element;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const titles = Array.from(node.querySelectorAll?.("abbr[title]") || [])
        .map((item) => item.getAttribute("title") || "")
        .join(" ");
      const text = `${titles} ${node.textContent || ""}`;
      const match = text.match(/\d{3}-\d{4}\/\d{2}/);
      if (match) return match[0].replace(/\D/g, "");
    }
    return "";
  }

  function discoverObligations() {
    const found = new Map();

    // Do not depend on a specific table id. EDISON can render the portlet after
    // document-idle or wrap it differently; the action links are the stable part.
    for (const link of document.querySelectorAll('[onclick*="selectStudyYearObligation"]')) {
      const onclick = link.getAttribute("onclick") || "";
      const id = Number(
        onclick.match(/selectStudyYearObligation\s*\(\s*(\d+)\s*\)/)?.[1]
        || onclick.match(/\((\d+)\)/)?.[1]
      );
      const code = courseCodeNear(link);
      if (code && Number.isFinite(id)) found.set(code, id);
    }

    // Current-semester validated fallback. This makes the script usable even when
    // the list is not yet present in the DOM, which is exactly what caused the
    // PAGE_NOT_READY screenshot.
    for (const [code, id] of KNOWN_OBLIGATIONS) {
      if (!found.has(code)) found.set(code, id);
    }

    runtime.obligations = found;
    return found;
  }

  async function requestJson(method, path, { allowNetworkRetry = false } = {}) {
    const id = portletId();
    if (!id) throw Object.assign(new Error("Portlet ID nebol nájdený."), { code: "PAGE_NOT_READY" });

    const url = method === "GET"
      ? `${PORTLET_BASE}/${path}?${new URLSearchParams({ portletId: id, _: Date.now() })}`
      : `${PORTLET_BASE}/${path}`;

    const controller = new AbortController();
    runtime.abortControllers.add(controller);

    try {
      const headers = {
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest"
      };
      if (method === "PUT") headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";

      const response = await fetch(url, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: method === "PUT" ? new URLSearchParams({ portletId: id }) : undefined,
        signal: controller.signal,
        redirect: "follow"
      });

      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error(`EDISON vrátil HTTP ${response.status}.`), { code: "AUTH_EXPIRED", status: response.status });
      }

      const contentType = response.headers.get("content-type") || "";
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        const folded = text.toLowerCase();
        const looksLikeLogin = /<html|<form|login|prihl|přihl|sso|ltpatoken/.test(folded);
        const code = looksLikeLogin ? "AUTH_EXPIRED" : "UNKNOWN_SERVER_ERROR";
        throw Object.assign(new Error(`${code}: EDISON nevrátil JSON. ${text.slice(0, 180).replace(/\s+/g, " ")}`), {
          code,
          status: response.status,
          contentType
        });
      }

      return { payload, status: response.status, contentType, redirected: response.redirected };
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(error, { code: "STOPPED" });
      if (error.code) throw error;
      if (allowNetworkRetry) {
        await sleep(500);
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

  function normalizedDtos(payload) {
    return core.extractActivityDtos(payload)
      .map(optimizer.normalizeActivity)
      .filter((item) => item.subjectId && item.localSessionId && Number.isFinite(item.concreteActivityId));
  }

  function mergeActivities(payload) {
    const incoming = normalizedDtos(payload);
    const merged = new Map(runtime.liveActivities.map((item) => [item.localSessionId, item]));
    incoming.forEach((item) => merged.set(item.localSessionId, item));
    runtime.liveActivities = [...merged.values()];
  }

  function reconcileServerSelections() {
    const nextLocked = {};
    for (const activity of runtime.liveActivities.filter((item) => item.selected === true)) {
      if (activity.type === "C") {
        nextLocked[activity.subjectId] = activity.concreteActivityId;
      } else {
        const requirement = (window.ROZVRH_PREFERENCES.lectureRequirements || [])
          .find((item) => item.alternatives.includes(activity.localSessionId));
        if (requirement) nextLocked[requirement.key] = activity.concreteActivityId;
      }
    }
    localState.locked = nextLocked;
  }

  function optimizerState() {
    const unavailable = new Set(localState.unavailable.map(String));
    for (const activity of runtime.liveActivities) {
      if (activity.selected) continue;
      if (activity.hasCollision === true || activity.hasFreePlaces === false) {
        unavailable.add(String(activity.concreteActivityId));
        unavailable.add(String(activity.localSessionId));
      }
    }
    return {
      locked: { ...localState.locked },
      unavailable: [...unavailable],
      liveActivities: runtime.liveActivities
    };
  }

  async function loadAllSubjects({ resetFailures = true, label = "Načítavam 7 predmetov…" } = {}) {
    if (runtime.loadingPromise) return runtime.loadingPromise;
    if (runtime.running) return;

    const preserveWaiting = runtime.mode === "WAITING";
    if (!preserveWaiting) runtime.mode = "LOADING";
    runtime.message = label;
    runtime.loadedSubjects = 0;
    render();

    runtime.loadingPromise = (async () => {
      try {
        const obligations = discoverObligations();
        const subjects = window.ROZVRH_DATA.subjects
          .filter((subject) => window.ROZVRH_FIXED_PLANS.subjects.includes(subject.id));
        const missing = subjects.filter((subject) => !obligations.has(String(subject.code)));
        if (missing.length) {
          throw Object.assign(new Error(`Chýba EDISON mapping: ${missing.map((item) => item.short).join(", ")}`), { code: "MAPPING_ERROR" });
        }

        const responses = await mapLimit(subjects, 2, async (subject) => {
          const obligationId = obligations.get(String(subject.code));
          const response = await requestJson("PUT", `selectStudyYearObligation/${obligationId}`);
          const activities = normalizedDtos(response.payload).filter((activity) => activity.subjectId === subject.id);
          if (!activities.length) {
            throw Object.assign(
              new Error(`EDISON obligation ${obligationId} nevrátil očakávaný predmet ${subject.short}.`),
              { code: "MAPPING_ERROR" }
            );
          }
          runtime.loadedSubjects += 1;
          render();
          return { subject, activities };
        });

        // Authoritative full snapshot: no stale IDs or capacities survive a refresh.
        const fresh = new Map();
        for (const { activities } of responses) {
          for (const activity of activities) fresh.set(activity.localSessionId, activity);
        }
        runtime.liveActivities = [...fresh.values()];

        const missingExercises = subjects.filter((subject) =>
          !runtime.liveActivities.some((activity) => activity.subjectId === subject.id && activity.type === "C"));
        if (missingExercises.length) {
          throw Object.assign(new Error(`Nenamapovali sa cvičenia: ${missingExercises.map((item) => item.short).join(", ")}`), { code: "MAPPING_ERROR" });
        }

        const missingLectures = (window.ROZVRH_PREFERENCES.lectureRequirements || []).filter((requirement) =>
          !(requirement.alternatives || []).some((id) => runtime.liveActivities.some((activity) => activity.localSessionId === id)));
        if (missingLectures.length) {
          throw Object.assign(new Error(`Nenamapovali sa prednášky: ${missingLectures.map((item) => item.key).join(", ")}`), { code: "MAPPING_ERROR" });
        }

        reconcileServerSelections();
        if (resetFailures) localState.unavailable = [];
        runtime.loadedSubjects = subjects.length;
        runtime.lastLoadedAt = Date.now();
        if (!preserveWaiting) runtime.mode = "READY";
        runtime.message = preserveWaiting
          ? `Predštartové LIVE dáta sú čerstvé: 7/7. Čakám na 10:00 — nič neklikaj.`
          : `Pripravené: 7/7 predmetov · ${runtime.liveActivities.length} LIVE jednotiek.`;
      } catch (error) {
        runtime.loadedSubjects = 0;
        if (!preserveWaiting) runtime.mode = "ERROR";
        runtime.message = `${error.code || "CHYBA"}: ${error.message}`;
        throw error;
      } finally {
        runtime.loadingPromise = null;
        render();
      }
    })();

    return runtime.loadingPromise;
  }

  function stop(message = "STOP — ďalšie zápisové requesty sú zastavené.") {
    runtime.abortControllers.forEach((controller) => controller.abort());
    runtime.abortControllers.clear();
    if (runtime.startTimer) clearTimeout(runtime.startTimer);
    runtime.startTimer = null;
    runtime.running = false;
    runtime.mode = "STOPPED";
    runtime.message = message;
    render();
  }

  function exercisePassedCount() {
    return window.ROZVRH_FIXED_PLANS.subjects.filter((id) => Boolean(localState.locked[id])).length;
  }

  function lecturePassedCount() {
    return (window.ROZVRH_PREFERENCES.lectureRequirements || [])
      .filter((item) => Boolean(localState.locked[item.key])).length;
  }

  async function selectOnce(candidate) {
    const activityId = Number(candidate.activity.concreteActivityId);
    if (!Number.isFinite(activityId)) {
      return { ok: false, code: "UNKNOWN_SERVER_ERROR", message: "Chýba concreteActivityId." };
    }

    try {
      const response = await requestJson("PUT", `selectConcreteActivity/${activityId}`, { allowNetworkRetry: true });
      mergeActivities(response.payload);
      const outcome = core.classifyActivityResponse({ ...response, activityId });
      if (outcome.ok) runtime.registration = "OPEN";
      else if (outcome.code === "REGISTRATION_CLOSED") runtime.registration = "CLOSED";
      return outcome;
    } catch (error) {
      return { ok: false, code: error.code || "NETWORK_ERROR", message: error.message };
    }
  }

  async function submitCandidate(candidate) {
    const activityId = Number(candidate.activity.concreteActivityId);
    let outcome = null;

    for (let attempt = 0; attempt <= BOUNDARY_RETRY_LIMIT; attempt += 1) {
      outcome = await selectOnce(candidate);
      const insideOpenBoundary = Date.now() >= OPEN_AT - 1_000 && Date.now() <= OPEN_AT + BOUNDARY_RETRY_UNTIL_MS;
      if (outcome.code !== "REGISTRATION_CLOSED" || !insideOpenBoundary || attempt >= BOUNDARY_RETRY_LIMIT) break;
      runtime.message = `EDISON ešte hlási zatvorené — opakujem ${candidate.subject?.short || candidate.subjectId} o ${BOUNDARY_RETRY_DELAY_MS} ms…`;
      render();
      await sleep(BOUNDARY_RETRY_DELAY_MS);
    }

    if (outcome.ok) {
      localState.locked[candidate.requirementKey] = activityId;
    } else if (["FULL", "COLLISION"].includes(outcome.code)) {
      if (!localState.unavailable.map(String).includes(String(activityId))) localState.unavailable.push(activityId);
    }

    runtime.history.push({
      at: Date.now(),
      result: outcome.code,
      subjectId: candidate.subjectId,
      group: candidate.activity.group,
      concreteActivityId: activityId
    });

    runtime.message = `${candidate.subject?.short || candidate.subjectId} ${candidate.activity.group}: ${outcome.code}`;
    render();
    return outcome;
  }

  async function runRegistration() {
    runtime.mode = "RUNNING";
    runtime.running = true;
    runtime.everStarted = true;
    runtime.message = "ZÁPIS BEŽÍ — nič neklikaj. Fallbacky prepočítavam po každej odpovedi.";
    render();

    while (runtime.running) {
      const result = optimizer.analyze(optimizerState());

      if (result.noAcceptableLayout) {
        return stop("STOP: nezostal žiadny z tvojich prijateľných hodnotených rozvrhov. Rating 5/5 nepoužijem.");
      }
      if (result.complete) {
        runtime.running = false;
        runtime.mode = "DONE";
        runtime.message = `HOTOVO — cvičenia ${exercisePassedCount()}/7 PASSED, prednášky ${lecturePassedCount()}/${(window.ROZVRH_PREFERENCES.lectureRequirements || []).length} PASSED.`;
        render();
        return;
      }

      const batch = result.safeBatch
        .filter((item) => Number.isFinite(Number(item.activity.concreteActivityId)))
        .slice(0, 2);
      if (!batch.length) {
        return stop("STOP: optimizer nemá bezpečný ďalší LIVE termín s concreteActivityId.");
      }

      runtime.message = `Zapisujem: ${batch.map((item) => `${item.subject?.short} ${item.activity.group}`).join(" + ")}…`;
      render();
      const outcomes = await Promise.all(batch.map(submitCandidate));

      const fatal = outcomes.find((outcome) => [
        "REGISTRATION_CLOSED",
        "AUTH_EXPIRED",
        "UNKNOWN_SERVER_ERROR",
        "PAGE_NOT_READY",
        "MAPPING_ERROR"
      ].includes(outcome.code));
      if (fatal) return stop(`${fatal.code} — ${fatal.message}`);
      if (outcomes.some((outcome) => outcome.code === "NETWORK_ERROR")) {
        return stop("NETWORK_ERROR — po jednom kontrolovanom retry zastavujem, aby som neposlal duplicitné zápisy.");
      }

      await sleep(20);
    }
  }

  async function ensureFreshThenRun() {
    try {
      if (runtime.loadingPromise) await runtime.loadingPromise;
      const stale = Date.now() - runtime.lastLoadedAt > FRESH_FOR_START_MS;
      if (runtime.loadedSubjects !== 7 || stale) {
        await loadAllSubjects({ resetFailures: true, label: "Posledná LIVE kontrola 7/7 pred zápisom…" });
      }
      if (runtime.loadedSubjects !== 7) {
        throw Object.assign(new Error("Nemám načítaných 7/7 predmetov."), { code: "MAPPING_ERROR" });
      }
      await runRegistration();
    } catch (error) {
      runtime.running = false;
      runtime.mode = "ERROR";
      runtime.message = `${error.code || "CHYBA"}: ${error.message}`;
      render();
    }
  }

  async function start() {
    // One click means one start. Once waiting/running, the main control is disabled
    // and can never accidentally toggle into STOP from the same user action.
    if (runtime.running || runtime.mode === "WAITING" || runtime.mode === "RUNNING" || runtime.mode === "DONE") return;

    try {
      if (runtime.loadingPromise) await runtime.loadingPromise;
      const stale = Date.now() - runtime.lastLoadedAt > FRESH_FOR_START_MS;
      if (runtime.loadedSubjects !== 7 || stale) {
        await loadAllSubjects({ resetFailures: true, label: "Predštartová kontrola 7/7 predmetov…" });
      }
      if (runtime.loadedSubjects !== 7) {
        throw Object.assign(new Error("Nemám načítaných 7/7 predmetov."), { code: "MAPPING_ERROR" });
      }

      if (Date.now() < OPEN_AT) {
        runtime.mode = "WAITING";
        runtime.message = "START prijatý. O 10:00 sa zápis spustí sám. Už nič neklikaj.";
        render();
        runtime.startTimer = setTimeout(async () => {
          runtime.startTimer = null;
          if (runtime.mode !== "WAITING") return;
          await ensureFreshThenRun();
        }, Math.max(0, OPEN_AT - Date.now()));
        return;
      }

      await ensureFreshThenRun();
    } catch (error) {
      runtime.running = false;
      runtime.mode = "ERROR";
      runtime.message = `${error.code || "CHYBA"}: ${error.message}`;
      render();
    }
  }

  function formatTimeUntilOpen() {
    const diff = OPEN_AT - Date.now();
    if (diff <= 0) return "otvorenie 10:00 dosiahnuté";
    const total = Math.ceil(diff / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `do 10:00: ${h ? `${h}h ` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function render() {
    if (!panel) return;
    const result = optimizer.analyze(optimizerState());
    const next = result.priorities[0];
    const cPassed = exercisePassedCount();
    const pTotal = (window.ROZVRH_PREFERENCES.lectureRequirements || []).length;
    const pPassed = lecturePassedCount();
    const capacity = next?.activity.concreteActivityCapacity == null
      ? "—"
      : `${next.activity.studentsCount ?? "?"}/${next.activity.concreteActivityCapacity}`;

    let buttonLabel = "ŠTART ZÁPIS";
    let buttonClass = "start";
    let buttonDisabled = runtime.mode === "LOADING";
    if (runtime.mode === "WAITING") {
      buttonLabel = "ČAKÁM NA 10:00 — SPUSTÍ SA SÁM";
      buttonClass = "waiting";
      buttonDisabled = true;
    } else if (runtime.mode === "RUNNING") {
      buttonLabel = "ZÁPIS BEŽÍ — NIČ NEKLIKAJ";
      buttonClass = "running";
      buttonDisabled = true;
    } else if (runtime.mode === "DONE") {
      buttonLabel = "HOTOVO ✓";
      buttonClass = "done";
      buttonDisabled = true;
    }

    const exerciseClass = cPassed === 7 ? "passed" : "";
    const lectureClass = pPassed === pTotal ? "passed" : "";
    const lastLoaded = runtime.lastLoadedAt ? new Date(runtime.lastLoadedAt).toLocaleTimeString("sk-SK") : "—";

    panel.innerHTML = `<div class="era-head"><strong>EDISON Rozvrh Assistant</strong><span>${escapeHtml(formatTimeUntilOpen())}</span></div>
      <div class="era-body">
        <div class="era-message">${escapeHtml(runtime.message)}</div>
        <div class="era-progress">
          <div class="${exerciseClass}"><span>Cvičenia</span><strong>${cPassed}/7 ${cPassed === 7 ? "PASSED ✓" : ""}</strong></div>
          <div class="${lectureClass}"><span>Prednášky</span><strong>${pPassed}/${pTotal} ${pPassed === pTotal ? "PASSED ✓" : ""}</strong></div>
        </div>
        <div class="era-status"><span>LIVE dáta <strong>${runtime.loadedSubjects}/7</strong></span><span>načítané <strong>${escapeHtml(lastLoaded)}</strong></span><span>layouty <strong>${result.remainingCount}</strong></span><span>best <strong>${result.bestRemainingRating ?? "—"}/5</strong></span></div>
        <div class="era-next"><small>Aktuálne by išiel ako ďalší</small><strong>${next ? `${escapeHtml(next.subject?.short)} · ${escapeHtml(next.type)} ${escapeHtml(next.activity.group)}` : result.complete ? "HOTOVO" : "—"}</strong><span>${next ? `${escapeHtml(window.ROZVRH_DATA.days[next.activity.day])} ${escapeHtml(window.ROZVRH_DATA.slots[next.activity.slot])} · kapacita ${escapeHtml(capacity)} · risk ${escapeHtml(next.riskLevel)}` : ""}</span><small>${next ? escapeHtml(next.reason) : ""}</small></div>
        <button class="era-main ${buttonClass}" data-action="main" ${buttonDisabled ? "disabled" : ""}>${escapeHtml(buttonLabel)}</button>
        <small class="era-foot">EDISON tlačidlo „Obnovit“ nemusíš klikať. Assistant si LIVE dáta načíta sám a 10 s pred 10:00 ich automaticky obnoví. START stlač iba raz.</small>
      </div>`;
  }

  function installPanel() {
    const style = document.createElement("style");
    style.textContent = `#edison-rozvrh-assistant{position:fixed;right:16px;bottom:16px;width:min(440px,calc(100vw - 24px));z-index:2147483647;background:#0b1220;color:#e5eefc;border:1px solid #334155;border-radius:14px;box-shadow:0 20px 60px #0009;font:13px/1.4 system-ui,sans-serif}#edison-rozvrh-assistant *{box-sizing:border-box}.era-head{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:11px 13px;border-bottom:1px solid #334155}.era-head span{color:#93c5fd;font-size:11px}.era-body{padding:12px}.era-message{margin-bottom:9px;padding:9px;background:#111c30;border-radius:8px;color:#dbeafe}.era-progress{display:grid;grid-template-columns:1fr 1fr;gap:7px}.era-progress>div{display:flex;flex-direction:column;padding:10px;background:#111827;border:1px solid #334155;border-radius:9px}.era-progress span{color:#94a3b8;font-size:11px}.era-progress strong{font-size:17px}.era-progress .passed{background:#052e1b;border-color:#22c55e}.era-progress .passed strong{color:#86efac}.era-status{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:8px 0}.era-status span{display:flex;flex-direction:column;padding:6px;background:#111c30;border-radius:7px;color:#94a3b8;font-size:10px}.era-status strong{color:#fff;font-size:12px}.era-next{display:flex;flex-direction:column;gap:3px;padding:10px;border:1px solid #334155;border-radius:10px}.era-next strong{font-size:16px}.era-next span,.era-next small{color:#a9b8cc}.era-main{width:100%;margin-top:10px;padding:13px;border-radius:9px;border:1px solid #4ade80;background:#166534;color:#fff;font-weight:900;font-size:16px;cursor:pointer}.era-main.waiting{background:#1d4ed8;border-color:#60a5fa}.era-main.running{background:#7c3aed;border-color:#c4b5fd}.era-main.done{background:#14532d;border-color:#86efac}.era-main:disabled{opacity:.85;cursor:default}.era-foot{display:block;margin-top:8px;color:#94a3b8}`;
    document.head.appendChild(style);
    panel = document.createElement("aside");
    panel.id = "edison-rozvrh-assistant";
    panel.addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="main"]');
      if (button && !button.disabled) start();
    });
    document.body.appendChild(panel);
    render();
  }

  function scheduleAutomaticPreflight() {
    if (runtime.preflightTimer) clearTimeout(runtime.preflightTimer);
    const delay = OPEN_AT - Date.now() - PREFLIGHT_LEAD_MS;
    if (delay <= 0) return;
    runtime.preflightTimer = setTimeout(async () => {
      runtime.preflightTimer = null;
      if (runtime.running) return;
      try {
        await loadAllSubjects({ resetFailures: true, label: "Automatická predštartová LIVE kontrola 09:59:50…" });
      } catch {
        // If this fails, the 10:00 start path performs one final fresh load too.
      }
    }, delay);
  }

  async function initialLoad() {
    try {
      await loadAllSubjects({ resetFailures: true, label: "Úvodná read-only kontrola 7/7 predmetov…" });
    } catch (firstError) {
      // EDISON often renders portal fragments lazily. One delayed retry catches that
      // without requiring the user to click the page's own refresh button.
      await sleep(1200);
      try {
        await loadAllSubjects({ resetFailures: true, label: "Opakujem načítanie EDISON dát…" });
      } catch {
        // The panel already contains the concrete error. START retries once more.
      }
    }
  }

  installPanel();
  initialLoad();
  scheduleAutomaticPreflight();
  setInterval(render, 1000);
})();