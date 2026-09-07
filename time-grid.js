(() => {
  "use strict";

  const data = window.ROZVRH_DATA;
  if (!data) return;

  const TARGET_IDS = ["planReviewSchedule", "registrationSchedule"];

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function enhance(root) {
    if (!root || root.querySelector(":scope > .time-grid-scroll")) return;

    const week = root.querySelector(":scope > .registration-week");
    if (!week) return;

    const daySections = [...week.querySelectorAll(":scope > .registration-day")];
    if (!daySections.length) return;

    const cells = new Map();
    daySections.forEach((section, dayIndex) => {
      for (const eventEl of section.querySelectorAll(".registration-event")) {
        const time = eventEl.querySelector(".event-time")?.textContent?.trim();
        const slot = data.slots.indexOf(time);
        if (slot < 0) continue;
        const key = `${dayIndex}-${slot}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(eventEl.outerHTML);
      }
    });

    let html = `<div class="time-grid-scroll"><div class="time-grid">`;
    html += `<div class="time-grid-head time-grid-corner">Čas</div>`;
    data.days.forEach((day) => {
      html += `<div class="time-grid-head">${escapeHtml(day)}</div>`;
    });

    data.slots.forEach((slotLabel, slotIndex) => {
      const [from, to] = slotLabel.split("–");
      html += `<div class="time-grid-time"><strong>${escapeHtml(from)}</strong><span>${escapeHtml(to || "")}</span></div>`;

      data.days.forEach((_, dayIndex) => {
        const events = cells.get(`${dayIndex}-${slotIndex}`) || [];
        html += `<div class="time-grid-cell${events.length ? " has-event" : ""}">${events.join("")}</div>`;
      });
    });

    html += `</div></div>`;
    root.innerHTML = html;
  }

  function watch(root) {
    if (!root) return;
    const observer = new MutationObserver(() => enhance(root));
    observer.observe(root, { childList: true, subtree: false });
    enhance(root);
  }

  TARGET_IDS.forEach((id) => watch(document.getElementById(id)));
})();