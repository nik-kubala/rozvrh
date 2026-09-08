(() => {
  "use strict";

  const PORTLET_BASE = "/wps/.cz.vsb.edison.edu.study.pass.portlet/jaxrs/scheduleSelection";
  const PORTLET_FALLBACK = "ns_Z7_SHD09B1A084V90ITII3I3Q30P7_";
  const OPEN_AT = new Date("2026-09-08T10:00:00+02:00").getTime();
  const TEST_CUTOFF_MS = 2 * 60 * 60 * 1000;
  const OBLIGATIONS = new Map([
    ["440210401", 7860483],
    ["460205103", 7860492],
    ["460205205", 7860487],
    ["460207901", 7860488],
    ["470220501", 7860490],
    ["711043901", 7860499],
    ["712012401", 7860493]
  ]);

  const core = window.ROZVRH_OPTIMIZER;
  if (!core || !window.ROZVRH_DATA || !window.ROZVRH_FIXED_PLANS || !window.ROZVRH_PREFERENCES) return;

  const optimizer = core.createOptimizer({
    data: window.ROZVRH_DATA,
    fixedPlans: window.ROZVRH_FIXED_PLANS,
    preferences: window.ROZVRH_PREFERENCES
  });

  const testState = {
    running: false,
    label: "TEST API",
    detail: "Načíta 7/7 predmetov a pošle 1 bezpečný selectConcreteActivity probe na termín bez voľnej kapacity.",
    status: "idle"
  };

  function portletId() {
    const exact = document.querySelector('[id$=":subjectsTable"]');
    if (exact?.id) return exact.id.replace(/:subjectsTable$/, "");
    const hidden = document.querySelector('input[name="portletId"]');
    if (hidden?.value) return hidden.value;
    return PORTLET_FALLBACK;
  }

  async function requestJson(path) {
    const response = await fetch(`${PORTLET_BASE}/${path}`, {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: new URLSearchParams({ portletId: portletId() }),
      redirect: "follow"
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`EDISON nevrátil JSON (HTTP ${response.status}).`);
    }
    return { payload, status: response.status, contentType: response.headers.get("content-type") || "" };
  }

  async function runApiTest() {
    if (testState.running) return;
    if (Date.now() >= OPEN_AT - TEST_CUTOFF_MS) {
      testState.status = "blocked";
      testState.label = "TEST ZABLOKOVANÝ";
      testState.detail = "Bezpečnostná poistka: write-probe sa nepovoľuje posledné 2 hodiny pred 10:00.";
      inject();
      return;
    }

    testState.running = true;
    testState.status = "running";
    testState.label = "TESTUJEM…";
    testState.detail = "Kontrolujem 7 load requestov…";
    inject();

    try {
      const subjects = window.ROZVRH_DATA.subjects
        .filter((subject) => window.ROZVRH_FIXED_PLANS.subjects.includes(subject.id));
      const liveActivities = [];

      for (const subject of subjects) {
        const obligationId = OBLIGATIONS.get(String(subject.code));
        if (!obligationId) throw new Error(`Chýba obligation mapping pre ${subject.short}.`);
        const response = await requestJson(`selectStudyYearObligation/${obligationId}`);
        const activities = core.extractActivityDtos(response.payload)
          .map(optimizer.normalizeActivity)
          .filter((activity) => activity.subjectId === subject.id && Number.isFinite(activity.concreteActivityId));
        if (!activities.length) throw new Error(`${subject.short}: response neobsahuje očakávané activity.`);
        liveActivities.push(...activities);
        testState.detail = `Load PASS ${subjects.indexOf(subject) + 1}/7 · ${subject.short}`;
        inject();
      }

      const safeProbe = liveActivities.find((activity) =>
        activity.selected !== true &&
        Number.isFinite(activity.concreteActivityId) &&
        (activity.hasFreePlaces === false ||
          Number(activity.concreteActivityCapacity) === 0 ||
          (Number.isFinite(Number(activity.concreteActivityCapacity)) &&
           Number.isFinite(Number(activity.studentsCount)) &&
           Number(activity.studentsCount) >= Number(activity.concreteActivityCapacity)))
      );

      if (!safeProbe) {
        testState.status = "partial";
        testState.label = "READ TEST 7/7 PASS ✓";
        testState.detail = "Všetkých 7 predmetov sa načítalo správne. Write-probe som zámerne neposlal, lebo neexistuje garantovane nezapísateľná activity.";
        return;
      }

      testState.detail = `7/7 load PASS · skúšam bezpečný write-probe ${safeProbe.group} #${safeProbe.concreteActivityId}…`;
      inject();

      const response = await requestJson(`selectConcreteActivity/${safeProbe.concreteActivityId}`);
      const outcome = core.classifyActivityResponse({ ...response, activityId: safeProbe.concreteActivityId });

      if (outcome.code === "SUCCESS") {
        testState.status = "danger";
        testState.label = "STOP — PROBE SA ZAPÍSAL";
        testState.detail = `EDISON neočakávane povolil activity ${safeProbe.group} #${safeProbe.concreteActivityId}. Neopakuj test.`;
        return;
      }

      if (["REGISTRATION_CLOSED", "FULL", "COLLISION"].includes(outcome.code)) {
        testState.status = "passed";
        testState.label = "API TEST PASS ✓";
        testState.detail = `7/7 load requestov OK + selectConcreteActivity endpoint OK. Probe ${safeProbe.group} #${safeProbe.concreteActivityId} vrátil ${outcome.code}.`;
        return;
      }

      throw new Error(`Write-probe vrátil ${outcome.code}: ${outcome.message}`);
    } catch (error) {
      testState.status = "failed";
      testState.label = "API TEST FAIL";
      testState.detail = error.message || String(error);
    } finally {
      testState.running = false;
      inject();
    }
  }

  function inject() {
    const panel = document.getElementById("edison-rozvrh-assistant");
    if (!panel) return;
    const main = panel.querySelector('[data-action="main"]');
    if (!main) return;

    let box = panel.querySelector(".era-api-test-box");
    if (!box) {
      box = document.createElement("div");
      box.className = "era-api-test-box";
      main.insertAdjacentElement("afterend", box);
    }

    const disabled = testState.running || Date.now() >= OPEN_AT - TEST_CUTOFF_MS;
    const statusClass = `era-api-${testState.status}`;
    const signature = JSON.stringify([
      testState.label,
      testState.detail,
      statusClass,
      disabled
    ]);

    // The main panel is re-rendered once per second. Rebuild this small box only
    // when it was recreated or its visible state changed. Never observe our own
    // DOM mutations: that caused a MutationObserver feedback loop in v2.2.0.
    if (box.dataset.signature === signature) return;
    box.dataset.signature = signature;
    box.innerHTML = `<button type="button" class="era-api-test ${statusClass}" ${disabled ? "disabled" : ""}>${testState.label}</button><small>${testState.detail}</small>`;
    const button = box.querySelector("button");
    if (button && !button.disabled) button.addEventListener("click", runApiTest, { once: true });
  }

  const style = document.createElement("style");
  style.textContent = `.era-api-test-box{display:flex;flex-direction:column;gap:5px;margin-top:8px}.era-api-test{width:100%;padding:9px 10px;border-radius:8px;border:1px solid #64748b;background:#1e293b;color:#e2e8f0;font-weight:800;cursor:pointer}.era-api-test:disabled{opacity:.65;cursor:default}.era-api-passed{background:#14532d;border-color:#4ade80}.era-api-failed,.era-api-danger{background:#7f1d1d;border-color:#fb7185}.era-api-partial{background:#854d0e;border-color:#facc15}.era-api-test-box small{color:#94a3b8}`;
  document.head.appendChild(style);

  // Poll lightly because the main runtime replaces its panel markup every second.
  // A MutationObserver is intentionally NOT used here: changing the injected box
  // from inside the observer retriggered it indefinitely and could freeze EDISON.
  const injectTimer = setInterval(inject, 250);
  window.addEventListener("beforeunload", () => clearInterval(injectTimer), { once: true });
  inject();
})();