(() => {
  "use strict";

  const data = window.ROZVRH_DATA;
  if (!data) return;

  const byName = new Map();
  const byShort = new Map();

  function formatCode(raw) {
    const code = String(raw || "").replace(/\D/g, "");
    if (code.length === 9) return `${code.slice(0, 3)}-${code.slice(3, 7)}/${code.slice(7)}`;
    return String(raw || "");
  }

  for (const subject of data.subjects || []) {
    const formatted = formatCode(subject.code);
    if (!formatted) continue;
    byName.set(subject.name, formatted);
    byShort.set(subject.short, formatted);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function copyText(text, button) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }

      const old = button.textContent;
      button.textContent = "✓ Skopírované";
      button.classList.add("copied");
      window.setTimeout(() => {
        button.textContent = old;
        button.classList.remove("copied");
      }, 1200);
    } catch {
      window.prompt("Skopíruj kód:", text);
    }
  }

  function codeChip(code, compact = false) {
    return `<span class="course-code${compact ? " compact" : ""}">
      <span class="course-code-label">Kód</span>
      <code>${escapeHtml(code)}</code>
      <button type="button" class="course-code-copy" data-copy-course-code="${escapeHtml(code)}" aria-label="Kopírovať kód ${escapeHtml(code)}">⧉ Kopírovať</button>
    </span>`;
  }

  function enhanceCurrent() {
    const root = document.getElementById("registrationCurrent");
    if (!root) return;
    const box = root.querySelector(".registration-now-top > div");
    const heading = box?.querySelector("h2");
    if (!box || !heading || box.querySelector(".course-code")) return;
    const code = byName.get(heading.textContent.trim());
    if (!code) return;
    heading.insertAdjacentHTML("afterend", codeChip(code));
  }

  function enhancePriority() {
    const root = document.getElementById("registrationPriority");
    if (!root) return;

    for (const row of root.querySelectorAll(".priority-row")) {
      const main = row.querySelector(".priority-main");
      const short = main?.querySelector("strong")?.textContent?.trim();
      if (!main || !short || main.querySelector(".course-code")) continue;
      const code = byShort.get(short);
      if (!code) continue;
      main.querySelector("strong").insertAdjacentHTML("afterend", codeChip(code, true));
    }
  }

  function enhance() {
    enhanceCurrent();
    enhancePriority();
  }

  const registrationView = document.getElementById("registrationView");
  if (registrationView) {
    new MutationObserver(enhance).observe(registrationView, { childList: true, subtree: true });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-course-code]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    copyText(button.dataset.copyCourseCode || "", button);
  });

  enhance();
})();