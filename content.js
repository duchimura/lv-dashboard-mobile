// Only run on HMI or dashboard.html
(function () {
  if (
    !location.href.includes("/internal/hmi/") &&
    !location.href.includes("dashboard.html")
  ) {
    return;
  }

  // everything else in content.js stays below this
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "DASHBOARD_STATE") {
    window.postMessage(
      {
        type: "DASHBOARD_STATE",
        state: msg.state,
      },
      window.location.origin,
    );
  }
  if (msg.type === "hmi:rescrape-days") {
    // Dashboard just opened — run a fresh hall-view days scrape immediately.
    // scrapeHallViewDays is defined inside the hall-view IIFE below; we call
    // it via a small window-level trampoline set up by that IIFE.
    if (typeof window.__scrapeHallViewDays === "function") {
      window.__scrapeHallViewDays();
    }
  }
  if (msg.type === "SCRAPE_HALL_VIEW_NOW") {
    // Triggered by background.js when a slot presence change is detected.
    // Re-scrapes case names and days immediately so the dashboard card header
    // reflects the new vessel without waiting for the next observer tick.
    if (typeof window.__scrapeHallViewCaseNames === "function") {
      window.__scrapeHallViewCaseNames();
    }
    if (typeof window.__scrapeHallViewDays === "function") {
      window.__scrapeHallViewDays();
    }
  }
});


/* ============================================================
   HALL VIEW CASE NAME SCRAPER
   Reads the case name for every slot from the hall-view grid
   and sends { type:"hmi:case-names", slots:{slotName:caseName} }
   to background.js whenever the DOM changes.

   XPath reference (slot 001A):
     #vessels_hall_view > div[2] > div[2] > div[1] > div[1] > div[2] > div[1]
   Pattern: rack-groups[col][row] → .vessels_rack__content → .vessels_rack__content__name
   col: 1-based index → "001"–"013"
   row: 1-based index → "A"/"B"/"C"

   To revert: delete this entire block.
   ============================================================ */
(function () {
  if (!location.href.includes("/internal/hmi/")) return;

  var _ROW_LETTERS = ["A", "B", "C"];
  var _hallScrapeTimer = null;

  function scrapeHallViewCaseNames() {
    var rackGroupsEl = document.querySelector(
      "#vessels_hall_view > div:nth-child(2) > div:nth-child(2)"
    );
    if (!rackGroupsEl) return;

    var slots = {};
    var groupEls = rackGroupsEl.children;

    for (var col = 0; col < groupEls.length; col++) {
      var rackEls = groupEls[col].children;
      for (var row = 0; row < rackEls.length && row < 3; row++) {
        var contentEl = rackEls[row].children[1]; // div[2] = vessels_rack__content
        if (!contentEl) continue;
        var nameEl = contentEl.children[0]; // div[1] = vessels_rack__content__name
        if (!nameEl) continue;
        var caseName = nameEl.textContent.trim();
        if (!caseName) continue;
        var slotName = String(col + 1).padStart(3, "0") + (_ROW_LETTERS[row] || String(row + 1));
        slots[slotName] = caseName;
      }
    }

    if (Object.keys(slots).length === 0) return;

    try {
      chrome.runtime.sendMessage({ type: "hmi:case-names", slots }).catch(() => {});
    } catch (e) {}
  }

  function scheduleScrape() {
    clearTimeout(_hallScrapeTimer);
    _hallScrapeTimer = setTimeout(scrapeHallViewCaseNames, 800);
  }

  function attachHallObserver() {
    var hallEl = document.querySelector("#vessels_hall_view");
    if (!hallEl) { setTimeout(attachHallObserver, 3000); return; }
    new MutationObserver(scheduleScrape).observe(hallEl, { childList: true, subtree: true });
    scrapeHallViewCaseNames(); // initial scrape
  }

  // ── Hall-view days scraper ──────────────────────────────────────────────
  // Days live in .vessels_rack__header__actions__duration span.localdatetime
  // e.g. "21 days" — same DOM path as scrapeHallViewCaseNames.

  function scrapeHallViewDays() {
    var rackGroupsEl = document.querySelector(
      "#vessels_hall_view > div:nth-child(2) > div:nth-child(2)"
    );
    if (!rackGroupsEl) return;

    var slots = {};
    var groupEls = rackGroupsEl.children;

    for (var col = 0; col < groupEls.length; col++) {
      var rackEls = groupEls[col].children;
      for (var row = 0; row < rackEls.length && row < 3; row++) {
        var daysEl = rackEls[row].querySelector(
          ".vessels_rack__header__actions__duration .localdatetime"
        );
        if (!daysEl) continue;
        var m = daysEl.textContent.trim().match(/(\d+)/);
        if (!m) continue;
        var slotName = String(col + 1).padStart(3, "0") + (_ROW_LETTERS[row] || String(row + 1));
        slots[slotName] = +m[1];
      }
    }

    if (!Object.keys(slots).length) return;
    try {
      chrome.runtime.sendMessage({ type: "hmi:days-scrape", slots }).catch(() => {});
    } catch (e) {}
  }

  // Expose for the top-level message listener so background can trigger immediate re-scrapes
  window.__scrapeHallViewCaseNames = scrapeHallViewCaseNames;
  window.__scrapeHallViewDays = scrapeHallViewDays;

  // Share the existing hall observer — piggyback on scheduleScrape
  var _origScheduleScrape = scheduleScrape;
  scheduleScrape = function () {
    _origScheduleScrape();
    clearTimeout(scrapeHallViewDays._timer);
    scrapeHallViewDays._timer = setTimeout(scrapeHallViewDays, 800);
  };
  // ────────────────────────────────────────────────────────────────────────

  attachHallObserver();
  // Periodic rescrape catches lazy-loaded name updates without DOM mutations
  setInterval(scrapeHallViewCaseNames, 60_000);
  setInterval(scrapeHallViewDays, 60_000);
  scrapeHallViewDays(); // initial scrape
})();
