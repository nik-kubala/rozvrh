(() => {
  "use strict";

  const OPEN_AT = new Date("2026-09-08T10:00:00+02:00").getTime();
  const CLOSED_RETRY_UNTIL = OPEN_AT + 10_000;
  const CLOSED_RETRY_DELAY_MS = 350;
  const nativeFetch = window.fetch.bind(window);
  const core = window.ROZVRH_OPTIMIZER;

  function isConcreteActivityPut(input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    return method === "PUT" && /\/scheduleSelection\/selectConcreteActivity\/\d+(?:[?#]|$)/.test(url);
  }

  async function classifyClosed(response) {
    try {
      const payload = JSON.parse(await response.clone().text());
      if (core?.classifyActivityResponse) {
        return core.classifyActivityResponse({ payload, status: response.status }).code === "REGISTRATION_CLOSED";
      }
      const text = String(payload?.errMsg || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return /selection of schedule is not open|schedule selection is not open|volba rozvrhu.*(nyni )?(neni|není).*otevren|volba rozvrhu.*uzavren/.test(text);
    } catch {
      return false;
    }
  }

  window.fetch = async function edisonOpeningGateFetch(input, init) {
    if (!isConcreteActivityPut(input, init)) return nativeFetch(input, init);

    let response = await nativeFetch(input, init);
    while (
      Date.now() >= OPEN_AT - 1_000 &&
      Date.now() < CLOSED_RETRY_UNTIL &&
      await classifyClosed(response)
    ) {
      await new Promise((resolve) => setTimeout(resolve, CLOSED_RETRY_DELAY_MS));
      response = await nativeFetch(input, init);
    }
    return response;
  };
})();
