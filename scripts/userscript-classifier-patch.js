(() => {
  "use strict";

  // Tampermonkey can expose globalThis through a userscript wrapper even with
  // @grant none. The runtime itself reads window.ROZVRH_OPTIMIZER, so patch
  // that exact object first to guarantee both the real registration flow and
  // the API test see the same classifier.
  const core = window.ROZVRH_OPTIMIZER || globalThis.ROZVRH_OPTIMIZER;
  if (!core || typeof core.classifyActivityResponse !== "function" || core.__edisonEnglishClassifierPatch) return;

  const original = core.classifyActivityResponse.bind(core);
  const fold = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  core.classifyActivityResponse = function classifyActivityResponsePatched(args = {}) {
    const result = original(args);
    if (!result || result.code !== "UNKNOWN_SERVER_ERROR") return result;

    const errMsg = String(args?.payload?.errMsg || result.message || "").trim();
    const text = fold(errMsg);
    if (!text) return result;

    if (
      /selection of schedule is not open/.test(text) ||
      /schedule selection is not open/.test(text) ||
      /schedule.*not open.*current study relation/.test(text) ||
      /cannot be entered.*selection of schedule.*not open/.test(text) ||
      /registration.*not open/.test(text) ||
      /registration.*closed/.test(text)
    ) {
      return { ok: false, code: "REGISTRATION_CLOSED", message: errMsg };
    }

    if (
      /no free (place|places|seat|seats)/.test(text) ||
      /capacity.*(full|reached|exhausted)/.test(text) ||
      /(schedule unit|activity).*(full|occupied)/.test(text) ||
      /cannot be entered.*capacity/.test(text)
    ) {
      return { ok: false, code: "FULL", message: errMsg };
    }

    if (
      /collision/.test(text) ||
      /conflict/.test(text) ||
      /overlap/.test(text)
    ) {
      return { ok: false, code: "COLLISION", message: errMsg };
    }

    if (
      /not authenticated/.test(text) ||
      /authentication.*(expired|required|failed)/.test(text) ||
      /session.*expired/.test(text) ||
      /not logged in/.test(text) ||
      /please log in/.test(text)
    ) {
      return { ok: false, code: "AUTH_EXPIRED", message: errMsg };
    }

    return result;
  };

  core.__edisonEnglishClassifierPatch = true;
})();
