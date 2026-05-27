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
});

/* ============================================================
   HMI PANEL OBSERVER — runs only on the HMI page

   Reads the currently open vessel detail panel whenever the
   user naturally opens one.  No card-clicking, no SPA
   navigation — zero impact on HMI responsiveness.

   Temp-control state + last-set data for ALL vessels are kept
   current by background.js collectAllSetpoints() which polls
   the REST API every 60 s without touching the DOM.

   This observer fills in the real-time value for whichever
   vessel the user is currently viewing, overwriting the API
   value immediately on open (rather than waiting up to 60 s).

   Data flow:
     content.js → { type: "hmi:scrape", items: [...] } → background.js
     background.js updates slots, broadcasts { type: "hmi:data" }
   ============================================================ */
(function () {
  if (!location.href.includes("/internal/hmi/")) return;

  // Returns false and logs once if the extension has been reloaded and this
  // content script's runtime context is no longer valid. The HMI tab only
  // needs a refresh (F5) to reconnect — not a close-and-reopen.
  var _contextLost = false;
  function runtimeOk() {
    if (_contextLost) return false;
    try {
      // chrome.runtime.id throws or is undefined when context is invalidated
      if (!chrome.runtime?.id) throw new Error("no id");
      return true;
    } catch (e) {
      _contextLost = true;
      console.warn(
        "[hmi-scrape] Extension context invalidated — refresh the HMI tab to reconnect.",
      );
      return false;
    }
  }

  // vesselNameToSlot: lowercased vessel name → slotName (e.g. "stuart alderman" → "1A")
  // Fetched once on startup; background.js already has the map so this is cheap.
  var vesselNameToSlot = {};

  function fetchVesselMap(callback) {
    if (!runtimeOk()) return;
    try {
      chrome.runtime.sendMessage(
        { type: "hmi:get-vessel-map" },
        function (resp) {
          if (chrome.runtime.lastError) return; // extension reloaded mid-call
          if (resp && resp.vesselNameToSlot) {
            vesselNameToSlot = resp.vesselNameToSlot;
          } else {
            console.warn(
              "[hmi-scrape] vessel map empty — background not ready?",
            );
          }
          if (callback) callback();
        },
      );
    } catch (e) {
      _contextLost = true;
      console.warn(
        "[hmi-scrape] Extension context invalidated — refresh the HMI tab to reconnect.",
      );
    }
  }

  // Helpers

  // Return the vessel detail panel currently open in .hmi_container, or null.
  // Rejects the loading skeleton so callers always get rendered content.
  function getOpenPanel() {
    var container = document.querySelector(".hmi_container");
    if (!container) return null;
    return (
      Array.from(container.children).find(function (el) {
        if (
          el.classList.contains("hmi_nav") ||
          el.classList.contains("vessels_hall_view") ||
          el.classList.contains("hmi_vessels_view") ||
          el.classList.contains("vessel-details__loading")
        )
          return false;
        return el.offsetHeight > 0;
      }) || null
    );
  }

  // Extract data from the currently visible vessel detail panel.
  function readPanel(panel) {
    var nameEl =
      panel.querySelector(".vessel-details__header__info__case_name") ||
      panel.querySelector(".vessel-details__header__info__name_location");
    var vesselName = nameEl
      ? nameEl.textContent.trim().replace(/\s+/g, " ")
      : null;

    var switchEl = panel.querySelector(".custom-switch");
    var tempControlOn;

    if (switchEl) {
      tempControlOn =
        switchEl.classList.contains("checked") &&
        switchEl.classList.contains("enabled");
    }

    var readoutVal = panel.querySelector(".readout__value");
    var readoutSec = panel.querySelector(".readout__secondary");
    var lastTempValue = readoutVal
      ? readoutVal.textContent.trim() || null
      : null;
    var lastTempSecondary = readoutSec
      ? readoutSec.textContent.trim() || null
      : null;

    // Blower setpoint field — read the live input value directly from the HMI DOM.
    // NOTE: selector is position-based and may need updating if the HMI layout changes.
    var blowerSpInput = document.querySelector(
      "body > div.hmi_container > div:nth-child(3) > div.vessel-details__container > div.vessel-details__content > div:nth-child(5) > div:nth-child(10) > div:nth-child(3) > div > div > input"
    );
    var blowerSetpointFieldValue = null;
    if (blowerSpInput) {
      var parsed = parseFloat(blowerSpInput.value);
      if (!isNaN(parsed)) blowerSetpointFieldValue = parsed;
    }

    // Strategy 1: vessel ID from URL  e.g. /hmi/v2/vessels/40/details
    var slotName = null;
    var urlMatch = window.location.href.match(/\/vessels\/(\d+)/);
    if (urlMatch) {
      slotName = vesselNameToSlot["id:" + urlMatch[1]] || null;
    }

    // Strategy 2: case name lookup
    if (!slotName && vesselName) {
      slotName = vesselNameToSlot[vesselName.toLowerCase()] || null;
    }

    if (vesselName || typeof tempControlOn !== "undefined") {
      return {
        slotName,
        vesselName,
        tempControlOn,
        lastTempValue,
        lastTempSecondary,
        blowerSetpointFieldValue,
      };
    }
    return null;
  }

  // Fast scrape: reads the currently open panel (no clicking)
  var _scrapeTimer = null;
  var _lastScrapeTs = 0;

  function scrapeCurrentPanel() {
    clearTimeout(_scrapeTimer);

    _scrapeTimer = setTimeout(function () {
      const now = Date.now();

      // Throttle: prevent excessive spam if UI is churning
      if (now - _lastScrapeTs < 300) return;
      _lastScrapeTs = now;

      var panel = getOpenPanel();
      if (!panel) return;

      var item = readPanel(panel);
      if (item && runtimeOk()) {
        try {
          chrome.runtime.sendMessage({ type: "hmi:scrape", items: [item] }).catch(() => {});
        } catch (e) {
          _contextLost = true;
        }
      }
    }, 300); // ⬅️ faster + still safe
  }

  // ── Panel-open observer ────────────────────────────────────────────────────
  // Watches ONLY the direct children of .hmi_container — not the deep subtree.
  // This fires when a panel is added/removed or its top-level class changes
  // (loading → loaded transition), but NOT on every nested React re-render.
  (function installPanelObserver() {
    function attach() {
      var container = document.querySelector(".hmi_container");
      if (!container) {
        setTimeout(attach, 2000);
        return;
      }

      var observer = new MutationObserver(function () {
        const panel = getOpenPanel();
        if (panel) scrapeCurrentPanel();
      });

      // childList: panel element added/removed
      // attributes + attributeFilter: loading class removed when panel finishes rendering
      // subtree: FALSE — only direct children, never the entire tree
      observer.observe(container, {
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
        subtree: false,
      });
    }
    attach();
  })();

  // Scheduling
  // Fetch vessel map once on startup so readPanel can resolve slot names.
  // Refresh every 5 min in case vessels are moved between slots.
  setTimeout(fetchVesselMap, 5000);
  setInterval(fetchVesselMap, 300000);

  // Periodic scrape — catches temp-ctrl state changes while a panel is already
  // open (e.g. auto-shutoff, motor stop).  The panel-open observer only fires
  // on panel add/remove, not on switch state changes inside the panel.
  setInterval(function () {
    if (getOpenPanel()) scrapeCurrentPanel();
  }, 10000);

  // Deep switch observer — fires immediately when the .custom-switch inside the
  // open panel gains or loses the "checked" class, no polling delay needed.
  (function installSwitchObserver() {
    var _switchObserver = null;
    var _observedPanel = null;

    function attachToPanel(panel) {
      if (panel === _observedPanel) return;
      if (_switchObserver) {
        _switchObserver.disconnect();
        _switchObserver = null;
      }
      _observedPanel = panel;
      _switchObserver = new MutationObserver(function (mutations) {
        for (const m of mutations) {
          if (m.type === "attributes") {
            scrapeCurrentPanel();
            return;
          }
        }
      });
      _switchObserver.observe(panel, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    // Re-check which panel is open every time the container changes.
    var container = document.querySelector(".hmi_container");
    if (!container) return;
    new MutationObserver(function () {
      var panel = getOpenPanel();
      if (panel) attachToPanel(panel);
      else {
        if (_switchObserver) {
          _switchObserver.disconnect();
          _switchObserver = null;
        }
        _observedPanel = null;
      }
    }).observe(container, {
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
      subtree: false,
    });
  })();

  // On-demand: fast scrape of currently open panel (after setpoint commands)
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === "SCRAPE_NOW") scrapeCurrentPanel();
  });
})();

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

  attachHallObserver();
  // Periodic rescrape catches lazy-loaded name updates without DOM mutations
  setInterval(scrapeHallViewCaseNames, 60_000);
})();
