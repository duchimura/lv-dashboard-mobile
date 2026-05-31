// date+time stamp for every console.log post
function _log(...args) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}]`, ...args);
}

let state = {};
let slotColors = {}; // slotName → hex color from Digital Vessel Rack sheet

// Map a phase hex color to a segment count (1–4) for the bottom progress bar.
// Classification is HSL-based so it works with approximate/varied shades.
// Phase order: Biofirst(1) → PFRP(2) → Compost(3) → DryDown(4)
function _hexToPhaseSegments(hex) {
  if (!hex) return 0;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5
    ? (max - min) / (2 - max - min)
    : (max - min) / (max + min);

  if (l > 0.88)              return 3;  // near-white  → Compost
  if (s < 0.12 && l > 0.25) return 4;  // achromatic  → Dry Down

  // Chromatic: compute hue (0–360°)
  let h = 0;
  const d = max - min;
  if (max === r)      h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else                h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;

  if (h >= 40 && h <= 80) return 1;  // yellow / amber  → Biofirst
  if (h >= 10 && h <  40) return 2;  // orange / terracotta → PFRP
  return 1;                           // fallback → phase 1
}
let lastHeartbeat = 0;
let lastAngles = {};
let motorActiveUntil = {};
let motorStoppedTimer = {};
let blowerActiveUntil = {};
let motorSteadyGreen = {}; // latched true once motor confirmed running; cleared by explicit stop
let blowerOffTicks = {}; // consecutive renders with no blower signal (used to confirm off)
let isConnected = true;
let lastWsMessage = Date.now();
let prevDeclogActive = {};
let declogClearedAt = {};
let lowAirflowSince = {}; // timestamp when a slot first entered the low-airflow condition
let debugSlot = "";
let probeIssuesGlobal = new Set();
let probesUserToggled = false;
let vesselSearchTerm = "";
let renderScheduled = false;
let unrackedVessels = []; // [{ id, name }, …]
let gridReversed = localStorage.getItem("gridReversed") === "true";

const slotActiveIssues = new Map(); // slot → Set<'motor'|'temp'|'airflow'|'pressure'|'probe'>
let issuesModeActive = false;
let _kioskModeActive = false; // blocks applyZoom recalculation during kiosk cycling
const issuesFilterActive = new Set();

const fleetSparklineData = []; // fleet alarm count, one point per 10 s → 30 min of history
const SPARKLINE_MAX = 180;
const SPARKLINE_INTERVAL_MS = 10_000; // one point per 10 s → 30 min of history
let _sparklineLastUpdate = 0;

// ═══ UPTIME PROTOTYPE — flip to false to remove the indicator from all cards ═══
const UPTIME_PROTO_ENABLED = true;
// ════════════════════════════════════════════════════════════════════════════════

const gridEl = document.getElementById("grid");
const lastUpdatedEl = document.getElementById("last-updated");
const heartbeatEl = document.getElementById("heartbeat");
const columnHeadersEl = document.getElementById("column-headers");
const popup = document.getElementById("sp-popup");
const dashboardStartTime = Date.now();

// WS Connection Banner
// Appears ~3 s after initial load if live telemetry hasn't arrived yet.
// Dismissed automatically (with a brief green flash) on the first WS frame.
const _wsBannerEl = (() => {
  const el = document.createElement("div");
  el.id = "ws-loading-banner";
  Object.assign(el.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    zIndex: "999999",
    background: "#5a4500",
    color: "#ffe082",
    textAlign: "center",
    padding: "7px 12px",
    fontSize: "13px",
    letterSpacing: "0.02em",
    display: "none",
  });
  document.body.prepend(el);
  return el;
})();
let _wsBannerTimer = null;
let _wsBannerTick = null;
let _wsBannerDone = false;
let _wsBannerStart = 0;
let _wsDataReceived = false; // true once first WS telemetry frame arrives
let _hmiSyncReceived = false; // true once background confirms pause-state sync
const WS_BANNER_MIN_MS = 2000; // minimum banner display time so users can read it

function _checkBannerDone() {
  if (!(_wsDataReceived && _hmiSyncReceived)) return;
  if (!_wsBannerStart) return; // banner hasn't shown yet; dismiss will fire when it does
  const elapsed = Date.now() - _wsBannerStart;
  const delay = WS_BANNER_MIN_MS - elapsed;
  if (delay > 0) {
    setTimeout(() => {
      if (!_wsBannerDone) _hideWsBanner();
    }, delay);
  } else {
    _hideWsBanner();
  }
}

function _showWsBanner() {
  if (_wsBannerDone) return;
  _wsBannerStart = Date.now();
  _wsBannerEl.style.display = "block";
  function tick() {
    const s = Math.round((Date.now() - _wsBannerStart) / 1000);
    _wsBannerEl.textContent = `⏳ Synchronizing dashboard with HMI… (${s}s)`;
  }
  tick();
  _wsBannerTick = setInterval(tick, 1000);
}

function _hideWsBanner() {
  if (_wsBannerDone) return;
  _wsBannerDone = true;
  clearInterval(_wsBannerTick);
  _wsBannerEl.style.display = "block";
  // Brief green confirmation before fading out
  _wsBannerEl.textContent = "✅ Dashboard ready";
  Object.assign(_wsBannerEl.style, { background: "#1b3a1b", color: "#a5d6a7" });
  setTimeout(() => {
    _wsBannerEl.style.display = "none";
  }, 2000);
}

// Column-headers and grid are always positioned below the fixed header +
// the reserved attention zone. The attention zone is a fixed constant so the
// grid never shifts when attention items appear, disappear, or change.
const ATTENTION_ZONE_MIN_PX = 10; // minimum reserved zone when list is empty
let headerGapOffset = 0; // extra gap below header, controlled by drag handle
let _updateHeaderZone = null; // exposed so initHeaderDragHandle can trigger recalc

(function initHeaderZoneTracking() {
  const fixedHeaderEl = document.getElementById("fixed-header");
  const root = document.documentElement;

  function updateHeaderZone() {
    const headerH = fixedHeaderEl ? fixedHeaderEl.offsetHeight : 80;
    const gapHandleTop = headerH + headerGapOffset;
    const attentionEl = document.getElementById("attention-list");
    const attentionH = attentionEl
      ? attentionEl.offsetHeight
      : ATTENTION_ZONE_MIN_PX;
    const zone = gapHandleTop + 6 + Math.max(attentionH, ATTENTION_ZONE_MIN_PX);
    root.style.setProperty("--fixed-header-height", headerH + "px");
    root.style.setProperty("--gap-handle-top", gapHandleTop + "px");
    root.style.setProperty("--col-headers-top", zone + "px");
    root.style.setProperty("--grid-margin-top", zone + "px");
  }

  _updateHeaderZone = updateHeaderZone;
  updateHeaderZone();

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(updateHeaderZone);
    if (fixedHeaderEl) ro.observe(fixedHeaderEl);
  }
})();

// Shared tooltip for temp-sp hover in cards
const _tempTip = document.createElement("div");
_tempTip.id = "temp-hover-tooltip";
document.body.appendChild(_tempTip);
const debugToggle = document.getElementById("debug-toggle");
const debugOverlayEl = document.getElementById("debug-overlay");
const debugInput = document.getElementById("debug-slot-input");

if (debugOverlayEl) {
  debugOverlayEl.style.left = "20px";
  debugOverlayEl.style.top = "100px";
}

// SAFETY RESET: ensure overlay is on-screen
if (debugOverlayEl) {
  const rect = debugOverlayEl.getBoundingClientRect();
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x > window.innerWidth ||
    rect.y > window.innerHeight
  ) {
    debugOverlayEl.style.left = "20px";
    debugOverlayEl.style.top = "100px";
  }
}

// Normalize a raw slot input: uppercase, pad numeric part to 3 digits.
// "2a" → "002A", "12b" → "012B", "001A" → "001A"
function normalizeSlot(raw) {
  const s = raw.trim().toUpperCase();
  const match = s.match(/^(\d{1,3})([A-Z])$/);
  if (match) return match[1].padStart(3, "0") + match[2];
  return s;
}

// show/hide debug overlay
if (debugToggle && debugOverlayEl) {
  debugToggle.addEventListener("click", () => {
    debugOverlayEl.classList.toggle("hidden");
    const isNowVisible = !debugOverlayEl.classList.contains("hidden");
    debugToggle.classList.toggle("active", isNowVisible);
    if (isNowVisible && debugInput) debugInput.focus();
  });
}

// debug input watcher
if (debugInput) {
  debugInput.addEventListener("input", () => {
    debugSlot = normalizeSlot(debugInput.value);
    updateDebugOverlayForSelectedSlot();
  });

  debugInput.addEventListener("blur", () => {
    debugSlot = normalizeSlot(debugInput.value);
    debugInput.value = debugSlot;
    updateDebugOverlayForSelectedSlot();
  });
}

setInterval(() => {
  if (Date.now() - lastWsMessage > 5000) {
    isConnected = false;
    updateLastUpdated();
  }
}, 1000);

function deriveVesselPresence(v, t) {
  if (typeof t.slotHasVessel !== "undefined") return Boolean(t.slotHasVessel);
  if (typeof t.hasVessel !== "undefined") return Boolean(t.hasVessel);

  const numericKeys = [
    "mass",
    "processTemp",
    "heaterTemp",
    "airflow",
    "temp0",
    "temp1",
    "temp2",
  ];
  const anyMeaningfulValue = numericKeys.some((k) => {
    const val = Number(t[k]);
    return !isNaN(val) && val > 0.5;
  });

  if (!anyMeaningfulValue) return false;
  if (typeof t.currentAngle === "number" && Math.abs(t.currentAngle) > 1)
    return true;
  return anyMeaningfulValue;
}

function slotHasVessel(slotName) {
  const v = state[slotName];
  if (!v) return false;
  if (typeof v.vesselPresent !== "undefined") return v.vesselPresent;
  return deriveVesselPresence(v, v.telemetry || {});
}

/* RENDER THROTTLING */
function scheduleRender() {
  if (renderScheduled) return;

  // BLOCK render while popup is open
  if (popupState.open) return;

  renderScheduled = true;
  requestAnimationFrame(() => {
    render();
    updateAttentionList();
    applyIssuesFilter();
    applyColVisibility();
    syncAllToggleButtons();
    syncColumnPauseState();
    if (issuesModeActive) _kioskZoomToVisibleCards();
    else if (isZoomed && !_kioskModeActive) applyZoom();
    renderScheduled = false;
  });
}

/* COLUMN HEADERS */
function renderColumnHeaders() {
  columnHeadersEl.innerHTML = "";
  const cols = gridReversed
    ? Array.from({ length: 13 }, (_, k) => 13 - k)
    : Array.from({ length: 13 }, (_, k) => k + 1);
  for (const i of cols) {
    const h = document.createElement("div");
    h.className = "column-header";

    const pauseBtn = document.createElement("button");
    pauseBtn.className = "column-pause-btn";
    pauseBtn.innerHTML = `${i}`;
    pauseBtn.title = `Pause rack column ${i}`;
    pauseBtn.dataset.column = i;
    pauseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPauseRackDialog(i, pauseBtn);
    });
    h.appendChild(pauseBtn);

    columnHeadersEl.appendChild(h);
  }
}
renderColumnHeaders();

// Tracks columns paused via the dashboard (optimistic, until HMI confirms).
const dashboardPausedColumns = new Set();

/* PAUSE RACK DIALOG */
const pauseRackDialog = document.getElementById("pause-rack-dialog");
const pauseRackMsg = document.getElementById("pause-rack-dialog-msg");
const pauseRackConfirm = document.getElementById("pause-rack-confirm");
const pauseRackCancel = document.getElementById("pause-rack-cancel");
let _dialogCallback = null;

//  confirm dialog — to prevent accidental clicks
function openConfirmDialog(msg, confirmLabel, onConfirm) {
  _dialogCallback = onConfirm;
  pauseRackMsg.textContent = msg;
  pauseRackConfirm.textContent = confirmLabel;
  pauseRackDialog.classList.remove("hidden");
  pauseRackConfirm.focus();
}

function closeConfirmDialog() {
  pauseRackDialog.classList.add("hidden");
  _dialogCallback = null;
}

function openPauseRackDialog(column, btn) {
  //openConfirmDialog(`Pause Rack ${column}?`, "Pause Rack", () => { //Tony didn't like this extra confirmation click
  if (btn) btn.disabled = true;
  chrome.runtime.sendMessage({ type: "pause-rack", column }, (resp) => {
    if (chrome.runtime.lastError) {
      if (btn) btn.disabled = false;
      return;
    }
    if (btn) btn.disabled = false;
    if (resp?.ok) {
      dashboardPausedColumns.add(column);
      syncColumnPauseState();
      showSetpointToast(`⏸ Rack ${column} pause sent.`);
    } else {
      showSetpointToast(
        `Pause Rack ${column} failed: ` + (resp?.error ?? "unknown error"),
        true,
      );
    }
  });
  //});
}

if (pauseRackConfirm) {
  pauseRackConfirm.addEventListener("click", () => {
    const cb = _dialogCallback;
    closeConfirmDialog();
    if (cb) cb();
  });
}

if (pauseRackCancel) {
  pauseRackCancel.addEventListener("click", closeConfirmDialog);
}

if (pauseRackDialog) {
  pauseRackDialog.addEventListener("click", (e) => {
    if (e.target === pauseRackDialog) closeConfirmDialog();
  });
}

/* DATA VALUE FORMATTERS */
//round to 2 decimal places by default
function format(v, digits = 2) {
  return typeof v === "number" && !isNaN(v) ? v.toFixed(digits) : "–";
}
// convert Celsius to Fahrenheit
function toF(v) {
  return typeof v === "number" && !isNaN(v) ? (v * 9) / 5 + 32 : null;
}
// convert kg to lbs
function toLbs(v) {
  return typeof v === "number" && !isNaN(v) ? v * 2.20462 : null;
}

function updateLastUpdated() {
  if (!isConnected) {
    lastUpdatedEl.textContent = "Connection Lost";
    lastUpdatedEl.style.color = "red";
    lastUpdatedEl.style.fontWeight = "bold";
    return;
  }

  let latest = null;
  for (const slot of Object.values(state)) {
    const t = slot.telemetry;
    if (!t || !t.lastUpdate) continue;
    const ts = new Date(t.lastUpdate).getTime();
    if (!latest || ts > latest) latest = ts;
  }

  lastUpdatedEl.style.color = "";
  lastUpdatedEl.style.fontWeight = "";
  lastUpdatedEl.style.marginLeft = "8px";
  lastUpdatedEl.textContent = latest
    ? `Connection is active. Last update: ${new Date(latest).toLocaleTimeString()}`
    : "Last update: —";
}

/* CARD CACHE */
const cardMap = new Map();

/* FLEET SPARKLINE RENDERER — full-width canvas, bars + blue linear trendline */
function drawFleetSparkline(canvas, points) {
  if (!canvas || points.length < 1) return;
  const dpr = Math.ceil(window.devicePixelRatio || 1);
  // getBoundingClientRect forces a synchronous reflow and returns the true
  // rendered size — reliable even during drag resize when offsetHeight can lag.
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || 800;
  const cssH = rect.height || 74;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  const barW = cssW / SPARKLINE_MAX;
  const gap = 1;
  const startX = cssW - points.length * barW;
  const minBarH = 2;
  const fontSize = Math.max(9, Math.min(11, cssH / 7));
  const yAxisW = 18; // px reserved for y-axis count labels
  const chartW = cssW - yAxisW;
  const chartStartX = yAxisW + (startX > yAxisW ? startX - yAxisW : 0);

  // Scale: max count in buffer (floor at 1 so empty chart still renders)
  const maxCount = Math.max(1, ...points);

  // Helper: count → canvas Y
  const countToY = (c) =>
    Math.max(minBarH, cssH - (c / maxCount) * (cssH - fontSize - 2));

  // Bars
  for (let i = 0; i < points.length; i++) {
    const count = points[i];
    const x = yAxisW + i * barW;
    const barH = cssH - countToY(count);
    const y = cssH - barH;
    ctx.fillStyle =
      count === 0
        ? "rgba(34,197,94,0.80)"
        : count <= 2
          ? "rgba(255,160,64,0.85)"
          : "rgba(255,85,85,0.85)";
    ctx.fillRect(x + gap / 2, y, barW - gap, Math.max(minBarH, barH));
  }

  // Blue linear trendline (least-squares regression, in count space)
  if (points.length >= 2) {
    const n = points.length;
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += points[i];
      sumXY += i * points[i];
      sumX2 += i * i;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom !== 0) {
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      const cy0 = Math.max(1, Math.min(cssH - 1, countToY(intercept)));
      const cy1 = Math.max(
        1,
        Math.min(cssH - 1, countToY(slope * (n - 1) + intercept)),
      );
      const tx1 = yAxisW + (n - 1) * barW + barW / 2;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(96,165,250,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.moveTo(yAxisW, cy0);
      ctx.lineTo(tx1, cy1);
      ctx.stroke();
    }
  }

  // Y-axis labels: 0 at bottom, maxCount at top
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = "rgba(156,163,175,0.65)";
  ctx.textAlign = "right";
  ctx.fillText(maxCount, yAxisW - 2, fontSize + 1);
  if (maxCount >= 2)
    ctx.fillText(Math.round(maxCount / 2), yAxisW - 2, cssH / 2 + fontSize / 2);
  ctx.fillText("0", yAxisW - 2, cssH - 2);

  // Time labels
  ctx.textAlign = "left";
  ctx.fillText("−4h", yAxisW + 2, cssH - 2);
  ctx.textAlign = "right";
  ctx.fillText("now", cssW - 2, cssH - 2);
  ctx.textAlign = "left";

  ctx.restore();
}

/* CREATE CARD ONCE */
function createCard(slotName) {
  if (cardMap.has(slotName)) return cardMap.get(slotName);
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.slot = slotName;

  const header = document.createElement("div");
  header.className = "card-header card-header-text";
  card.appendChild(header);

  const bubbles = document.createElement("div");
  bubbles.className = "bubbles";

  const m = document.createElement("div");
  m.className = "bubble bubble-m";
  m.textContent = "M";
  m.dataset.bubble = "M";
  m.title = "Click to set motor speed";
  m.style.cursor = "pointer";
  m.addEventListener("click", (e) => {
    e.stopPropagation();
    const c = m.closest(".card");
    /* don't need to log click events anymore - for debugging
    _log(
      "🫧 M click",
      slotName,
      "no-vessel:",
      c?.classList.contains("no-vessel"),
      "classes:",
      c?.className,
    );
    */
    if (!c || c.classList.contains("no-vessel")) return;
    const sn = c.dataset.slot;
    if (sn && typeof window.__showSetpointPopup === "function")
      window.__showSetpointPopup(m, sn, "motor");
  });

  const t = document.createElement("div");
  t.className = "bubble bubble-t";
  t.textContent = "T";
  t.dataset.bubble = "T";
  t.title = "Click to set temperature setpoint";
  t.style.cursor = "pointer";
  t.addEventListener("click", (e) => {
    e.stopPropagation();

    const card = e.target.closest(".card");
    if (!card || card.classList.contains("no-vessel")) return;

    const sn = card.dataset.slot;
    if (!sn) return;

    chrome.runtime.sendMessage(
      {
        type: "setpoint:set",
        slotName: sn,
        spType: "temp-ctrl",
        value: 1,
      },
      (resp) => {
        if (chrome.runtime.lastError) return;
        _log("📤 SENT temp-ctrl ON →", sn, resp);
      },
    );

    if (typeof window.__showSetpointPopup === "function") {
      window.__showSetpointPopup(t, sn, "temp");
    }
  });

  const b = document.createElement("div");
  b.className = "bubble bubble-b";
  b.textContent = "B";
  b.dataset.bubble = "B";
  b.title = "Click to set airflow setpoint";
  b.style.cursor = "pointer";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    const c = b.closest(".card");
    if (!c || c.classList.contains("no-vessel")) return;
    const sn = c.dataset.slot;
    if (sn && typeof window.__showSetpointPopup === "function")
      window.__showSetpointPopup(b, sn, "blower");
  });

  bubbles.appendChild(m);
  bubbles.appendChild(t);
  bubbles.appendChild(b);

  card.appendChild(bubbles);

  // ═══ UPTIME PROTOTYPE START ════════════════════════════════════════════════
  if (UPTIME_PROTO_ENABLED) {
    const _r = 18,
      _circ = +(2 * Math.PI * _r).toFixed(2);
    const _demoPct = 94.2;
    const _offset = +((1 - _demoPct / 100) * _circ).toFixed(2);
    const _uptimeBadge = document.createElement("div");
    _uptimeBadge.className = "uptime-proto";
    _uptimeBadge.innerHTML = `
      <svg viewBox="0 0 44 44" width="44" height="44">
        <circle class="uptime-proto-track" cx="22" cy="22" r="${_r}"/>
        <circle class="uptime-proto-arc" cx="22" cy="22" r="${_r}"
          transform="rotate(-90 22 22)"
          stroke-dasharray="${_circ}"
          stroke-dashoffset="${_offset}"/>
        <text class="uptime-proto-num" x="22" y="22" text-anchor="middle" dominant-baseline="central">94.2</text>
        <!-- <text class="uptime-proto-sym" x="22" y="29" text-anchor="middle">%</text> -->
      </svg>
      <div class="uptime-proto-lbl">24H</div>
      <div class="uptime-proto-compact">94.2<span class="uptime-proto-compact-pct">%</span></div>`;
    card.appendChild(_uptimeBadge);
  }
  // ═══ UPTIME PROTOTYPE END ══════════════════════════════════════════════════

  // Clicking card body (not a bubble — bubbles stopPropagation) opens combined menu
  card.addEventListener("click", () => {
    if (card.classList.contains("no-vessel")) return;
    if (popupState.open && popupState.slot === slotName) return;
    openPopup(card, slotName, "combined");
  });

  const declog = document.createElement("div");
  declog.className = "declog-label-under declog-label";
  card.appendChild(declog);

  const pressureEl = document.createElement("div");
  pressureEl.className = "telemetry-row pressure-row";
  pressureEl.innerHTML = `
  <span class="telemetry-label">Pressure:</span>
  <span class="telemetry-reading pressure-reading">
    <span class="pressure-value">—</span>
  </span>
`;
  card.appendChild(pressureEl);

  const telemetry = document.createElement("div");
  telemetry.className = "telemetry";

  telemetry.innerHTML += `
    <div class="telemetry-row heater-row">
      <span class="telemetry-label">Heater:</span>
      <span class="telemetry-reading heater-reading">—</span>
      <span class="telemetry-sp"></span>
    </div>
  `;

  telemetry.innerHTML += `
    <div class="telemetry-row t2-row">
      <span class="telemetry-label">Frt:</span>
      <span class="t2-value">—</span>
    </div>
    <div class="telemetry-row t1-row">
      <span class="telemetry-label">Mid:</span>
      <span class="t1-value">—</span>
    </div>
    <div class="telemetry-row t0-row">
      <span class="telemetry-label">Rr:</span>
      <span class="t0-value">—</span>
    </div>
  `;

  telemetry.innerHTML += `
    <div class="telemetry-row temp-row">
      <span class="telemetry-label">AvgTemp:</span>
      <span class="telemetry-reading temp-reading">—</span>
      <span class="telemetry-sp temp-sp"></span>
    </div>
  `;

  telemetry.innerHTML += `
    <div class="telemetry-row blower-row">
      <span class="telemetry-label">Airflow:</span>
      <span class="telemetry-reading airflow-reading">—</span>
      <span class="telemetry-sp airflow-sp"></span>
    </div>
  `;

  telemetry.innerHTML += `
    <div class="telemetry-row motor-row">
      <span class="telemetry-label">Angle:</span>
      <span class="telemetry-reading angle-reading">—</span>
      <span class="telemetry-sp motor-sp"></span>
    </div>
  `;

  telemetry.innerHTML += `
    <div class="telemetry-row mass-row">
      <span class="telemetry-label">Mass:</span>
      <span class="telemetry-reading mass-reading">—</span>
    </div>
  `;

  telemetry.innerHTML += `
    <div class="telemetry-row mechstatus-row">
      <span class="telemetry-label mechstatus-label">Status:</span>
      <span class="telemetry-reading mechstatus-reading">—</span>
    </div>
    <div class="telemetry-row mechstatus-row tempmod-row">
      <span class="telemetry-label tempmod-label">Status2:</span>
      <span class="telemetry-reading tempmod-reading">—</span>
    </div>
  `;

  telemetry.innerHTML += `
    <div class="status-line" style="font-style: italic">
      <span class="status-label" style="font-size: 11px; font-weight: 600; color: #999">Msg: </span>
      <span class="status-value">—</span>
    </div>
  `;

  card.appendChild(telemetry);

  const issuesStrip = document.createElement("div");
  issuesStrip.className = "card-issues-strip";
  card.appendChild(issuesStrip);

  const badgeGroup = document.createElement("div");
  badgeGroup.className = "badge-group";

  const nameBadge = document.createElement("div");
  nameBadge.className = "name-badge";
  badgeGroup.appendChild(nameBadge);

  const daysBadge = document.createElement("div");
  daysBadge.className = "days-badge";
  badgeGroup.appendChild(daysBadge);

  card.appendChild(badgeGroup);

  // Temp-sp hover tooltip
  const tempSpHover = card.querySelector(".temp-sp");
  if (tempSpHover) {
    tempSpHover.addEventListener("mouseenter", () => {
      const val = tempSpHover.dataset.lastTempValue;
      if (!val) return;
      const sec = tempSpHover.dataset.lastTempSecondary || "";
      let tip = document.getElementById("temp-hover-tooltip");
      if (!tip) return;
      tip.innerHTML = `<strong>${val}</strong>${sec ? `<br><span>${sec}</span>` : ""}`;
      const r = tempSpHover.getBoundingClientRect();
      tip.style.left = `${r.left}px`;
      tip.style.top = `${r.bottom + 4}px`;
      tip.style.display = "block";
    });
    tempSpHover.addEventListener("mouseleave", () => {
      const tip = document.getElementById("temp-hover-tooltip");
      if (tip) tip.style.display = "none";
    });
  }

  gridEl.appendChild(card);
  cardMap.set(slotName, card);
  return card;
}

/* UPDATE CARD CONTENT ONLY */
function updateCard(slotName, v) {
  const t = v.telemetry || {};
  const card = cardMap.get(slotName) || createCard(slotName);

  const header = card.querySelector(".card-header-text");
  // wait_vessel = physically empty slot; faulted mixer = slot is also empty.
  // Either condition alone means no vessel is present, regardless of what
  // vesselPresent reports (the API can lag in both transient states).
  const _mechLower = (v.mechanicalStatus || "").toLowerCase();
  const _mixerUpper = (v.mixerModuleStatus || "").toUpperCase();
  const isEmptySlot =
    _mechLower === "wait_vessel" || _mixerUpper.includes("FAULTED");
  const hasVessel = slotHasVessel(slotName) && !isEmptySlot;
  card.classList.toggle("no-vessel", !hasVessel);

  if (!hasVessel) {
    // Clear per-slot motion/blower state so a new vessel starts fresh
    motorSteadyGreen[slotName] = false;
    blowerOffTicks[slotName] = 0;
    blowerActiveUntil[slotName] = 0;
    motorActiveUntil[slotName] = 0;
    delete lastAngles[slotName];
    if (motorStoppedTimer[slotName]) {
      clearTimeout(motorStoppedTimer[slotName]);
      motorStoppedTimer[slotName] = null;
    }
    header.textContent = `${slotName} - No Vessel`;
    if (v.telemetry) {
      Object.assign(v.telemetry, {
        mass: 0,
        processTemp: 0,
        heaterTemp: 0,
        airflow: 0,
        temp0: 0,
        temp1: 0,
        temp2: 0,
        currentAngle: 0,
      });
    }
  } else {
    header.textContent = v.vesselName
      ? `${slotName} - ${v.vesselName}`
      : slotName;
    card.dataset.name = (v.vesselName ?? "").toLowerCase();
  }

  const telemetry = card.querySelector(".telemetry");
  if (!telemetry) return;

  const msg = telemetry.querySelector(".no-vessel-msg");
  if (msg) msg.remove();

  if (!hasVessel) {
    telemetry
      .querySelectorAll(".telemetry-reading")
      .forEach((el) => (el.textContent = "—"));
    card.querySelectorAll(".bubble").forEach((b) => {
      b.classList.remove("on", "off", "stopped", "error", "fault");
      b.classList.add("off");
    });

    const declog = card.querySelector(".declog-label");
    if (declog) declog.style.display = "none";
    const statusValue = card.querySelector(".status-value");
    if (statusValue) statusValue.textContent = "—";
    card.style.background = "";
    return;
  }

  // COMMAND STATUS (needed early for first-render mixer logic)
  const mixerCommand = (v.mixerModuleStatus || "").toUpperCase();
  const commandIsOn =
    mixerCommand === "MIXER_RUNNING" ||
    mixerCommand === "MIXER_MIXING" ||
    mixerCommand === "ON";
  const commandIsOff = mixerCommand === "OFF" || mixerCommand === "MIXER_OFF";
  const isStoppedUnexpectedly = mixerCommand === "MIXER_STOPPED";
  const hasFault = v.valveModuleStatus === "VALVE_FAULT";
  // ctrl_inactive in mechanicalStatus = operator deliberately paused the rack.
  // Safer than rackGroupPaused because it is per-slot; rackGroupPaused can be
  // incorrectly true when an unoccupied A position triggers the HMI "reset rack" button.
  const ctrlInactive = (v.mechanicalStatus || "")
    .toLowerCase()
    .includes("ctrl_inactive");

  // manuallyPaused: rack group was intentionally paused by an operator, not auto-paused.
  // The HMI sets rackGroupPaused automatically when the A slot is empty — that is NOT
  // a manual pause. We distinguish by checking whether A has a vessel: if A is occupied
  // and the rack is paused, an operator must have deliberately paused a running rack group.
  // If this IS the A slot (row 0) and it's paused, A having a vessel is implicit.
  const _aSlot =
    v.row === 0
      ? null
      : Object.values(state).find((s) => s.column === v.column && s.row === 0);
  const manuallyPaused =
    v.rackGroupPaused === true &&
    (v.row === 0 || _aSlot?.vesselPresent === true);

  // MIXER LOGIC
  const currentAngle = Number(t.currentAngle);
  const prevAngle = lastAngles[slotName];
  let mixerOn = false;
  let mixerStopped = false;

  if (!isNaN(currentAngle)) {
    if (prevAngle !== undefined && Math.abs(currentAngle - prevAngle) > 10) {
      // angle changed — motor is moving
      mixerOn = true;
      motorActiveUntil[slotName] = Date.now() + 30000;
      motorSteadyGreen[slotName] = true;
      if (motorStoppedTimer[slotName]) {
        clearTimeout(motorStoppedTimer[slotName]);
        motorStoppedTimer[slotName] = null;
      }
    } else if (prevAngle !== undefined) {
      // angle hasn't changed — start stopped timer if not already running
      if (
        !motorStoppedTimer[slotName] &&
        (motorActiveUntil[slotName] || 0) < Date.now()
      ) {
        motorStoppedTimer[slotName] = setTimeout(() => {
          motorStoppedTimer[slotName] = null;
          motorSteadyGreen[slotName] = false;
          scheduleRender();
        }, 30000);
      }
    } else {
      // FIRST RENDER with angle data: no previous angle yet — seed from command status
      mixerOn = commandIsOn;
      if (commandIsOn && !motorActiveUntil[slotName]) {
        motorActiveUntil[slotName] = Date.now() + 30000;
      }
    }
    lastAngles[slotName] = currentAngle;
  } else if (
    prevAngle === undefined &&
    !(motorActiveUntil[slotName] > Date.now())
  ) {
    // No telemetry at all yet (SW just restarted, empty telemetry object)
    // seed motorActiveUntil from API command status so M bubble shows the
    // correct initial state before the first WS angle reading arrives.
    if (commandIsOn) motorActiveUntil[slotName] = Date.now() + 30000;
  }

  if ((motorActiveUntil[slotName] || 0) > Date.now()) {
    mixerOn = true;
    mixerStopped = false;
  } else if (!motorStoppedTimer[slotName] && prevAngle !== undefined) {
    mixerStopped = true;
  }

  // BLOWER / DECLOG
  const airflow = Number(t.airflow ?? 0);
  const declogActive = v.intake_declog_req === 1 || v.exhaust_declog_req === 1;

  if (!declogActive && prevDeclogActive[slotName]) {
    declogClearedAt[slotName] = Date.now();
    // Give the blower a full recovery window after a declog clears
    // the blower may take some time to ramp back up and we don't want
    // the B bubble to turn red in the interim.
    blowerActiveUntil[slotName] = Date.now() + 150000;
    blowerOffTicks[slotName] = 0;
  }
  prevDeclogActive[slotName] = declogActive;

  const rawBlowerOn =
    (v.valveModuleStatus || "").toUpperCase() === "ON" || airflow > 0;
  // 150 s debounce: keeps the B bubble green through brief anomalies.
  if (rawBlowerOn) {
    blowerActiveUntil[slotName] = Date.now() + 150000;
    blowerOffTicks[slotName] = 0;
  } else {
    blowerOffTicks[slotName] = (blowerOffTicks[slotName] || 0) + 1;
  }
  // Only confirm blower off when the 150 s timer has expired AND we've seen
  // several consecutive renders with no signal — prevents a single stale/missing
  // reading at the boundary from flipping the bubble red.
  const blowerEverSeen = !!blowerActiveUntil[slotName];
  const blowerTimerExpired = (blowerActiveUntil[slotName] || 0) <= Date.now();
  let blowerOn =
    blowerEverSeen &&
    !(blowerTimerExpired && (blowerOffTicks[slotName] || 0) >= 5);
  if (declogActive) blowerOn = false;

  // TEMP
  const heaterTemp = Number(t.heaterTemp ?? 0);
  const processTemp = Number(t.processTemp ?? 0);
  const tempSpNum = Number(v.temp_sp);
  const tempShouldBeGreen =
    heaterTemp > processTemp + 1 || processTemp >= tempSpNum;

  // PRESSURE
  const pressure = Number(t.pressure ?? 0);
  const pv = card.querySelector(".pressure-value");
  if (pv) {
    pv.textContent = `${format(pressure)} kPa`;
    pv.className = "pressure-value";
    if (pressure > 9) pv.classList.add("pressure-alarm");
    else if (pressure > 5) pv.classList.add("pressure-high");
  }

  // MIXER BUBBLE LOGIC
  const angleNearZero = !isNaN(currentAngle) && Math.abs(currentAngle) <= 5;
  const angleNotMoving =
    prevAngle !== undefined && Math.abs(currentAngle - prevAngle) <= 1;
  const likelyCommandedOff = angleNearZero && angleNotMoving;

  // When WS status definitively says motor is not running, clear the
  // angle-derived steady-green state immediately rather than waiting up to 30 s
  // for the stale-angle timer. The angle-based latch was designed to survive a
  // *lagging status string* (API polling); WS-delivered status is live, so it
  // takes precedence. If angle starts moving again on the next frame the latch
  // will re-engage automatically.
  const statusSaysMotorOff =
    commandIsOff ||
    isStoppedUnexpectedly ||
    mixerCommand === "POWER_INACTIVE" ||
    mixerCommand.includes("FAULTED");
  if (statusSaysMotorOff && motorSteadyGreen[slotName]) {
    motorSteadyGreen[slotName] = false;
    motorActiveUntil[slotName] = 0;
    if (motorStoppedTimer[slotName]) {
      clearTimeout(motorStoppedTimer[slotName]);
      motorStoppedTimer[slotName] = null;
    }
  }

  let mixerBubble;
  if (motorSteadyGreen[slotName]) {
    // Angle telemetry confirms rotation — highest priority, overrides stale status field.
    mixerBubble = "on";
  } else if (commandIsOff || (isStoppedUnexpectedly && likelyCommandedOff)) {
    mixerBubble = "off";
  } else if (isStoppedUnexpectedly && hasFault) {
    mixerBubble = "fault";
  } else if (isStoppedUnexpectedly && (ctrlInactive || manuallyPaused)) {
    mixerBubble = "off";
  } else if (isStoppedUnexpectedly) {
    mixerBubble = "stopped";
  } else if (commandIsOn && mixerOn) {
    mixerBubble = "on";
  } else if (commandIsOn && !mixerOn) {
    mixerBubble = "stopped";
  } else {
    // Status is unknown / transitional (e.g. power_inactive, empty string).
    // If a motor setpoint is configured and no valid excuse exists, the motor
    // should be spinning — flag it red so the issue is visible.
    const _motorSp = v.setpoints?.motorSp ?? null;
    const _powerInactive = mixerCommand === "POWER_INACTIVE";
    if (
      _motorSp > 0 &&
      !hasFault &&
      !manuallyPaused &&
      !ctrlInactive &&
      !_powerInactive
    ) {
      mixerBubble = "stopped";
    } else {
      mixerBubble = "off";
    }
  }

  function setBubble(card, selector, baseClass, stateClass) {
    const el = card.querySelector(selector);
    if (!el) return;
    el.className = `${baseClass} ${stateClass}`;
  }

  setBubble(card, ".bubble-m", "bubble bubble-m", mixerBubble);
  // T bubble: three states driven by HMI scrape
  //   true  → green "on"     (HMI confirms temp control is ON)
  //   false → red "error"    (HMI confirms temp control is OFF, not at setpoint)
  //   false → grey "off"     (temp control is OFF but current temp is at setpoint — normal)
  //   null  → grey "off"     (scrape hasn't run yet — state unknown)

  //const tVal = isTempControlOn(slotName) === true;
  const tState = v.tempControlOn;

  const _tSpF = v.setpoints?.tempSp ?? null;
  const _tCurF = typeof t.processTemp === "number" ? toF(t.processTemp) : null;
  // True when current temp is within ±3°F of setpoint (any control state).
  const _tNearSetpoint =
    _tSpF !== null && _tCurF !== null && Math.abs(_tCurF - _tSpF) <= 2;
  // For bubble logic: only suppress red when control is off AND at setpoint.
  const _tAtSetpoint = tState === false && _tNearSetpoint;

  const _tProbes = [
    toF(Number(t.temp0)),
    toF(Number(t.temp1)),
    toF(Number(t.temp2)),
  ].filter((x) => x !== null && !isNaN(x));
  const _tAvgF =
    _tProbes.length > 0
      ? _tProbes.reduce((a, b) => a + b, 0) / _tProbes.length
      : null;
  // Suppress red bubble when control is off and avg probe temp is already at or above setpoint.
  const _tAboveSetpoint =
    tState === false && _tSpF !== null && _tAvgF !== null && _tAvgF >= _tSpF;

  const _tInSpanMitg =
    (v.tempModuleStatus || "").toLowerCase() === "temp_span_mitg";
  const tBubbleState =
    tState === true
      ? "on"
      : tState === false &&
          !_tAtSetpoint &&
          !_tAboveSetpoint &&
          !ctrlInactive &&
          !manuallyPaused &&
          !_tInSpanMitg
        ? "error"
        : "off";
  const tEl = card.querySelector(".bubble-t");
  if (tEl && !tEl.classList.contains(tBubbleState)) {
    setBubble(card, ".bubble-t", "bubble bubble-t", tBubbleState);
  }
  setBubble(
    card,
    ".bubble-b",
    "bubble bubble-b",
    declogActive || ctrlInactive || manuallyPaused
      ? "off"
      : pressure > 9 && !rawBlowerOn
        ? "off"
        : blowerOn
          ? "on"
          : "stopped",
  );

  // DECLOG LABEL
  const declog = card.querySelector(".declog-label");
  if (declog) {
    if (declogActive) {
      const type = v.intake_declog_req === 1 ? "Int" : "Exh";
      declog.textContent = `${type} Declog Event`;
      declog.style.display = "block";
    } else {
      declog.style.display = "none";
      declog.textContent = "";
    }
  }

  // TELEMETRY READINGS
  const heaterReadingEl = card.querySelector(".heater-reading");
  const heaterF = toF(Number(t.heaterTemp));
  const heaterFormatted = `${format(heaterF)}&nbsp;&deg;F`;
  if (heaterReadingEl) {
    if (heaterF !== null && heaterF < 100) {
      heaterReadingEl.innerHTML = `<span class="heater-low">${heaterFormatted}</span>`;
    } else {
      heaterReadingEl.innerHTML = heaterFormatted;
    }
  }

  const t0 = card.querySelector(".t0-value");
  if (t0) t0.innerHTML = `${format(toF(t.temp0))}&nbsp;&deg;F`;
  const t1 = card.querySelector(".t1-value");
  if (t1) t1.innerHTML = `${format(toF(t.temp1))}&nbsp;&deg;F`;
  const t2 = card.querySelector(".t2-value");
  if (t2) t2.innerHTML = `${format(toF(t.temp2))}&nbsp;&deg;F`;

  const t0F = toF(Number(t.temp0));
  const t1F = toF(Number(t.temp1));
  const t2F = toF(Number(t.temp2));

  const probeTemps = [t0F, t1F, t2F].filter((v) => v !== null && !isNaN(v));

  let probeDeltaAlarm = false;

  if (probeTemps.length === 3) {
    const max = Math.max(...probeTemps);
    const min = Math.min(...probeTemps);
    const delta = max - min;
    const inSpanMitg =
      (v.tempModuleStatus || "").toLowerCase() === "temp_span_mitg";

    // ALARM: only highlight and flag when the hardware is in temp_span_mitg
    // AND the spread between probes is 8°F or more.
    if (delta >= 8 && inSpanMitg) {
      probeDeltaAlarm = true;

      // AUTO EXPAND PROBES
      if (!probesUserToggled) {
        colVisibility["probes"] = true;
        applyColVisibility();
        syncAllToggleButtons();
      }

      // HIGHLIGHT ALL THREE PROBE VALUES
      card.querySelector(".t0-value")?.classList.add("temp-span-alarm");
      card.querySelector(".t1-value")?.classList.add("temp-span-alarm");
      card.querySelector(".t2-value")?.classList.add("temp-span-alarm");
    } else {
      card.querySelector(".t0-value")?.classList.remove("temp-span-alarm");
      card.querySelector(".t1-value")?.classList.remove("temp-span-alarm");
      card.querySelector(".t2-value")?.classList.remove("temp-span-alarm");
    }
  } else {
    // Fewer than 3 probes — always clear any stale highlights
    card.querySelector(".t0-value")?.classList.remove("temp-span-alarm");
    card.querySelector(".t1-value")?.classList.remove("temp-span-alarm");
    card.querySelector(".t2-value")?.classList.remove("temp-span-alarm");
  }

  if (probeDeltaAlarm) {
    probeIssuesGlobal.add(slotName);
  } else {
    probeIssuesGlobal.delete(slotName);
  }

  const sp = v.setpoints || {};
  const tempSpF = typeof sp.tempSp === "number" ? sp.tempSp : null;
  const tempReadingEl = card.querySelector(".temp-reading");
  const _tFVal = toF(t.processTemp);
  const _tRedAlarm = typeof _tFVal === "number" && _tFVal > 145;
  const _tOrangeAlarm =
    !_tRedAlarm &&
    typeof _tFVal === "number" &&
    tempSpF !== null &&
    _tFVal >= tempSpF + 5;
  // Green when temp is within 2°F below the setpoint (or above, up to the orange threshold).
  const _tShowGreen =
    !_tRedAlarm &&
    !_tOrangeAlarm &&
    tempSpF !== null &&
    typeof _tFVal === "number" &&
    _tFVal >= tempSpF - 2;
  const _tLiveClass = _tShowGreen ? " temp-setpoint-reached" : "";
  const _tAlarmClass = _tRedAlarm
    ? " temp-thermal-runaway"
    : _tOrangeAlarm
      ? " temp-overshoot"
      : "";
  const _tBeacon = _tRedAlarm ? " 🚨" : _tOrangeAlarm ? " ⚠️" : "";
  tempReadingEl.innerHTML = `<span class="temp-live${_tLiveClass}${_tAlarmClass}">${format(_tFVal)}&nbsp;&deg;F</span>${_tBeacon}`;
  const tempSpEl = card.querySelector(".temp-sp");
  if (tempSpEl) {
    tempSpEl.textContent = tempSpF !== null ? `${tempSpF}°F` : "";
    tempSpEl.classList.toggle("temp-setpoint-reached", _tShowGreen);
    // Store last-set data for hover tooltip (populated from HMI scrape)
    const lts = v.lastTempSet;
    tempSpEl.dataset.lastTempValue = lts?.value || "";
    tempSpEl.dataset.lastTempSecondary = lts?.secondary || "";
  }

  const airflowSpVal = typeof sp.airflowSp === "number" ? sp.airflowSp : null;
  const airflowEl = card.querySelector(".airflow-reading");
  const lowAirflow = blowerOn && airflow < 30 && pressure <= 9 && !declogActive;
  if (airflowEl) {
    airflowEl.textContent = `${format(airflow)} l/min`;
    airflowEl.style.color = lowAirflow ? "orange" : "";
  }
  const airflowSpEl = card.querySelector(".airflow-sp");
  if (airflowSpEl)
    airflowSpEl.textContent =
      airflowSpVal !== null ? `${airflowSpVal} l/min` : "";

  const motorSpVal = typeof sp.motorSp === "number" ? sp.motorSp : null;
  const angleReadingEl = card.querySelector(".angle-reading");
  if (angleReadingEl) {
    angleReadingEl.textContent = format(currentAngle);
    if (mixerStopped) {
      const stoppedSpan = document.createElement("span");
      stoppedSpan.className = "mixer-stopped";
      stoppedSpan.textContent = "STOPPED";
      angleReadingEl.appendChild(stoppedSpan);
    }
  }
  const motorSpEl = card.querySelector(".motor-sp");
  if (motorSpEl)
    motorSpEl.textContent = motorSpVal !== null ? `${motorSpVal} R/hr` : "";
  card.querySelector(".mass-reading").textContent =
    `${format(toLbs(t.mass))} lbs`;
  const mechStatus = v.mechanicalStatus || "";
  const tms = v.tempModuleStatus || "";
  const mechReadingEl = card.querySelector(".mechstatus-reading");
  const tempModEl = card.querySelector(".tempmod-reading");

  const suppressRunning = mechStatus.toLowerCase() === "running" && !mixerOn;
  const mechReadingText = mechStatus && !suppressRunning ? mechStatus : "—";
  mechReadingEl.textContent = mechReadingText;
  mechReadingEl.classList.toggle(
    "status-stopped",
    mechReadingText.toLowerCase() === "stopped",
  );
  const mechLabelEl = card.querySelector(".mechstatus-label");
  if (mechLabelEl) mechLabelEl.textContent = "Status1:";
  if (tempModEl) {
    const tempModText = tms || "—";
    tempModEl.textContent = tempModText;
    tempModEl.classList.toggle(
      "status-temp-span-mitg",
      tms.toLowerCase() === "temp_span_mitg",
    );
    tempModEl.classList.toggle(
      "status-stopped",
      tms.toLowerCase() === "stopped",
    );
  }

  const statusValue = card.querySelector(".status-value");
  if (statusValue) {
    statusValue.textContent = v.valveModuleStatus || "—";
    statusValue.classList.toggle(
      "status-valve-fault",
      v.valveModuleStatus === "VALVE_FAULT",
    );
  }

  // Sparkline canvas is updated by updateSparklineBuffers() after each
  // updateAttentionList() call so issue state is current when data is pushed.
  /*
  //for testing
  _log(
    `🎯 ${slotName}`,
    "tempControlOn:",
    v.tempControlOn,
    "tempModuleStatus:",
    v.tempModuleStatus,
  );
  */

  // ═══ NAME BADGE (top-left) + DAYS BADGE (top-right) ═══════════════════════
  const _nameBadge = card.querySelector(".name-badge");
  const _daysBadge = card.querySelector(".days-badge");

  if (!hasVessel) {
    if (_nameBadge) _nameBadge.style.display = "none";
    if (_daysBadge) _daysBadge.style.display = "none";
  } else {
    // Last name from hall-view case name scrape (e.g. "John Smith" → "Smith").
    // caseName is a multi-word person name; split and take the last word.
    const _caseName = (v.caseName || "").trim();
    const _lastName = _caseName.length > 0 ? _caseName.split(/\s+/).pop() : "";

    if (_nameBadge) {
      if (_lastName) {
        _nameBadge.textContent = _lastName;
        _nameBadge.style.display = "";
      } else {
        _nameBadge.style.display = "none";
      }
    }

    // Days — prefer HMI hall-view scrape (exact), fall back to last_used calc.
    if (_daysBadge) {
      let _days = null;
      if (v.scrapedDays != null) {
        _days = v.scrapedDays;
      } else {
        const _lu = v.lastUsed ? new Date(v.lastUsed) : null;
        if (_lu && !isNaN(_lu)) {
          const _startLocal = new Date(
            _lu.getFullYear(),
            _lu.getMonth(),
            _lu.getDate(),
          );
          const _todayLocal = new Date();
          _todayLocal.setHours(0, 0, 0, 0);
          _days = Math.round((_todayLocal - _startLocal) / 86400000);
        }
      }
      if (_days != null) {
        _daysBadge.textContent = `${_days} days`;
        _daysBadge.style.display = "";
      } else {
        _daysBadge.style.display = "none";
      }
    }
  }
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══ UPTIME PROTOTYPE — update badge with live data ════════════════════════
  if (UPTIME_PROTO_ENABLED) {
    const _badge = card.querySelector(".uptime-proto");
    if (_badge) {
      _badge.classList.toggle("compact", !colVisibility["probes"]);

      const _pct =
        hasVessel && v.motorUptimePct != null ? v.motorUptimePct : null;
      const _pctStr = _pct != null ? _pct.toFixed(1) : "—";
      const _color =
        _pct == null
          ? "#666"
          : _pct >= 90
            ? "#2ecc71"
            : _pct >= 75
              ? "#f39c12"
              : "#e74c3c";

      // SVG arc
      const _arc = _badge.querySelector(".uptime-proto-arc");
      if (_arc) {
        const _circ =
          parseFloat(_arc.getAttribute("stroke-dasharray")) || 113.1;
        _arc.setAttribute(
          "stroke-dashoffset",
          _pct != null
            ? (_circ * (1 - _pct / 100)).toFixed(2)
            : _circ.toFixed(2),
        );
        _arc.style.stroke = _color;
      }

      // Graphic mode text
      const _numEl = _badge.querySelector(".uptime-proto-num");
      if (_numEl) _numEl.textContent = _pct != null ? _pct.toFixed(1) : "—";
      const _symEl = _badge.querySelector(".uptime-proto-sym");
      if (_symEl) _symEl.style.display = _pct != null ? "" : "none";

      // Compact text — firstChild is the text node, secondChild is the % span
      const _compEl = _badge.querySelector(".uptime-proto-compact");
      if (_compEl) {
        if (_compEl.firstChild?.nodeType === Node.TEXT_NODE)
          _compEl.firstChild.textContent = _pct != null ? _pct.toFixed(1) : "—";
        const _pctSpan = _compEl.querySelector(".uptime-proto-compact-pct");
        if (_pctSpan) _pctSpan.style.display = _pct != null ? "" : "none";
        _compEl.style.color = _color;
      }
    }
  }
  // ════════════════════════════════════════════════════════════════════════════

  // PHASE PROGRESS BAR — 4 pill segments below the card bottom border.
  // Filled pills show the phase color; empty pills show the card border color
  // so all 4 segments are always visible as a dim track.
  //   seg 1 = Biofirst (yellow)   seg 2 = PFRP (orange)
  //   seg 3 = Compost  (white)    seg 4 = Dry Down (gray)
  const _PHASE_SEG_COLORS = ["#ffd966", "#f4a030", "#ffffff", "#999999"];
  card.style.background = ""; // clear any legacy card tint
  const _phaseHex  = slotColors[slotName];
  const _phaseSegs = _hexToPhaseSegments(_phaseHex);

  // Remove stale bar from previous render cycle
  card.querySelector(".phase-bar")?.remove();

  card.style.borderBottomColor = _phaseSegs > 0 ? "transparent" : "";
  if (_phaseSegs > 0) {
    const _bar = document.createElement("div");
    _bar.className = "phase-bar";
    _bar.style.cssText = "position:absolute;bottom:-3px;left:2px;right:2px;height:5px;display:flex;gap:2px;pointer-events:none;z-index:2;";
    for (let i = 0; i < 4; i++) {
      const _pill = document.createElement("div");
      _pill.style.cssText = `flex:1;border-radius:3px;background:${i < _phaseSegs ? _PHASE_SEG_COLORS[i] : "var(--bg)"};`;
      _bar.appendChild(_pill);
    }
    card.appendChild(_bar);
  }

  // Ensure name badge is unstyled (no leftover pill coloring)
  if (_nameBadge) {
    _nameBadge.style.background  = "";
    _nameBadge.style.color       = "";
    _nameBadge.style.borderColor = "";
  }
}

//COLUMN PAUSE STATE SYNC
// Lights up the column header button whenever a column is paused —
// either because the HMI reports mechanicalStatus containing "PAUSE"
// for any slot in that column, or because the dashboard sent a pause
// command (optimistic, until HMI state confirms and takes over).
function syncColumnPauseState() {
  document.querySelectorAll(".column-pause-btn").forEach((btn) => {
    const col = parseInt(btn.dataset.column, 10);
    const hmiPaused = Object.values(state).some(
      (v) => v.column === col && v.rackGroupPaused === true,
    );
    const paused = hmiPaused || dashboardPausedColumns.has(col);
    // If the HMI has picked up the pause, the dashboard tracker is no longer needed.
    if (hmiPaused) dashboardPausedColumns.delete(col);
    btn.classList.toggle("paused", paused);
    btn.disabled = paused;
    if (paused) {
      btn.innerHTML = `Rack ${col} Paused`;
      btn.title = `Rack ${col} is PAUSED`;
    } else {
      btn.innerHTML = `${col}`;
      btn.title = `Pause rack ${col}`;
    }
  });
}

/* RENDER (NO DOM REPLACEMENT) */
function render() {
  const ordered = Object.entries(state).sort((a, b) => {
    const va = a[1] || {};
    const vb = b[1] || {};
    const colA = va.column || 0;
    const colB = vb.column || 0;
    if (colA !== colB) return gridReversed ? colB - colA : colA - colB;
    return (va.row || 0) - (vb.row || 0);
  });

  for (const [slotName, v] of ordered) {
    updateCard(slotName, v);
  }

  ordered.forEach(([slotName], i) => {
    const card = cardMap.get(slotName);
    if (!card) return;

    if (gridEl.children[i] !== card) {
      gridEl.insertBefore(card, gridEl.children[i] || null);
    }
  });

  updateLastUpdated();
  applyVesselHighlight();
}

//Re-query background state and merge into local state.
// Called a few seconds after the initial render to pick up WS telemetry
// that arrives while the service worker is warming up.
function pollStateUpdate() {
  chrome.runtime.sendMessage({ type: "dashboard:get" }, (resp) => {
    if (chrome.runtime.lastError) return;
    if (!resp || !resp.state || Object.keys(resp.state).length === 0) return;
    let changed = false;
    for (const [slot, vessel] of Object.entries(resp.state)) {
      if (!state[slot]) {
        state[slot] = vessel;
        createCard(slot);
        changed = true;
      } else {
        const { telemetry: remoteTelemetry, ...rest } = vessel;
        const localEmpty = state[slot].vesselPresent === false;
        const remoteEmpty = rest.vesselPresent === false;

        if (remoteEmpty) {
          // Background confirms empty — apply full clearing logic, but only if
          // this is new information (avoid redundant renders).
          if (!localEmpty) {
            Object.assign(state[slot], rest);
            state[slot].vesselPresent = false;
            state[slot].telemetry = {};
            state[slot].setpoints = {};
            state[slot].lastTempSet = null;
            state[slot].tempControlOn = null;
            changed = true;
          }
        } else if (!localEmpty) {
          // Both local and remote agree slot is occupied — safe to merge.
          // Setpoints and non-telemetry fields always update (fixes the case where
          // setpoints arrive after local WS telemetry is newer than background's).
          Object.assign(state[slot], rest);

          // Only overwrite live telemetry when the background snapshot is fresher
          // or the local slot has no telemetry yet.
          const localTs = state[slot].telemetry?.lastUpdate;
          const remoteTs = remoteTelemetry?.lastUpdate;
          if (!localTs || (remoteTs && remoteTs >= localTs)) {
            if (remoteTelemetry) state[slot].telemetry = remoteTelemetry;
          }

          changed = true;
        }
        // else: localEmpty && !remoteEmpty — local already confirmed slot is empty
        // via a push message; remote snapshot is stale (captured before refreshRackState
        // updated dashboardState). Do not merge — would re-populate a cleared slot.
      }
    }
    if (changed) scheduleRender();
  });
}

/* INITIAL LOAD */
function loadInitialState() {
  chrome.runtime.sendMessage({ type: "dashboard:get" }, (resp) => {
    if (chrome.runtime.lastError) {
      setTimeout(loadInitialState, 500);
      return;
    }
    if (!resp || !resp.state || Object.keys(resp.state).length === 0) {
      _log("⏳ Waiting for state...");
      setTimeout(loadInitialState, 500);
      return;
    }
    state = resp.state;
    window.state = state; // alias for console debugging
    _log("✅ Initial state loaded", state);
    unrackedVessels = resp.unrackedVessels || [];
    slotColors = resp.slotColors || {};
    renderUnrackedStrip();

    // Trigger immediate setpoint collection so T bubbles and setpoints
    // are populated right away rather than waiting for the background's
    // 5-second startup timer or 5-minute interval.
    chrome.runtime
      .sendMessage({ type: "dashboard:refresh-setpoints" })
      .catch(() => {});

    // PRE-CREATE ALL CARDS IN SORTED ORDER
    const sortedSlots = Object.entries(state)
      .sort(([, a], [, b]) => {
        if ((a.column || 0) !== (b.column || 0))
          return (a.column || 0) - (b.column || 0);
        return (a.row || 0) - (b.row || 0);
      })
      .map(([name]) => name);
    for (const slotName of sortedSlots) {
      createCard(slotName);
    }

    scheduleRender();

    // Show the connection banner immediately.
    // Dismissed only after BOTH WS telemetry and a fresh HMI pause-state sync complete.
    _showWsBanner();

    // Request a fresh sync from the background. The response comes back as
    // an hmi:sync-complete message once syncRackPauseState() finishes.
    chrome.runtime
      .sendMessage({ type: "dashboard:request-pause-sync" })
      .catch(() => {});

    // Safety fallback: dismiss after 20 s in case the HMI tab is not open
    // and the sync signal never arrives.
    setTimeout(() => {
      _hmiSyncReceived = true;
      _checkBannerDone();
    }, 20000);

    // Re-query continuously to pick up WS data / setpoints that arrive
    // while the service worker is warming up after a restart.
    // Runs every 5 s for the first 60 s, then every 60 s ongoing.
    setTimeout(pollStateUpdate, 2000);
    let _quickPollCount = 0;
    const _quickPollTimer = setInterval(() => {
      pollStateUpdate();
      if (++_quickPollCount >= 12) {
        clearInterval(_quickPollTimer);
        setInterval(pollStateUpdate, 60000);
      }
    }, 5000);
  });
}

loadInitialState();

// Detect local IP via WebRTC and report to background so it can determine
// whether this machine is the designated watchdog host (192.168.50.176).
(function detectAndReportIp() {
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("");
    pc.createOffer().then((sdp) => pc.setLocalDescription(sdp));
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(candidate.candidate);
      if (m && !m[1].startsWith("127.") && !m[1].startsWith("169.254")) {
        chrome.runtime.sendMessage({ type: "machine:ip", ip: m[1] });
        pc.close();
      }
    };
  } catch (e) {
    _log("⚠️ IP detection failed:", e.message);
  }
})();

// vessel search
const searchInput = document.getElementById("vessel-search-input");
const resetBtn = document.getElementById("vessel-search-reset");

if (searchInput && resetBtn) {
  searchInput.addEventListener("input", (e) => {
    vesselSearchTerm = e.target.value.trim().toLowerCase();
    applyVesselHighlight();
  });

  resetBtn.addEventListener("click", () => {
    vesselSearchTerm = "";
    searchInput.value = "";
    applyVesselHighlight();
  });
}

//highlight border of vessel search
function applyVesselHighlight() {
  const term = vesselSearchTerm;

  document.querySelectorAll(".card").forEach((card) => {
    const name = card.dataset.name || "";
    if (term && name.includes(term)) {
      card.classList.add("vessel-highlight");
    } else {
      card.classList.remove("vessel-highlight");
    }
  });

  document.querySelectorAll(".unracked-card").forEach((card) => {
    const name = card.dataset.name || "";
    if (term && name.includes(term)) {
      card.classList.add("vessel-highlight");
    } else {
      card.classList.remove("vessel-highlight");
    }
  });
}

function renderUnrackedStrip() {
  const strip = document.getElementById("unracked-strip");
  const namesEl = document.getElementById("unracked-names");
  if (!strip || !namesEl) return;

  namesEl.textContent = "";

  if (!unrackedVessels.length) {
    strip.style.display = "none";
    return;
  }

  strip.style.display = "flex";

  const label = document.getElementById("unracked-label");
  if (label)
    label.textContent = `(${unrackedVessels.length}) Vessels not in use:`;

  unrackedVessels.forEach((v) => {
    const card = document.createElement("div");
    card.className = "unracked-card";
    card.dataset.name = (v.name ?? "").toLowerCase();
    card.textContent = v.name ?? String(v.id);
    namesEl.appendChild(card);
  });

  applyVesselHighlight();
}

/* UPDATES */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "hmi:sync-complete") {
    _hmiSyncReceived = true;
    _checkBannerDone();
    return;
  }

  if (msg.type === "dashboard:unracked-update") {
    unrackedVessels = msg.unrackedVessels || [];
    renderUnrackedStrip();
    return;
  }

  if (msg.type === "dashboard:colors-update") {
    slotColors = msg.colors || {};
    scheduleRender();
    return;
  }

  if (msg.type === "dashboard:update") {
    if (!state[msg.slotName]) state[msg.slotName] = {};

    const incoming = msg.vessel || {};

    // API is authoritative: if it reports no vessel, clear all stale data
    if (incoming.vesselPresent === false) {
      Object.assign(state[msg.slotName], incoming);
      state[msg.slotName].vesselPresent = false;
      state[msg.slotName].telemetry = {};
      state[msg.slotName].setpoints = {};
      state[msg.slotName].lastTempSet = null;
      state[msg.slotName].tempControlOn = null;
      scheduleRender();
      return;
    }

    Object.assign(state[msg.slotName], incoming);

    // Only derive vessel presence when the background didn't supply an explicit
    // value. dashboardState always sets vesselPresent from the REST API, so
    // incoming.vesselPresent is authoritative. Deriving from empty telemetry
    // (before WS data arrives) wrongly returns false and causes pollStateUpdate
    // to treat the slot as locally empty, blocking all subsequent merges.
    const v = state[msg.slotName];
    if (incoming.vesselPresent == null) {
      const t = v.telemetry || {};
      const next = deriveVesselPresence(v, t);
      if (v.vesselPresent !== next) v.vesselPresent = next;
    }

    lastHeartbeat = Date.now();
    lastWsMessage = Date.now();
    isConnected = true;

    // Mark WS data as received; banner dismisses only when HMI sync is also done.
    if (incoming.telemetry?.lastUpdate) {
      _wsDataReceived = true;
      _checkBannerDone();
    }

    scheduleRender();
  }
});

/* HEARTBEAT */
setInterval(() => {
  const delta = Date.now() - lastHeartbeat;
  heartbeatEl.style.background = delta < 3000 ? "#0f0" : "#700";
}, 500);

/* COLUMN VISIBILITY TOGGLES */
const colVisibility = {
  "mass-row": false,
  probes: false,
  "mechstatus-row": true,
  "motor-row": true,
};

function applyColVisibility() {
  document.querySelectorAll(".mass-row").forEach((el) => {
    el.style.display = colVisibility["mass-row"] ? "flex" : "none";
  });
  document.querySelectorAll(".t0-row, .t1-row, .t2-row").forEach((el) => {
    el.style.display = colVisibility["probes"] ? "flex" : "none";
  });
  const showMechStatus = colVisibility["mechstatus-row"];
  document
    .querySelectorAll(".mechstatus-row:not(.tempmod-row)")
    .forEach((el) => {
      el.style.display = showMechStatus ? "" : "none";
    });
  document.querySelectorAll(".tempmod-row").forEach((el) => {
    el.style.display = showMechStatus ? "" : "none";
  });
  document.querySelectorAll(".motor-row").forEach((el) => {
    el.style.display = colVisibility["motor-row"] ? "flex" : "none";
  });
}

document.querySelectorAll(".col-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;

    // toggle the column
    colVisibility[target] = !colVisibility[target];

    // track user override ONLY for probes
    if (target === "probes") {
      probesUserToggled = true;
    }

    applyColVisibility();
    syncAllToggleButtons();
    scheduleRender();
  });
});

function syncAllToggleButtons() {
  document.querySelectorAll(".col-toggle").forEach((btn) => {
    const target = btn.dataset.target;

    if (colVisibility[target]) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

/* ZOOM TOGGLE */
const zoomToggle = document.getElementById("zoom-toggle");
const gridWrapper = document.getElementById("grid-wrapper");
let isZoomed = localStorage.getItem("zoom") !== "false";
if (isZoomed) {
  zoomToggle.textContent = "🔍− Normal View";
  document.body.classList.add("zoom-fit");
}

function applyZoom() {
  const content = document.getElementById("kiosk-anim-wrap");
  const root = document.documentElement;

  const gridMarginTop =
    parseFloat(getComputedStyle(root).getPropertyValue("--grid-margin-top")) ||
    220;

  const bottomPanel = document.getElementById("bottom-panel");
  const bottomH = bottomPanel ? bottomPanel.offsetHeight : 0;

  // Available vertical space
  const usableH = window.innerHeight - gridMarginTop - bottomH - 16;

  // Handle margin collapse behavior
  const wrapperTop = content.offsetTop;
  const internalOffset = Math.max(0, gridMarginTop - wrapperTop);

  const contentH = Math.max(1, content.scrollHeight - internalOffset);

  const scaleX = window.innerWidth / content.scrollWidth;
  const scaleY = usableH / contentH;

  // In kiosk mode allow up to 2× upscaling so cards fill the screen at 50% browser zoom
  const scale = Math.min(_kioskModeActive ? 2 : 1, scaleX, scaleY);

  const tx = 0;
  const scaledH = contentH * scale;

  // 40% bias places grid slightly above true center.
  // #grid-wrapper is overflow:visible so the body clips instead — no bottom cutoff.
  const ty =
    internalOffset * (1 - scale) + Math.max(0, (usableH - scaledH) * 0.4);

  content.style.transformOrigin = "top left";
  content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;

  // Headers are inside content now — no separate transform
  if (typeof columnHeadersEl !== "undefined" && columnHeadersEl) {
    columnHeadersEl.style.transform = "";
    columnHeadersEl.style.transformOrigin = "";
  }

  document.body.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";
}

function resetZoom() {
  const _kioskWrap = document.getElementById("kiosk-anim-wrap");
  if (_kioskWrap) {
    _kioskWrap.style.transform = "";
    _kioskWrap.style.transformOrigin = "";
  }
  gridWrapper.style.transform = "";
  gridWrapper.style.transformOrigin = "";
  if (columnHeadersEl) {
    columnHeadersEl.style.transform = "";
    columnHeadersEl.style.transformOrigin = "";
  }
  document.body.style.overflow = "";
  document.body.style.overflowX = "";
  document.body.style.overflowY = "";
  // Restore viewport scrolling (locked by applyZoom / kiosk modes)
  document.documentElement.style.overflow = "";
}

zoomToggle.addEventListener("click", () => {
  isZoomed = !isZoomed;
  localStorage.setItem("zoom", isZoomed);
  if (isZoomed) {
    // Apply class first so CSS is in the correct state when applyZoom reads dimensions
    document.body.classList.add("zoom-fit");
    zoomToggle.textContent = "🔍− Normal View";
    // Defer one frame so the browser has painted the new class before we measure
    requestAnimationFrame(applyZoom);
  } else {
    document.body.classList.remove("zoom-fit");
    zoomToggle.textContent = "🔍+ Fit All";
    resetZoom();
  }
});

window.addEventListener("resize", () => {
  // Refresh --grid-margin-top before any zoom calc so dynamic attention list
  // heights are reflected correctly after fullscreen toggles.
  if (_updateHeaderZone) _updateHeaderZone();
  if (issuesModeActive) {
    _kioskZoomToVisibleCards();
    return;
  }
  if (isZoomed) applyZoom();
});

/* FLEET SPARKLINE STRIP INIT */
initFleetSparklineStrip();

// Collect sparkline data on a plain interval so it keeps ticking even when
// the tab is hidden (requestAnimationFrame is throttled by the browser when
// the page is not visible, which caused the sparkline to stall).
setInterval(() => updateSparklineBuffers(), SPARKLINE_INTERVAL_MS);

// Re-render immediately when the user returns to the tab so the display
// reflects all the data collected while it was hidden.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) _renderFleetSparkline();
});

/* HEADER DRAG HANDLE INIT */
initHeaderDragHandle();

/* THEME TOGGLE */
const themeToggle = document.getElementById("theme-toggle");

if (localStorage.getItem("theme") === "dark") {
  document.documentElement.classList.add("dark");
  themeToggle.textContent = "☀️";
}

themeToggle.addEventListener("click", () => {
  const root = document.documentElement;
  if (root.classList.contains("dark")) {
    root.classList.remove("dark");
    localStorage.setItem("theme", "light");
    themeToggle.textContent = "🌙";
  } else {
    root.classList.add("dark");
    localStorage.setItem("theme", "dark");
    themeToggle.textContent = "☀️";
  }
});

/* GRID REVERSE TOGGLE */
const gridReverseToggle = document.getElementById("grid-reverse-toggle");

function applyGridReverse() {
  if (gridReversed) {
    gridReverseToggle.classList.add("active");
  } else {
    gridReverseToggle.classList.remove("active");
  }
  renderColumnHeaders();
  render();
}

gridReverseToggle.addEventListener("click", () => {
  gridReversed = !gridReversed;
  localStorage.setItem("gridReversed", gridReversed);

  const animWrap = document.getElementById("kiosk-anim-wrap");

  // Rotate around the horizontal center of the viewport, not the grid element
  const pageCenterX = window.innerWidth / 2;
  const elemLeft = animWrap.getBoundingClientRect().left;
  animWrap.style.transformOrigin = `${pageCenterX - elemLeft}px center`;

  animWrap.classList.add("flip-animating");

  // Re-render at the midpoint (when grid is edge-on and invisible)
  setTimeout(() => applyGridReverse(), 275);

  animWrap.addEventListener(
    "animationend",
    () => animWrap.classList.remove("flip-animating"),
    { once: true },
  );
});

if (gridReversed) applyGridReverse();

/* ISSUES-ONLY VIEW TOGGLE (non-kiosk) */
const issuesModeBtn = document.getElementById("issues-mode-toggle");
const issuesFilterBar = document.getElementById("issues-filter-bar");

// Continuous re-fit interval for the non-kiosk filter-issues view
let _filterIssuesRefitInterval = null;
function _startFilterIssuesRefit() {
  if (_filterIssuesRefitInterval) return;
  _filterIssuesRefitInterval = setInterval(() => {
    if (issuesModeActive && !_kioskModeActive) _kioskZoomToVisibleCards();
    else _stopFilterIssuesRefit();
  }, 1500);
}
function _stopFilterIssuesRefit() {
  clearInterval(_filterIssuesRefitInterval);
  _filterIssuesRefitInterval = null;
}

function _syncIssuesFilterOffset() {
  const h =
    issuesModeActive && issuesFilterBar ? issuesFilterBar.offsetHeight : 0;
  document.documentElement.style.setProperty(
    "--issues-filter-bar-height",
    h + "px",
  );
}

if (issuesModeBtn) {
  issuesModeBtn.addEventListener("click", () => {
    issuesModeActive = !issuesModeActive;
    document.body.classList.toggle("issues-mode", issuesModeActive);
    issuesModeBtn.classList.toggle("active", issuesModeActive);
    issuesModeBtn.textContent = issuesModeActive
      ? "↩ Return to Grid View"
      : "⚠ Filter by Issues";
    if (issuesFilterBar)
      issuesFilterBar.style.display = issuesModeActive ? "flex" : "none";
    // Measure after paint so offsetHeight reflects the rendered bar
    requestAnimationFrame(_syncIssuesFilterOffset);
    applyIssuesFilter();

    if (issuesModeActive) {
      // Lock scroll — cards auto-fit to the viewport (no scrolling needed)
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      _startFilterIssuesRefit();
      requestAnimationFrame(() => _kioskZoomToVisibleCards());
    } else {
      // Restore normal scrollable view
      _stopFilterIssuesRefit();
      const kioskAnim = document.getElementById("kiosk-anim-wrap");
      if (kioskAnim) {
        kioskAnim.style.transform = "";
        kioskAnim.style.transformOrigin = "";
      }
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      if (isZoomed) requestAnimationFrame(applyZoom);
    }
  });
}

document.querySelectorAll(".issues-chip[data-filter]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const f = chip.dataset.filter;
    if (issuesFilterActive.has(f)) issuesFilterActive.delete(f);
    else issuesFilterActive.add(f);
    chip.classList.toggle("active", issuesFilterActive.has(f));
    applyIssuesFilter();
  });
});

const issuesClearBtn = document.getElementById("issues-chip-clear");
if (issuesClearBtn) {
  issuesClearBtn.addEventListener("click", () => {
    issuesFilterActive.clear();
    document.querySelectorAll(".issues-chip[data-filter]").forEach((c) => {
      c.classList.remove("active");
    });
    applyIssuesFilter();
  });
}

/* RESTART ALL RACKS */
let _restartAllAborted = false;

function _showStopBtn(visible) {
  const stopBtn = document.getElementById("stop-all-racks");
  if (stopBtn) stopBtn.style.display = visible ? "" : "none";
}

async function restartAllRacks() {
  const btn = document.getElementById("restart-all-racks");
  if (btn) btn.disabled = true;

  _restartAllAborted = false;
  _showStopBtn(true);

  showRestartStatus("⟳ Restart All: collecting current state…");
  showSetpointToast("\u27f3 Restart All: collecting current state\u2026");

  // Kick off a fresh setpoint collection so we have up-to-date data.
  chrome.runtime
    .sendMessage({ type: "dashboard:refresh-setpoints" })
    .catch(() => {});

  // Wait for API data to arrive before evaluating slot states.
  await new Promise((r) => setTimeout(r, 5000));

  if (_restartAllAborted) {
    showRestartStatus("⛔ Restart All: stopped.", true);
    showSetpointToast("\u26d4 Restart All: stopped.");
    if (btn) btn.disabled = false;
    _showStopBtn(false);
    return;
  }

  const occupied = Object.keys(state).filter((slot) => {
    const v = state[slot];
    if (!v || v.vesselPresent === false || v.vesselId == null) return false;
    return (v.mechanicalStatus || "").toLowerCase() !== "wait_vessel";
  });

  showRestartStatus(`⟳ Restart All: evaluating ${occupied.length} slot(s)…`);
  showSetpointToast(
    `\u27f3 Restart All: evaluating ${occupied.length} slot(s)\u2026`,
  );

  const slotTasks = occupied.map((slot, i) => {
    if (_restartAllAborted) return Promise.resolve({ slot, aborted: true });

    const v = state[slot];
    const motorRunning = isMotorRunning(slot);
    const tempOn = isTempControlOn(slot);

    const needsMotor = !motorRunning;
    // null = unknown — conservatively treat as needing to start
    const needsTemp = tempOn !== true;

    // Fault detection — determines which setpoints the hardware can accept.
    // wasUserPaused: ctrl_inactive was caused by an operator pause, not a hardware fault.
    const ctrlInactive = (v.mechanicalStatus || "")
      .toLowerCase()
      .includes("ctrl_inactive");
    const wasUserPaused = v.rackGroupPaused === true;
    const tempSpanMitg =
      (v.tempModuleStatus || "").toLowerCase() === "temp_span_mitg";

    const sendMotor = needsMotor && (!ctrlInactive || wasUserPaused);
    // Blower indicator in the HMI can falsely report ON — always send blower.
    const sendBlower = true;
    const sendTemp =
      needsTemp && (!ctrlInactive || wasUserPaused) && !tempSpanMitg;

    const skipped = [];
    if (needsMotor && ctrlInactive && !wasUserPaused)
      skipped.push("motor (ctrl_inactive)");
    if (needsTemp && ctrlInactive && !wasUserPaused)
      skipped.push("temp (ctrl_inactive)");
    if (needsTemp && tempSpanMitg && (!ctrlInactive || wasUserPaused))
      skipped.push("temp (temp_span_mitg)");

    // Use the last known temp setpoint; fall back to default.
    const tempSp = v.setpoints?.tempSp ?? SP_DEFAULTS.temp;

    _log(
      `[restartAllRacks] ${slot} \u2014 motor:${motorRunning} tempOn:${tempOn} \u2192 sendMotor:${sendMotor} sendBlower:forced sendTemp:${sendTemp} ctrlInactive:${ctrlInactive} wasUserPaused:${wasUserPaused} tempSpanMitg:${tempSpanMitg}`,
    );

    return (async () => {
      await new Promise((r) => setTimeout(r, i * 150));
      if (sendMotor) {
        const storedMotorSp = v.setpoints?.motorSp ?? null;
        if (storedMotorSp !== null && storedMotorSp === SP_DEFAULTS.motor) {
          // Firmware ignores a setpoint equal to the stored value — send 0
          // first so the target value is accepted as a change.
          await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                type: "setpoint:set",
                slotName: slot,
                spType: "motor",
                value: 0,
              },
              (resp) => {
                if (chrome.runtime.lastError) {
                }
                resolve(resp);
              },
            );
          });
          await new Promise((r) => setTimeout(r, 1500));
        }
      }

      const result = await sequenceSetpoints(
        slot,
        {
          motor: sendMotor ? SP_DEFAULTS.motor : null,
          blower: sendBlower ? SP_DEFAULTS.blower : null,
          temp: sendTemp ? tempSp : null,
        },
        sendTemp,
        { doEscalation: false },
      );

      // Motor command was delivered — clear stale angle/motor tracking so the
      // next WS frame re-seeds the M bubble from commandIsOn instead of waiting
      // for a >10° angle delta (which is the page-refresh advantage).
      if (result.sent?.includes("motor")) {
        delete lastAngles[slot];
        motorActiveUntil[slot] = 0;
        motorSteadyGreen[slot] = false;
        if (motorStoppedTimer[slot]) {
          clearTimeout(motorStoppedTimer[slot]);
          motorStoppedTimer[slot] = null;
        }
        scheduleRender();
      }

      return { ...result, skipped };
    })();
  });

  let _doneCount = 0;
  const _totalCount = slotTasks.length;
  const results = await Promise.all(
    slotTasks.map((t) =>
      t.then((r) => {
        if (!_restartAllAborted) {
          _doneCount++;
          showRestartStatus(
            `⟳ Restart All: ${_doneCount}/${_totalCount} slots complete…`,
          );
        }
        return r;
      }),
    ),
  );

  if (!_restartAllAborted) {
    const active = results.filter((r) => !r.aborted);
    const fullySuccessful = active.filter(
      (r) => (r.warnings || []).length === 0 && (r.skipped || []).length === 0,
    );

    // Tally commands actually delivered to the HMI (response.ok from background).
    let motorSent = 0;
    let blowerSent = 0;
    let tempSent = 0;
    for (const r of active) {
      const s = r.sent || [];
      if (s.includes("motor")) motorSent++;
      if (s.includes("blower")) blowerSent++;
      if (s.includes("temp")) tempSent++;
    }

    // Bucket warnings by failure type. motor/blower timeouts mean the command
    // was delivered but state did not confirm; temp-ctrl failure means the
    // temp setpoint was NOT sent at all.
    const motorTOs = active.filter((r) =>
      (r.warnings || []).includes("motor timeout"),
    );
    const blowerTOs = active.filter((r) =>
      (r.warnings || []).includes("blower timeout"),
    );
    const tempCtrlFails = active.filter((r) =>
      (r.warnings || []).includes("temp-ctrl failed"),
    );
    const faultSkips = active.filter((r) => (r.skipped || []).length > 0);

    const parts = [];
    if (fullySuccessful.length > 0)
      parts.push(`\u2713 ${fullySuccessful.length} fully started`);
    parts.push(`cmds delivered: ${motorSent}m / ${blowerSent}b / ${tempSent}t`);
    if (motorTOs.length > 0)
      parts.push(
        `\u26a0 motor unconfirmed (cmd sent): ${motorTOs.map((r) => r.slot).join(", ")}`,
      );
    if (blowerTOs.length > 0)
      parts.push(
        `\u26a0 blower unconfirmed (cmd sent): ${blowerTOs.map((r) => r.slot).join(", ")}`,
      );
    if (tempCtrlFails.length > 0)
      parts.push(
        `\u2715 temp-ctrl failed (temp setpoint NOT sent): ${tempCtrlFails.map((r) => r.slot).join(", ")}`,
      );
    if (faultSkips.length > 0)
      parts.push(`\u2014 ${faultSkips.length} slot(s) with fault skip(s)`);

    const summary =
      active.length === 0
        ? "\u2713 Restart All: all slots already running"
        : `Restart All: ${parts.join(" | ")}`;

    showSetpointToast(summary);
    showRestartStatus(
      active.length === 0
        ? "✓ Restart All: all slots already running"
        : `✓ ${summary}`,
      true,
    );
  }

  if (btn) btn.disabled = false;
  _showStopBtn(false);

  // Re-sync HMI pause state now that racks have been restarted — clears
  // rackGroupPaused on all slots and updates column header buttons without
  // waiting for the 5-minute background polling interval.
  chrome.runtime
    .sendMessage({ type: "dashboard:request-pause-sync" })
    .catch(() => {});
}

const pauseAllBtn = document.getElementById("pause-all-racks");
if (pauseAllBtn) {
  pauseAllBtn.addEventListener("click", () => {
    openConfirmDialog(
      "Pause all racks?\n\nThis will pause every rack in the HMI.",
      "⏸ Pause All",
      () => {
        pauseAllBtn.disabled = true;
        chrome.runtime.sendMessage({ type: "pause-all-racks" }, (resp) => {
          if (chrome.runtime.lastError) {
            pauseAllBtn.disabled = false;
            return;
          }
          pauseAllBtn.disabled = false;
          if (resp?.ok) {
            showSetpointToast(
              `Pause sent to ${resp.clicked} rack${resp.clicked !== 1 ? "s" : ""}.`,
            );
          } else {
            showSetpointToast(
              "Pause failed: " + (resp?.error ?? "unknown error"),
              true,
            );
          }
        });
      },
    );
  });
}

const restartAllBtn = document.getElementById("restart-all-racks");
if (restartAllBtn) {
  restartAllBtn.addEventListener("click", () => {
    openConfirmDialog(
      "Restart all racks?\n\nThis will start the motor (60 R/hr), blower (65 l/min), and temp control at the last setpoint for every occupied slot that is not already running.",
      "🔄 Restart All",
      () => restartAllRacks(),
    );
  });
}

const stopAllBtn = document.getElementById("stop-all-racks");
if (stopAllBtn) {
  stopAllBtn.addEventListener("click", () => {
    _restartAllAborted = true;
    _showStopBtn(false);
    const restartBtn = document.getElementById("restart-all-racks");
    if (restartBtn) restartBtn.disabled = false;
    showRestartStatus("⛔ Restart All: stopped.", true);
  });
}

/* SPARKLINE UPTIME SCORE
   A metric is included in the average when it has an active issue OR is
   confirmed running. Metrics that are intentionally off are excluded so
   a vessel in a partial config isn't penalised for idle components.
   Returns 0.0–1.0, or 1.0 when every metric is idle (neutral). */
function computeVesselUptimeScore(slotName) {
  const v = state[slotName];
  if (!v) return null;
  const now = Date.now();
  const issues = slotActiveIssues.get(slotName);
  const scores = [];

  // Pressure — sensor is always active; always included so pressure alerts
  // always degrade the score regardless of other metric states.
  scores.push(issues?.has("pressure") ? 0 : 1);

  // Motor — included if confirmed moving, stopped unexpectedly, or has issue
  const motorIssue = issues?.has("motor") ?? false;
  const motorRunning =
    (motorActiveUntil[slotName] || 0) > now || !!motorSteadyGreen[slotName];
  const mixerCmd = (v.mixerModuleStatus || "").toUpperCase();
  const motorStuck = mixerCmd === "MIXER_STOPPED";
  if (motorIssue || motorRunning || motorStuck) {
    scores.push(motorIssue ? 0 : 1);
  }

  // Blower — included if recently active (150 s debounce) or has airflow issue
  const blowerIssue = issues?.has("airflow") ?? false;
  const blowerRunning = (blowerActiveUntil[slotName] || 0) > now;
  if (blowerIssue || blowerRunning) {
    scores.push(blowerIssue ? 0 : 1);
  }

  // Temp — included if HMI confirms control is ON or has temp issue
  const tempIssue = issues?.has("temp") ?? false;
  const tempOn = v.tempControlOn === true;
  if (tempIssue || tempOn) {
    scores.push(tempIssue ? 0 : 1);
  }

  // Probe delta — included alongside temp control
  const probeIssue = issues?.has("probe") ?? false;
  if (probeIssue || tempOn) {
    scores.push(probeIssue ? 0 : 1);
  }

  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/* FLEET SPARKLINE BUFFER UPDATE — runs after updateAttentionList() so slotActiveIssues is current */
function updateSparklineBuffers() {
  const now = Date.now();
  if (now - _sparklineLastUpdate < SPARKLINE_INTERVAL_MS) return;
  _sparklineLastUpdate = now;

  // Count vessels with at least one active issue this tick
  let issueCount = 0;
  let activeVessels = 0;
  for (const slotName of Object.keys(state)) {
    if (!slotHasVessel(slotName)) continue;
    activeVessels++;
    const issues = slotActiveIssues.get(slotName);
    if (issues && issues.size > 0) issueCount++;
  }
  if (activeVessels === 0) return;

  fleetSparklineData.push(issueCount);
  if (fleetSparklineData.length > SPARKLINE_MAX) fleetSparklineData.shift();

  _renderFleetSparkline();
}

/* Re-render the fleet strip canvas and update the alarm count label */
function _renderFleetSparkline() {
  const canvas = document.getElementById("fleet-sparkline-canvas");
  const labelAvg = document.getElementById("fleet-sparkline-avg");
  if (canvas && fleetSparklineData.length >= 1) {
    drawFleetSparkline(canvas, fleetSparklineData);
  }
  if (labelAvg && fleetSparklineData.length >= 1) {
    const current = fleetSparklineData[fleetSparklineData.length - 1];
    labelAvg.textContent =
      current === 0
        ? "All clear"
        : `${current} alarm${current === 1 ? "" : "s"}`;
    labelAvg.style.color =
      current === 0 ? "#22c55e" : current <= 2 ? "#ffa040" : "#ff5555";
  }
}

/* HEADER DRAG HANDLE — fixed position, not draggable */
function initHeaderDragHandle() {
  if (_updateHeaderZone) _updateHeaderZone();
}

/* SPARKLINE STRIP — fixed height, not draggable */
function initFleetSparklineStrip() {
  const strip = document.getElementById("fleet-sparkline-strip");
  const panel = document.getElementById("bottom-panel");
  if (!strip || !panel) return;

  strip.style.height = "95px";

  // Keep body bottom-padding in sync with total panel height
  function syncBodyPad() {
    document.body.style.paddingBottom = panel.offsetHeight + "px";
  }
  new ResizeObserver(syncBodyPad).observe(panel);
  syncBodyPad();

  // Re-render on window resize (canvas width changes)
  window.addEventListener("resize", () => {
    if (fleetSparklineData.length) _renderFleetSparkline();
  });
}

/* ISSUES-ONLY VIEW FILTER */
const ISSUE_LABELS = {
  motor: "🛠️ Motor",
  temp: "🌡️ Temp",
  airflow: "💨 Airflow",
  pressure: "💥 Pressure",
  probe: "🔬 Probe Δ",
};

// Sort order for issue types: lower = higher priority
// motor > pressure > temp > airflow > probe (lower = more severe = sorts first)
const ISSUE_PRIORITY = { motor: 0, pressure: 1, temp: 2, airflow: 3, probe: 4 };

// Returns a raw telemetry severity score for a given issue type.
// Lower score = worse = sorts first (ascending comparator).
function _telemetryScoreForType(type, v, t) {
  switch (type) {
    case "pressure":
      return -(t.pressure || 0); // higher pressure → more negative → first
    case "temp":
      return (v?.tempControlOn === false ? -1000 : 0) + (t.processTemp ?? 999);
    case "airflow":
      return t.airflow ?? 999; // lower airflow → smaller number → first
    case "probe": {
      const temps = [t.temp0, t.temp1, t.temp2].filter(
        (x) => x != null && !isNaN(x),
      );
      if (temps.length < 2) return 0;
      const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
      return -Math.max(...temps.map((x) => Math.abs(x - avg)));
    }
    default:
      return 0;
  }
}

// Returns a numeric severity score for a slot's PRIMARY issue type.
// Lower score = worse = sorts first (ascending comparator).
// Motor-primary cards sub-sort by their next-highest issue's telemetry value
// so e.g. motor+pressure cards rank by pressure (highest first) within the motor tier.
function _issueSeverityScore(slotName) {
  const v = state[slotName];
  const t = v?.telemetry || {};
  const issues = slotActiveIssues.get(slotName);
  if (!issues?.size) return 0;
  const primaryType = [...issues].reduce((best, type) =>
    (ISSUE_PRIORITY[type] ?? 99) < (ISSUE_PRIORITY[best] ?? 99) ? type : best,
  );
  if (primaryType === "motor") {
    // Valve fault sorts first within motor tier
    const base = (v?.valveModuleStatus || "").toLowerCase().includes("fault")
      ? -1e6
      : 0;
    // Sub-sort by next-highest co-issue (pressure > temp > airflow > probe)
    const secondary = [...issues]
      .filter((i) => i !== "motor")
      .sort((a, b) => (ISSUE_PRIORITY[a] ?? 99) - (ISSUE_PRIORITY[b] ?? 99))[0];
    return base + (secondary ? _telemetryScoreForType(secondary, v, t) : 0);
  }
  return _telemetryScoreForType(primaryType, v, t);
}

function applyIssuesFilter() {
  const cards = document.querySelectorAll("#grid .card");
  let visibleCount = 0;
  const visibleCards = [];
  for (const card of cards) {
    if (!issuesModeActive) {
      card.style.display = "";
      card.style.order = "";
      card.classList.remove("top-issue-card");
      const strip = card.querySelector(".card-issues-strip");
      if (strip) strip.innerHTML = "";
      continue;
    }
    const slot = card.dataset.slot;
    const issues = slotActiveIssues.get(slot);
    const hasAny = issues && issues.size > 0;
    const matchesFilter =
      issuesFilterActive.size === 0
        ? hasAny
        : hasAny && [...issuesFilterActive].some((f) => issues.has(f));
    card.style.display = matchesFilter ? "" : "none";
    if (matchesFilter) {
      visibleCount++;
      visibleCards.push(card);
    } else {
      card.style.order = "";
    }
    const strip = card.querySelector(".card-issues-strip");
    if (strip) {
      strip.innerHTML = "";
      if (matchesFilter && issues) {
        // Render tags in priority order
        const sorted = [...issues].sort(
          (a, b) => (ISSUE_PRIORITY[a] ?? 99) - (ISSUE_PRIORITY[b] ?? 99),
        );
        for (const type of sorted) {
          const tag = document.createElement("span");
          tag.className = `issue-tag issue-tag-${type}`;
          tag.textContent = ISSUE_LABELS[type] ?? type;
          strip.appendChild(tag);
        }
      }
    }
  }

  // Sort: motor first → then by issue type priority → then by telemetry severity
  // (highest pressure/most critical value first within each tier) → then issue count.
  // Assign sequential CSS order integers so actual telemetry values drive position.
  if (issuesModeActive && visibleCards.length > 0) {
    visibleCards.sort((a, b) => {
      const aSlot = a.dataset.slot,
        bSlot = b.dataset.slot;
      const aIss = slotActiveIssues.get(aSlot),
        bIss = slotActiveIssues.get(bSlot);
      const aPri = aIss
        ? Math.min(...[...aIss].map((t) => ISSUE_PRIORITY[t] ?? 99))
        : 99;
      const bPri = bIss
        ? Math.min(...[...bIss].map((t) => ISSUE_PRIORITY[t] ?? 99))
        : 99;
      if (aPri !== bPri) return aPri - bPri;
      const aScore = _issueSeverityScore(aSlot),
        bScore = _issueSeverityScore(bSlot);
      if (aScore !== bScore) return aScore - bScore;
      return (bIss?.size || 0) - (aIss?.size || 0);
    });
    visibleCards.forEach((c, i) => {
      c.style.order = i;
    });
  }

  // In kiosk issues mode keep only the top 3 highest-priority cards.
  // visibleCards is already sorted above, so just slice.
  if (_kioskModeActive && issuesModeActive) {
    visibleCards.slice(3).forEach((c) => {
      c.style.display = "none";
    });
    visibleCards.slice(0, 3).forEach((c, i) => {
      c.style.order = i;
    });
  }

  // In full grid view, highlight the top 3 highest-priority issue cards.
  if (!issuesModeActive) {
    const issueCards = [...cards].filter((c) => {
      const issues = slotActiveIssues.get(c.dataset.slot);
      return issues && issues.size > 0;
    });
    issueCards.sort((a, b) => {
      const aSlot = a.dataset.slot,
        bSlot = b.dataset.slot;
      const aIss = slotActiveIssues.get(aSlot),
        bIss = slotActiveIssues.get(bSlot);
      const aPri = aIss
        ? Math.min(...[...aIss].map((t) => ISSUE_PRIORITY[t] ?? 99))
        : 99;
      const bPri = bIss
        ? Math.min(...[...bIss].map((t) => ISSUE_PRIORITY[t] ?? 99))
        : 99;
      if (aPri !== bPri) return aPri - bPri;
      const aScore = _issueSeverityScore(aSlot),
        bScore = _issueSeverityScore(bSlot);
      if (aScore !== bScore) return aScore - bScore;
      return (bIss?.size || 0) - (aIss?.size || 0);
    });
    issueCards.slice(0, 3).forEach((c) => c.classList.add("top-issue-card"));
  }

  const emptyEl = document.getElementById("issues-empty");
  if (emptyEl)
    emptyEl.style.display =
      issuesModeActive && visibleCount === 0 ? "block" : "none";

  // Re-fit after card visibility changes
  requestAnimationFrame(() => {
    if (issuesModeActive) _kioskZoomToVisibleCards();
    else if (isZoomed && !_kioskModeActive) applyZoom();
  });
}

/* NEEDS ATTENTION LIST */
function updateAttentionList() {
  const mixerIssues = [];
  const tempIssues = [];
  const tempCtrlIssues = []; // T bubble red: control OFF and not near setpoint
  const blowerIssues = [];
  const blowerStoppedIssues = []; // B bubble red: fully stopped (not declog/startup)
  const pressureIssues = [];
  const probeIssues = [];

  for (const [slotName, vessel] of Object.entries(state)) {
    if (!slotHasVessel(slotName)) continue;
    if ((vessel.mechanicalStatus || "").toLowerCase() === "wait_vessel")
      continue;
    // Skip any slot the UI is currently showing as "no vessel" (covers faulted
    // mixer, wait_vessel, and any other empty-slot heuristic in updateCard).
    const _card = cardMap.get(slotName);
    if (_card?.classList.contains("no-vessel")) continue;

    const t = vessel.telemetry || {};
    const airflow = Number(t.airflow ?? 0);
    const heaterTempF = toF(Number(t.heaterTemp ?? null));
    const declogActive =
      vessel.intake_declog_req === 1 || vessel.exhaust_declog_req === 1;
    const mixerCommand = (vessel.mixerModuleStatus || "").toUpperCase();
    const commandIsOn =
      mixerCommand === "MIXER_RUNNING" ||
      mixerCommand === "MIXER_MIXING" ||
      mixerCommand === "ON";
    const isStoppedUnexpectedly = mixerCommand === "MIXER_STOPPED";
    const blowerRecentlyActive =
      (blowerActiveUntil[slotName] || 0) > Date.now();
    const declogRecentlyCleared =
      (declogClearedAt[slotName] || 0) > Date.now() - 90000;
    const startupGrace = Date.now() - dashboardStartTime < 30000;
    const pressure = Number(t.pressure ?? 0);
    if (pressure > 9) {
      pressureIssues.push(slotName);
    }

    if (
      isStoppedUnexpectedly ||
      (commandIsOn && (motorActiveUntil[slotName] || 0) < Date.now())
    ) {
      mixerIssues.push(slotName);
    }
    if (heaterTempF !== null && heaterTempF < 100) {
      tempIssues.push(slotName);
    }
    const lowAirflowCondition =
      airflow < 30 &&
      airflow > 0 &&
      !declogActive &&
      !declogRecentlyCleared &&
      !startupGrace &&
      blowerRecentlyActive;
    if (lowAirflowCondition) {
      if (!lowAirflowSince[slotName]) lowAirflowSince[slotName] = Date.now();
      if (Date.now() - lowAirflowSince[slotName] >= 60000) {
        blowerIssues.push(slotName);
      }
    } else {
      delete lowAirflowSince[slotName];
    }
    if (probeIssuesGlobal.has(slotName)) {
      probeIssues.push(slotName);
    }

    // T bubble red: temp control confirmed OFF while temp is not near setpoint.
    // Excludes startup grace and cases where vessel is intentionally at setpoint.
    const tSpF = vessel.setpoints?.tempSp ?? null;
    const tCurF = toF(Number(t.processTemp));
    const tNearSp =
      tSpF !== null && tCurF !== null && Math.abs(tCurF - tSpF) <= 2;
    const inSpanMitg =
      (vessel.tempModuleStatus || "").toLowerCase() === "temp_span_mitg";
    const tProbes = [
      toF(Number(t.temp0)),
      toF(Number(t.temp1)),
      toF(Number(t.temp2)),
    ].filter((x) => x !== null && !isNaN(x));
    const tAvgF =
      tProbes.length > 0
        ? tProbes.reduce((a, b) => a + b, 0) / tProbes.length
        : null;
    const tAboveSp =
      vessel.tempControlOn === false &&
      tSpF !== null &&
      tAvgF !== null &&
      tAvgF >= tSpF;
    if (
      vessel.tempControlOn === false &&
      tSpF !== null &&
      !tNearSp &&
      !startupGrace &&
      !inSpanMitg &&
      !tAboveSp
    ) {
      tempCtrlIssues.push(slotName);
    }

    // B bubble red: blower was confirmed running but is now fully stopped.
    // Mirrors updateCard bubble logic exactly — same debounce thresholds.
    const blowerEverSeen = !!blowerActiveUntil[slotName];
    const blowerTimerExpired = (blowerActiveUntil[slotName] || 0) <= Date.now();
    if (
      blowerEverSeen &&
      blowerTimerExpired &&
      (blowerOffTicks[slotName] || 0) >= 5 &&
      !declogActive &&
      !declogRecentlyCleared &&
      !startupGrace
    ) {
      blowerStoppedIssues.push(slotName);
    }
  }

  const combinedMap = {};
  mixerIssues.forEach((slot) => {
    if (!combinedMap[slot]) combinedMap[slot] = [];
    combinedMap[slot].push("mixer");
  });
  tempIssues.forEach((slot) => {
    if (!combinedMap[slot]) combinedMap[slot] = [];
    combinedMap[slot].push("low temp");
  });
  tempCtrlIssues.forEach((slot) => {
    if (!combinedMap[slot]) combinedMap[slot] = [];
    combinedMap[slot].push("temp ctrl off");
  });
  blowerIssues.forEach((slot) => {
    if (!combinedMap[slot]) combinedMap[slot] = [];
    combinedMap[slot].push("low airflow");
  });
  blowerStoppedIssues.forEach((slot) => {
    if (!combinedMap[slot]) combinedMap[slot] = [];
    combinedMap[slot].push("blower stopped");
  });

  const el = document.getElementById("attention-list");
  if (!el) return;

  const lines = [];

  if (mixerIssues.length > 0) {
    const slots = mixerIssues
      .map((slot) => {
        const extra = combinedMap[slot].filter((i) => i !== "mixer");
        const suffix =
          extra.length > 0
            ? ` <span style="color:red;font-size:12px">(+${extra.join(", ")})</span>`
            : "";
        return `<span style="color:#ff9900;font-weight:bold">${slot}</span>${suffix}`;
      })
      .join(", &nbsp;");
    lines.push(
      `<div><span style="margin-left:20px;font-weight:bold;display:inline-block;min-width:120px">🛠️ &nbsp;&nbsp;Mixer Not Running:</span> &nbsp;${slots}</div>`,
    );
  }

  if (tempIssues.length > 0) {
    const slots = tempIssues
      .map((slot) => {
        const extra = combinedMap[slot].filter((i) => i !== "low temp");
        const suffix =
          extra.length > 0
            ? ` <span style="color:red;font-size:12px">(+${extra.join(", ")})</span>`
            : "";
        return `<span style="color:#ff9900;font-weight:bold">${slot}</span>${suffix}`;
      })
      .join(", &nbsp;");
    lines.push(
      `<div><span style="margin-left:20px;font-weight:bold;display:inline-block;min-width:120px">🌡️ &nbsp;&nbsp;Low Temp (&lt;100°F):</span> &nbsp;${slots}</div>`,
    );
  }

  if (blowerStoppedIssues.length > 0) {
    const slots = blowerStoppedIssues
      .map((slot) => {
        const extra = combinedMap[slot].filter((i) => i !== "blower stopped");
        const suffix =
          extra.length > 0
            ? ` <span style="color:red;font-size:12px">(+${extra.join(", ")})</span>`
            : "";
        return `<span style="color:#ff9900;font-weight:bold">${slot}</span>${suffix}`;
      })
      .join(", &nbsp;");
    lines.push(
      `<div><span style="margin-left:20px;font-weight:bold;display:inline-block;min-width:120px">💨 &nbsp;&nbsp;Blower Stopped:</span> &nbsp;${slots}</div>`,
    );
  }

  if (tempCtrlIssues.length > 0) {
    const slots = tempCtrlIssues
      .map((slot) => {
        const extra = combinedMap[slot].filter((i) => i !== "temp ctrl off");
        const suffix =
          extra.length > 0
            ? ` <span style="color:red;font-size:12px">(+${extra.join(", ")})</span>`
            : "";
        return `<span style="color:#ff9900;font-weight:bold">${slot}</span>${suffix}`;
      })
      .join(", &nbsp;");
    lines.push(
      `<div><span style="margin-left:20px;font-weight:bold;display:inline-block;min-width:120px">🌡️ &nbsp;&nbsp;Temp Control Off:</span> &nbsp;${slots}</div>`,
    );
  }

  if (blowerIssues.length > 0) {
    const slots = blowerIssues
      .map((slot) => {
        const extra = combinedMap[slot].filter((i) => i !== "low airflow");
        const suffix =
          extra.length > 0
            ? ` <span style="color:red;font-size:12px">(+${extra.join(", ")})</span>`
            : "";
        return `<span style="color:#ff9900;font-weight:bold">${slot}</span>${suffix}`;
      })
      .join(", &nbsp;");

    lines.push(
      `<div><span style="margin-left:20px;font-weight:bold;display:inline-block;min-width:120px">💨 &nbsp;&nbsp;Low Airflow (&lt;30 l/min):</span> &nbsp;${slots}</div>`,
    );
  }

  if (pressureIssues.length > 0) {
    const slots = pressureIssues
      .map(
        (slot) => `<span style="color:#ff9900;font-weight:bold">${slot}</span>`,
      )
      .join(", &nbsp;");

    lines.push(
      `<div><span style="margin-left:20px;font-weight:bold;display:inline-block;min-width:120px">💥 &nbsp;&nbsp;High Pressure (&gt;9 kPa):</span> &nbsp;${slots}</div>`,
    );
  }

  if (probeIssues.length > 0) {
    const slots = probeIssues
      .map(
        (slot) => `<span style="color:#ff9900;font-weight:bold">${slot}</span>`,
      )
      .join(", &nbsp;");

    lines.push(
      `<div>
      <span style="margin-left:20px;font-weight:bold;display:inline-block;min-width:120px">🌡️ &nbsp;&nbsp;Probe Delta (+/-10°F):</span> &nbsp;${slots}
    </div>`,
    );
  }

  el.innerHTML = lines.slice(0, 7).join("");
  if (_updateHeaderZone) _updateHeaderZone();

  slotActiveIssues.clear();
  const _issueMap = [
    ["motor", mixerIssues],
    ["temp", tempIssues],
    ["temp", tempCtrlIssues], // T bubble red folds into "temp"
    ["airflow", blowerIssues],
    ["airflow", blowerStoppedIssues], // B bubble red folds into "airflow"
    ["pressure", pressureIssues],
    ["probe", [...probeIssuesGlobal]],
  ];
  for (const [type, slots] of _issueMap) {
    for (const s of slots) {
      if (!slotActiveIssues.has(s)) slotActiveIssues.set(s, new Set());
      slotActiveIssues.get(s).add(type);
    }
  }
}

/* DEBUG OVERLAY */
function updateDebugOverlayForSelectedSlot() {
  const content = document.getElementById("debug-content");
  if (!content) return;

  const v = state[debugSlot];
  const t = v?.telemetry || {};

  if (!v) {
    content.textContent = `SLOT: ${debugSlot}\n------------------------------\nNO DATA\n`;
    return;
  }

  if (!slotHasVessel(debugSlot)) {
    content.textContent = `SLOT: ${debugSlot}\n------------------------------\nVESSEL PRESENT: NO\n\nNo telemetry expected.\n`;
    return;
  }

  const vesselLines = Object.entries(v)
    .filter(([k]) => k !== "telemetry")
    .map(([k, val]) => `${k}: ${JSON.stringify(val)}`)
    .join("\n");
  const telemetryLines = Object.entries(t)
    .map(([k, val]) => `${k}: ${JSON.stringify(val)}`)
    .join("\n");

  content.textContent =
    `SLOT: ${debugSlot}\n------------------------------\nVESSEL PRESENT: YES\n\n=== VESSEL FIELDS ===\n` +
    vesselLines +
    `\n\n=== TELEMETRY FIELDS ===\n` +
    telemetryLines +
    `\n`;
}

function updateDebugOverlay(slotName, v, t, tempShouldBeGreen) {
  const content = document.getElementById("debug-content");
  if (!content) return;

  if (!slotHasVessel(slotName)) {
    content.textContent = `SLOT: ${slotName}\n------------------------------\nVESSEL PRESENT: NO\n\nNo telemetry expected.\nThis rack position is empty.\n`;
    return;
  }

  const vesselLines = Object.entries(v)
    .filter(([k]) => k !== "telemetry")
    .map(([k, val]) => `${k}: ${JSON.stringify(val)}`)
    .join("\n");
  const telemetryLines = Object.entries(t)
    .map(([k, val]) => `${k}: ${JSON.stringify(val)}`)
    .join("\n");

  content.textContent =
    `SLOT: ${slotName}\n------------------------------\nVESSEL PRESENT: YES\n\n=== VESSEL FIELDS ===\n` +
    vesselLines +
    `\n\n=== TELEMETRY FIELDS ===\n` +
    telemetryLines +
    `\n\nFINAL bubble: ${tempShouldBeGreen ? "GREEN" : "OFF"}\n`;
}

/* DRAGGABLE DEBUG OVERLAY */
function makeOverlayDraggable(el, handle) {
  let offsetX = 0,
    offsetY = 0,
    isDragging = false;
  handle.style.cursor = "move";

  handle.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.closest("input")) return;
    isDragging = true;
    offsetX = e.clientX - el.offsetLeft;
    offsetY = e.clientY - el.offsetTop;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    el.style.left = `${e.clientX - offsetX}px`;
    el.style.top = `${e.clientY - offsetY}px`;
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });
}

makeOverlayDraggable(
  debugOverlayEl,
  document.getElementById("debug-overlay-header"),
);

// SETPOINT HELPERS
/** Returns true/false if temp control state is known, null if unknown.
 *  Source of truth is the HMI scrape (v.tempControlOn boolean).
 *  tempModuleStatus is intentionally NOT used — it is unreliable and
 *  was causing the T bubble to show green when temp control was off. */
function isTempControlOn(slotName) {
  const v = state[slotName] || {};
  if (typeof v.tempControlOn === "boolean") return v.tempControlOn;
  return null; // scrape hasn't run yet — treat as unknown (bubble shows off)
}

// Returns true if the mixer is currently commanded on or recently active.
// Checks API status first, then live angle tracking (motorSteadyGreen = angle
// was changing recently), then the 30-second activity timer.
function isMotorRunning(slotName) {
  const v = state[slotName] || {};
  const ms = (v.mixerModuleStatus || "").toUpperCase();
  if (ms === "MIXER_RUNNING" || ms === "MIXER_MIXING" || ms === "ON")
    return true;
  if (motorSteadyGreen[slotName]) return true;
  return (motorActiveUntil[slotName] || 0) > Date.now();
}

// Returns true if the blower is currently on or recently active.
function isBlowerRunning(slotName) {
  if ((blowerActiveUntil[slotName] || 0) > Date.now()) return true;
  const v = state[slotName] || {};
  if ((v.valveModuleStatus || "").toUpperCase() === "ON") return true;
  const airflow = v.telemetry?.airflow ?? 0;
  return airflow > 0;
}

/*
 * Sequenced setpoint sender. Returns Promise<{ slot, warnings }>.
 * When temp control is off and the user wants to enable it (needsCtrlOn path):
 *   1. Starts motor (if not already running, or if selected)
 *   2. Waits for motor to be confirmed running (up to 20 s)
 *   3. Ensures motor has been running for at least 10 s total before temp-ctrl
 *   4. Sends blower and waits for confirmation (up to 10 s)
 *   5. Enables temp control (retries up to 3×)
 *   6. Sets temp setpoint
 * Non-sequenced path (popup, temp already on): motor → blower → temp, no waits.
 */
async function sequenceSetpoints(slot, sels, enableTempCtrl, strategy = {}) {
  const warnings = [];
  const sent = []; // command types successfully delivered to the HMI
  let _motorConfirmedMs = null; // ms from motor cmd to confirmation; null if timed out
  let _cardResetUsed = false; // true if a mid-sequence card reset was attempted
  const tempOn = isTempControlOn(slot);
  const motorRunning = isMotorRunning(slot);
  // null = state unknown (scrape hasn't run yet) — treat as potentially off
  const needsCtrlOn = sels.temp !== null && tempOn !== true && enableTempCtrl;

  function send(spType, value) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "setpoint:set", slotName: slot, spType, value },
        (resp) => {
          if (chrome.runtime.lastError || !resp?.ok) {
            showSetpointToast(
              `Failed ${spType}: ${resp?.error || chrome.runtime.lastError?.message || "error"}`,
              true,
            );
            resolve(false);
          } else {
            showSetpointToast(`\u2713 ${slot} ${spType} \u2192 ${value}`);
            resolve(true);
          }
        },
      );
    });
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Poll condFn every intervalMs until it returns true or timeoutMs elapses.
  // Resolves true if condition was met, false if timed out.
  function waitFor(condFn, intervalMs, timeoutMs) {
    return new Promise((resolve) => {
      if (condFn()) {
        resolve(true);
        return;
      }
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (condFn()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          resolve(false);
        }
      }, intervalMs);
    });
  }

  _log(
    `[sequenceSetpoints] ${slot} tempOn:${tempOn} motorRunning:${motorRunning} needsCtrlOn:${needsCtrlOn} enableTempCtrl:${enableTempCtrl} sels:${JSON.stringify(sels)}`,
  );

  if (needsCtrlOn) {
    // Sequenced path: motor → wait → stabilize → blower → wait → temp-ctrl → temp

    // 1. Start motor if not already confirmed running or if a new speed was selected
    const alreadyRunning = motorRunning && sels.motor === null;
    const motorStartedAt = alreadyRunning ? null : Date.now();
    if (!alreadyRunning) {
      const motorVal = sels.motor !== null ? sels.motor : SP_DEFAULTS.motor;
      const motorOk = await send("motor", motorVal);
      if (motorOk) sent.push("motor");
    }

    // 2. Wait for telemetry to confirm the motor is actually running.
    //    Checks both API status and current_angle delta (proves physical drum motion).
    //    Timeout scales from per-slot history (default 20 s).
    const _motorTimeoutMs = strategy.motorTimeoutMs ?? 20000;
    let _priorAngle = state[slot]?.telemetry?.currentAngle ?? null;
    showSetpointToast(`\u23f3 ${slot}: waiting for motor to spin up\u2026`);
    const _motorWatchStart = Date.now();
    const motorConfirmed = await waitFor(
      () => {
        if (isMotorRunning(slot)) return true;
        const angle = state[slot]?.telemetry?.currentAngle ?? null;
        const moved =
          angle !== null &&
          _priorAngle !== null &&
          Math.abs(angle - _priorAngle) > 1;
        _priorAngle = angle;
        return moved;
      },
      1000,
      _motorTimeoutMs,
    );
    if (motorConfirmed) _motorConfirmedMs = Date.now() - _motorWatchStart;
    if (!motorConfirmed && strategy.doEscalation) {
      // Mid-sequence escalation: card reset to unstick the motor drive.
      showSetpointToast(`⏳ ${slot}: escalating — trying motor card reset…`);
      const resetResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "reset-motor-card", slotName: slot },
          (resp) => {
            if (chrome.runtime.lastError) {
            }
            resolve(resp);
          },
        );
      });
      if (resetResp?.ok) {
        _cardResetUsed = true;
        await new Promise((r) => setTimeout(r, 1500));
        const escConfirmed = await waitFor(
          () => isMotorRunning(slot),
          1000,
          15000,
        );
        if (!escConfirmed) {
          showSetpointToast(
            `⚠️ ${slot}: motor spin-up not confirmed — continuing`,
            true,
          );
          warnings.push("motor timeout");
        }
      } else {
        showSetpointToast(
          `⚠️ ${slot}: motor spin-up not confirmed — continuing`,
          true,
        );
        warnings.push("motor timeout");
      }
    } else if (!motorConfirmed) {
      showSetpointToast(
        `\u26a0\ufe0f ${slot}: motor spin-up not confirmed \u2014 continuing`,
        true,
      );
      warnings.push("motor timeout");
    }

    // 2b. If we just started the motor, ensure it has been running for at
    //     least 10 s total before enabling temp control — the hardware requires
    //     the motor to be spinning for ~10 s before it will accept temp-ctrl ON.
    if (!alreadyRunning && motorConfirmed && motorStartedAt !== null) {
      const elapsed = Date.now() - motorStartedAt;
      const remaining = Math.max(0, 10000 - elapsed);
      if (remaining > 0) {
        showSetpointToast(
          `\u23f3 ${slot}: stabilizing motor (${Math.ceil(remaining / 1000)} s)\u2026`,
        );
        await wait(remaining);
      }
    }

    // 3. Send blower after motor is confirmed running
    if (sels.blower !== null) {
      const blowerOk = await send("blower", sels.blower);
      if (blowerOk) sent.push("blower");
      const blowerConfirmed = await waitFor(
        () => isBlowerRunning(slot),
        1000,
        strategy.blowerTimeoutMs ?? 10000,
      );
      if (!blowerConfirmed) {
        showSetpointToast(
          `\u26a0\ufe0f ${slot}: blower confirmation timed out`,
          true,
        );
        warnings.push("blower timeout");
      }
    }

    // 3b. Stabilize after motor + blower are running before attempting temp-ctrl ON.
    //     The HMI rejects temp-ctrl ON until the rack has been spinning with airflow
    //     for several seconds; without this delay the 3 retries can all fire before
    //     the hardware is ready, causing temp setpoints to be dropped.
    const tempCtrlSettleMs = strategy.tempCtrlSettleMs ?? 5000;
    if (tempCtrlSettleMs > 0) {
      showSetpointToast(
        `\u23f3 ${slot}: settling before temp ctrl (${Math.ceil(tempCtrlSettleMs / 1000)} s)\u2026`,
      );
      await wait(tempCtrlSettleMs);
    }

    // 4. Send temp-ctrl ON and verify the HMI accepted it.
    //    Retry up to 3 times (each attempt allows 6 s for scrape to reflect the change).
    let ctrlAccepted = false;
    for (let attempt = 1; attempt <= 3 && !ctrlAccepted; attempt++) {
      if (attempt > 1) {
        showSetpointToast(
          `\u23f3 ${slot}: temp ctrl not yet on \u2014 retry ${attempt}/3\u2026`,
        );
      }
      await send("temp-ctrl", 1);
      ctrlAccepted = await waitFor(
        () => isTempControlOn(slot) === true,
        1000,
        6000,
      );
    }

    if (ctrlAccepted) sent.push("temp-ctrl");

    if (!ctrlAccepted) {
      showSetpointToast(
        `\u274c ${slot}: temp ctrl did not enable after 3 attempts \u2014 temp setpoint NOT sent`,
        true,
      );
      warnings.push("temp-ctrl failed");
      return {
        slot,
        warnings,
        sent,
        motorMs: _motorConfirmedMs,
        cardResetUsed: _cardResetUsed,
      };
    }

    // 5. Small gap then send the temp setpoint
    await wait(300);
    const tempOk = await send("temp", sels.temp);
    if (tempOk) sent.push("temp");
  } else {
    // Non-sequenced path (popup use): send motor, blower, temp in order without long waits
    if (sels.motor !== null) {
      const ok = await send("motor", sels.motor);
      if (ok) sent.push("motor");
    }
    if (sels.blower !== null) {
      const ok = await send("blower", sels.blower);
      if (ok) sent.push("blower");
    }
    if (sels.temp !== null) {
      const ok = await send("temp", sels.temp);
      if (ok) sent.push("temp");
    }
  }

  return {
    slot,
    warnings,
    sent,
    motorMs: _motorConfirmedMs,
    cardResetUsed: _cardResetUsed,
  };
}

// Called when a bubble is clicked
const popupEl = document.getElementById("sp-popup");

const SETPOINT_OPTIONS = {
  temp: [110, 120, 130, 135, 141],
  blower: [50, 65],
  motor: [30, 50, 60],
};

const SP_LABELS = {
  temp: "Temperature (°F)",
  motor: "Motor (R/hr)",
  blower: "Airflow (l/min)",
};

/* -----------------------------
   STATE
----------------------------- */
const SP_DEFAULTS = { motor: 60, temp: 110, blower: 65 };

const popupState = {
  open: false,
  slot: null,
  anchor: null,
  mode: "combined", // "combined" | "motor" | "temp" | "blower"
  selections: { motor: null, temp: null, tempCustom: null, blower: null },
  enableTempCtrl: false, // toggle shown when temp ctrl is off
  positioned: false, // true after first viewport clamp so re-renders don't jump
};

// RENDER (ONLY PLACE DOM CHANGES HAPPEN)
function renderPopup() {
  if (!popupState.open) {
    popupEl.style.display = "none";
    popupState.positioned = false;
    return;
  }

  const { slot, mode, selections, enableTempCtrl } = popupState;
  const v = state[slot] || {};

  // helper: build a row of option buttons
  function btnGroup(type, opts) {
    return opts
      .map((val) => {
        const active = selections[type] === val;
        return `<button class="sp-btn${active ? " sp-btn--active" : ""}" data-type="${type}" data-value="${val}">${val}</button>`;
      })
      .join("");
  }

  // Motor section
  function motorSection() {
    return `
      <div class="sp-section">
        <div class="sp-section-label">Motor Speed (R/hr)</div>
        <div class="sp-btn-group">${btnGroup("motor", SETPOINT_OPTIONS.motor)}</div>
      </div>`;
  }

  // Temperature section (with temp-ctrl warning when needed)
  function tempSection() {
    const lts = v.lastTempSet;
    const lastLine = lts
      ? `Last set: ${lts.value || ""}${lts.secondary ? " " + lts.secondary : ""}`.trim()
      : "";
    const tempOn = isTempControlOn(slot);
    const motorOn = isMotorRunning(slot);

    let ctrlWarning = "";
    if (tempOn !== true) {
      const statusLabel =
        tempOn === false
          ? "Temp control is <strong>OFF</strong>"
          : "Temp control state <strong>unknown</strong> (will enable to be safe)";
      const hint = motorOn
        ? "Motor is running \u2014 will enable temp ctrl, then set."
        : "Motor is <strong>not running</strong> \u2014 will start motor and wait for it to spin up, then enable temp ctrl.";
      const ctrlBtnLabel = enableTempCtrl
        ? "\u2713 Enable temp control on submit"
        : "Skip \u2014 just send setpoint";
      ctrlWarning = `
        <div class="sp-temp-ctrl-off">
          <span class="sp-temp-ctrl-icon">\u26a0</span>
          ${statusLabel}
        </div>
        <div class="sp-hint">${hint}</div>
        <button class="sp-btn sp-enable-ctrl-btn${enableTempCtrl ? " sp-btn--active" : ""}"
                data-type="enable-ctrl">${ctrlBtnLabel}</button>`;
    }

    const customVal = selections.tempCustom;
    const customInputHtml =
      customVal !== null
        ? `<div class="sp-custom-temp-wrapper">
           <button class="sp-spin-btn" type="button" data-spin="-1">&#8722;</button>
           <input type="number" class="sp-custom-temp" id="sp-custom-temp-input"
             value="${customVal}" min="50" max="200" step="1">
           <button class="sp-spin-btn" type="button" data-spin="1">+</button>
         </div>`
        : "";

    return `
      <div class="sp-section">
        <div class="sp-section-label">Temperature (&deg;F)</div>
        ${ctrlWarning}
        <div class="sp-btn-group">${btnGroup("temp", SETPOINT_OPTIONS.temp)}</div>
        ${customInputHtml}
        ${lastLine ? `<div class="sp-last-set-text">${lastLine}</div>` : ""}
      </div>`;
  }

  // Airflow section
  function blowerSection() {
    return `
      <div class="sp-section">
        <div class="sp-section-label">Airflow (l/min)</div>
        <div class="sp-btn-group">${btnGroup("blower", SETPOINT_OPTIONS.blower)}</div>
      </div>`;
  }

  // Titles per mode
  const titles = {
    combined: `Setpoints \u2014 ${slot}`,
    motor: `Motor Speed \u2014 ${slot}`,
    temp: `Temperature \u2014 ${slot}`,
    blower: `Airflow \u2014 ${slot}`,
  };

  // Assemble sections
  const sections = [];
  if (mode === "combined" || mode === "motor") sections.push(motorSection());
  if (mode === "combined") sections.push('<div class="sp-divider"></div>');
  if (mode === "combined" || mode === "temp") sections.push(tempSection());
  if (mode === "combined") sections.push('<div class="sp-divider"></div>');
  if (mode === "combined" || mode === "blower") sections.push(blowerSection());

  popupEl.innerHTML = `
    <div class="sp-header">
      <span class="sp-title">${titles[mode] || titles.combined}</span>
      <button class="sp-close" type="button">\u274c</button>
    </div>
    ${sections.join("")}
    <button class="sp-submit" type="button">Submit</button>
  `;

  popupEl.style.position = "fixed";
  popupEl.style.display = "flex";
  popupEl.style.flexDirection = "column";
  popupEl.style.zIndex = "2147483647";
  popupEl.style.pointerEvents = "auto";

  // Center popups in the viewport on first open so re-renders (button toggles) don't jump
  if (!popupState.positioned) {
    popupState.positioned = true;
    popupEl.style.top = "50%";
    popupEl.style.left = "50%";
    popupEl.style.transform = "translate(-50%, -50%)";
  }
}

// STATE ACTIONS
function openPopup(anchorEl, slot, mode = "combined") {
  popupState.open = true;
  popupState.slot = slot;
  popupState.anchor = anchorEl;
  popupState.mode = mode;
  popupState.positioned = false;

  // Pre-select defaults only for the sections that will be visible
  const showMotor = mode === "combined" || mode === "motor";
  const showTemp = mode === "combined" || mode === "temp";
  const showBlower = mode === "combined" || mode === "blower";

  // For temp: pre-select the last-set value if it matches a preset button,
  // otherwise pre-populate a custom input with that value.
  let tempSel = SP_DEFAULTS.temp;
  let tempCustom = null;
  if (showTemp) {
    const v = state[slot] || {};
    const lastTempSp = v.setpoints?.tempSp ?? null;
    const lastTempRounded = lastTempSp !== null ? Math.round(lastTempSp) : null;
    if (
      lastTempRounded !== null &&
      SETPOINT_OPTIONS.temp.includes(lastTempRounded)
    ) {
      tempSel = lastTempRounded;
    } else if (lastTempRounded !== null) {
      tempSel = null;
      tempCustom = lastTempRounded;
    }
  }

  popupState.selections = {
    motor: showMotor ? SP_DEFAULTS.motor : null,
    temp: showTemp ? tempSel : null,
    tempCustom: showTemp ? tempCustom : null,
    blower: showBlower ? SP_DEFAULTS.blower : null,
  };

  // Auto-enable temp ctrl toggle when temp is shown and ctrl is off or unknown.
  // null means the HMI scrape hasn't confirmed state yet — treat as potentially off.
  popupState.enableTempCtrl =
    showTemp && isTempControlOn(slot) !== true ? true : false;

  renderPopup();
}

function closePopup() {
  popupState.open = false;
  popupState.slot = null;
  popupState.anchor = null;
  popupState.mode = "combined";
  popupState.selections = {
    motor: null,
    temp: null,
    tempCustom: null,
    blower: null,
  };
  popupState.enableTempCtrl = false;
  popupState.positioned = false;
  renderPopup();
  // Flush any state changes that arrived while popup was blocking renders.
  scheduleRender();
}

//GLOBAL ENTRY POINT (REPLACES window.__showSetpointPopup)
window.__showSetpointPopup = function (anchorEl, slotName, spType) {
  // Map bubble spType → popup mode; "menu" / undefined → combined
  const mode =
    spType === "motor" || spType === "temp" || spType === "blower"
      ? spType
      : "combined";
  const card =
    cardMap.get(slotName) || anchorEl?.closest?.(".card") || anchorEl;
  // If same slot+mode is already open, close it (toggle behavior)
  if (
    popupState.open &&
    popupState.slot === slotName &&
    popupState.mode === mode
  ) {
    closePopup();
    return;
  }
  openPopup(card, slotName, mode);
};

// CLICK HANDLING (DELEGATED, STATE-BASED)
document.addEventListener(
  "click",
  (e) => {
    if (!popupState.open) return;

    // Clicks on the anchor card pass through (don't close popup)
    if (popupState.anchor && popupState.anchor.contains(e.target)) return;

    e.stopPropagation();

    // Close button
    if (e.target.closest(".sp-close")) {
      closePopup();
      return;
    }

    // Custom temp spin buttons (−/+) — adjust input without re-render
    const spinBtn = e.target.closest(".sp-spin-btn");
    if (spinBtn) {
      const input = popupEl.querySelector("#sp-custom-temp-input");
      if (input) {
        const delta = Number(spinBtn.dataset.spin);
        const cur = Number(input.value) || 0;
        const next = Math.min(200, Math.max(50, cur + delta));
        input.value = next;
        input.focus();
      }
      return;
    }

    // Setpoint option button (radio + click-again = deselect)
    const btn = e.target.closest(".sp-btn");
    if (btn) {
      const type = btn.dataset.type;

      if (type === "enable-ctrl") {
        // Toggle the "enable temp control on submit" flag
        popupState.enableTempCtrl = !popupState.enableTempCtrl;
        renderPopup();
        return;
      }

      const val = Number(btn.dataset.value);
      popupState.selections[type] =
        popupState.selections[type] === val ? null : val;
      // Clicking a preset temp button clears any custom input
      if (type === "temp") popupState.selections.tempCustom = null;
      renderPopup();
      return;
    }

    // Submit
    if (e.target.closest(".sp-submit")) {
      const slot = popupState.slot;
      const sels = { ...popupState.selections };
      const enableTempCtrl = popupState.enableTempCtrl;

      // If no preset temp is selected, read the custom input value
      if (sels.temp === null) {
        const customInput = popupEl.querySelector("#sp-custom-temp-input");
        if (customInput) {
          const customVal = Number(customInput.value);
          if (!isNaN(customVal) && customVal > 0) sels.temp = customVal;
        }
      }

      closePopup();

      const anySelected =
        sels.motor !== null || sels.temp !== null || sels.blower !== null;
      if (!anySelected) {
        showSetpointToast("No changes selected \u2014 nothing sent");
        return;
      }

      // Firmware ignores a motor setpoint that equals the currently-stored
      // value — pre-reset the motor card on the HMI so the next setpoint is
      // accepted. Blower does not have this quirk.
      const sp = state[slot]?.setpoints || {};
      const motorSameAsPreset =
        sels.motor !== null && sels.motor === sp.motorSp;

      if (motorSameAsPreset) {
        new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: "reset-motor-card", slotName: slot },
            (resp) => {
              if (chrome.runtime.lastError) {
              }
              resolve(resp);
            },
          );
        })
          .then(() => new Promise((r) => setTimeout(r, 1500)))
          .then(() => sequenceSetpoints(slot, sels, enableTempCtrl));
      } else {
        sequenceSetpoints(slot, sels, enableTempCtrl);
      }
      return;
    }

    // Click outside popup → close
    if (!e.target.closest("#sp-popup")) {
      closePopup();
    }
  },
  true,
);

function openSetpointMenu(v) {
  const popup = document.createElement("div");
  popup.className = "setpoint-popup";

  popup.innerHTML = `
    <h3>Setpoints</h3>

    <div>
      <label>
        <input type="checkbox" data-type="motor" checked>
        Motor
      </label>
      <select data-type="motor">
        <option value="50">50</option>
        <option value="60" selected>60</option>
      </select>
    </div>

    <div>
      <label>
        <input type="checkbox" data-type="temp" checked>
        Temp
      </label>
      <select data-type="temp">
        <option value="120">120</option>
        <option value="130" selected>130</option>
        <option value="140">140</option>
      </select>
    </div>

    <div>
      <label>
        <input type="checkbox" data-type="airflow" checked>
        Airflow
      </label>
      <select data-type="airflow">
        <option value="50">50</option>
        <option value="65" selected>65</option>
      </select>
    </div>

    <button id="submit-setpoints">Submit</button>
  `;

  document.body.appendChild(popup);

  popup
    .querySelector("#submit-setpoints")
    .addEventListener("click", () => submitSetpoints(popup, v));
}

// send setpoints to hmi
function submitSetpoints(popup, v) {
  const selections = {};

  popup.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    const type = cb.dataset.type;
    if (!cb.checked) return;

    const value = popup.querySelector(`select[data-type=${type}]`).value;
    selections[type] = value;
  });

  _log("Sending:", selections);

  sendToHMI(v, selections)
    .then(() => {
      // update dashboard state
      if (selections.motor) v.motorSetpoint = selections.motor;
      if (selections.temp) v.tempSetpoint = selections.temp;
      if (selections.airflow) v.airflowSetpoint = selections.airflow;

      scheduleRender();
      popup.remove();
    })
    .catch((err) => {
      console.error("Failed to send", err);
    });
}

/* SETPOINT TOAST */
function showSetpointToast(text, isError = false) {
  // Always log to console so the history survives after the toast fades
  if (isError) {
    console.warn(`SETPOINT ⚠️ ${text}`);
  } else {
    _log(`SETPOINT ✓ ${text}`);
  }

  let toast = document.getElementById("sp-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "sp-toast";
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "60px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "8px 18px",
      borderRadius: "6px",
      fontSize: "13px",
      fontFamily: "monospace",
      zIndex: "9999999",
      pointerEvents: "none",
      transition: "opacity 0.3s",
      opacity: "0",
      whiteSpace: "nowrap",
    });
    document.body.appendChild(toast);
  }
  toast.style.background = isError ? "#c00" : "#1a6b1a";
  toast.style.color = "#fff";
  toast.textContent = text;
  toast.style.opacity = "1";
  clearTimeout(toast._timer);
  // Errors stay visible longer; success toasts are brief
  toast._timer = setTimeout(
    () => {
      toast.style.opacity = "0";
    },
    isError ? 6000 : 2500,
  );
}

// Restart-All Persistent Status Bar
// Shows #restart-progress (second row inside #fixed-header).
// The ResizeObserver on #fixed-header automatically shifts the grid down.
const _restartProgressEl = document.getElementById("restart-progress");

function showRestartStatus(text, done = false) {
  if (!_restartProgressEl) return;
  clearTimeout(_restartProgressEl._timer);
  _restartProgressEl.textContent = text;
  _restartProgressEl.style.display = "block";
  if (done) {
    _restartProgressEl._timer = setTimeout(() => {
      _restartProgressEl.style.display = "none";
    }, 5000);
  }
}

//hook into existing api
function sendToHMI(v, selections) {
  return new Promise((resolve) => {
    // replace with real API call
    _log("API CALL →", v.id, selections);

    setTimeout(resolve, 500); // simulate success
  });
}

/* HMI SCRAPE DATA — on/off + last temp set */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "hmi:data") return;

  _log("📡 HMI RAW MESSAGE:", JSON.stringify(msg, null, 2));

  let changed = false;

  for (const update of msg.updates || []) {
    _log("🔍 HMI UPDATE:", update);

    const v = state[update.slotName];
    if (!v) {
      console.warn("⚠️ No vessel for slot:", update.slotName);
      continue;
    }

    // Log BEFORE
    _log(`➡️ BEFORE ${update.slotName}: tempControlOn =`, v.tempControlOn);

    if (typeof update.tempControlOn === "boolean") {
      v.tempControlOn = update.tempControlOn;
      _log(`✅ UPDATED ${update.slotName}: tempControlOn =`, v.tempControlOn);
      changed = true;
    }

    if (update.lastTempSet) {
      _log("🧾 Last temp set:", update.lastTempSet);
      v.lastTempSet = update.lastTempSet;
      changed = true;
    }
  }

  if (changed) {
    _log("🔄 Re-render triggered from HMI update");
    scheduleRender();
  } else {
    _log("⚠️ No relevant changes from HMI");
  }
});

/* KIOSK ISSUES ZOOM 
   In kiosk issues mode, zoom to fit the bounding box of VISIBLE cards only,
   so the view adapts to however many issue cards are currently shown.
   */
function _kioskZoomToVisibleCards() {
  const bottomPanel = document.getElementById("bottom-panel");
  const bottomH = bottomPanel ? bottomPanel.offsetHeight : 0;
  const kioskTitle = document.getElementById("kiosk-issues-title");

  const visibleCards = [...gridEl.querySelectorAll(".card")].filter(
    (c) => c.style.display !== "none",
  );
  if (!visibleCards.length) {
    applyZoom();
    return;
  }

  const kioskAnim = document.getElementById("kiosk-anim-wrap");
  if (!kioskAnim) {
    applyZoom();
    return;
  }

  // Clear transform so getBoundingClientRect returns natural layout positions
  kioskAnim.style.transform = "";
  const wRect = kioskAnim.getBoundingClientRect();

  let minL = Infinity,
    minT = Infinity,
    maxR = 0,
    maxB = 0;
  for (const card of visibleCards) {
    const r = card.getBoundingClientRect();
    minL = Math.min(minL, r.left - wRect.left);
    minT = Math.min(minT, r.top - wRect.top);
    maxR = Math.max(maxR, r.right - wRect.left);
    maxB = Math.max(maxB, r.bottom - wRect.top);
  }

  const cW = maxR - minL;
  const cH = maxB - minT;

  // Reset title top so offsetHeight reflects natural size, then measure it
  if (kioskTitle) kioskTitle.style.top = "";
  const titleH = kioskTitle ? kioskTitle.offsetHeight : 0;
  const titleGap = titleH > 0 ? 20 : 0; // gap below title; 0 when title is hidden (non-kiosk)
  const pad = 20; // inner padding above title and below cards

  // gridMT: derive directly from wRect.top (= grid-wrapper.margin-top) rather
  // than the CSS variable, so it's always in sync with the measured positions
  // even if --grid-margin-top hasn't been refreshed yet after a fullscreen toggle.
  const gridMT = Math.max(0, Math.round(wRect.top));

  // In issues mode the filter bar is fixed above the card area — use its bottom
  // edge as the top boundary so the card block is never placed behind it.
  let topBoundary = gridMT;
  if (
    issuesModeActive &&
    issuesFilterBar &&
    issuesFilterBar.offsetParent !== null
  ) {
    topBoundary = Math.max(
      gridMT,
      issuesFilterBar.getBoundingClientRect().bottom,
    );
  }

  // Available space below the header (or filter bar) and above the bottom panel
  const totalAvailH = window.innerHeight - bottomH - topBoundary;
  const usableW = window.innerWidth - pad * 2;
  // Usable height for the card block only (title + gap + pad sit outside this)
  const usableH = totalAvailH - titleH - titleGap - pad * 2;

  // Guard against degenerate space (e.g. very tall title + small viewport)
  const safeUsableH = Math.max(cH * 0.2, usableH);
  // Hard width constraint guarantees scaledW <= window.innerWidth - pad*2
  const scale = Math.max(0.05, Math.min(usableW / cW, safeUsableH / cH, 2.0));
  const scaledW = cW * scale;
  const scaledH = cH * scale;

  // Center the whole block (title + gap + cards) vertically in the available space
  // below the fixed header/filter bar. blockTop is always >= topBoundary so nothing hides behind it.
  const totalBlockH = titleH + titleGap + scaledH;
  const blockTop = topBoundary + Math.max(pad, (totalAvailH - totalBlockH) / 2);

  // Position the title dynamically so it sits above the card block
  if (kioskTitle) kioskTitle.style.top = blockTop + "px";

  const cardTop = blockTop + titleH + titleGap;

  // Place the card block's horizontal CENTER at the viewport center.
  // This is independent of wRect.left and the element's own width, so it's
  // robust even if kiosk-anim-wrap hasn't reflowed to its new width yet.
  const cardBlockCenterX = wRect.left + (minL + cW / 2) * scale;
  const tx = window.innerWidth / 2 - cardBlockCenterX;
  const ty = cardTop - wRect.top - minT * scale;

  kioskAnim.style.transformOrigin = "top left";
  kioskAnim.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  document.body.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";
}

/* KIOSK MODE + ENTERTAINMENT 
   Toggle via the 📺 Kiosk button in the legend.
   Fixed sequence every KIOSK_CYCLE_MS: grid → issues(top3) → grid → issues(top3) → entertainment → repeat.
   Entertainment appears every ~1 min; types: Las Vegas weather, trivia, jokes, live funeral industry news, NOR news.
   Live news types are skipped if no articles within the last 30 days.
   */
(function initKioskMode() {
  const KIOSK_CYCLE_MS = 15_000; // ← adjust view duration here
  const KIOSK_ANIM_MS = 1200; // transition duration — keep in sync with CSS
  // Slide sequence: issues(0) → grid(1) → issues(2) → entertainment(3) → repeat
  // Entertainment exits to grid, so the post-entertainment view is always grid.
  // Kiosk enters on grid, so the full visible pattern is: grid, issues, grid, issues, entertainment, grid, …
  const KIOSK_SEQ_LEN = 4;
  const ENT_WEATHER_REFRESH_MS = 30 * 60 * 1000; // weather: every 30 min
  const ENT_NEWS_REFRESH_MS = 6 * 60 * 60 * 1000; // news: every 6 h
  const ENT_FADE_MS = 800; // panel fade-in / fade-out
  const ENT_DISPLAY_MS = KIOSK_CYCLE_MS - ENT_FADE_MS * 2; // panel fully visible
  const ENT_REVEAL_MS = Math.round(ENT_DISPLAY_MS * 0.52); // answer / punchline delay

  const KIOSK_TRANSITIONS = [
    // opacity / clip-path — no transform
    "fade",
    "blur",
    "wipe-left",
    "wipe-right",
    "wipe-up",
    "wipe-down",
    "iris",
    "diamond",
    "ripple",
    "glitch",
    "dissolve",
    "venetian",
    "star",
    // transform-based — safe because animations target #kiosk-fx-wrap, not #kiosk-anim-wrap
    "spin",
    "spiral",
    "zoom-burst",
    // canvas overlay
    "checkerboard",
  ];

  let _kioskActive = false;
  let _kioskInterval = null;
  let _issuesRefitInterval = null; // re-fits issues slide while it's displayed
  let _entWeatherTimer = null;
  let _entNewsTimer = null;
  let _kioskStep = 0; // position in KIOSK_SEQ_LEN cycle (0-3)
  let _entRevealTimer = null;
  const _entCache = {};

  // Debug flag — forces every cycle to show entertainment slides in sequential order.
  // Toggle from DevTools console: entDebug(true) / entDebug(false)
  let _entDebug = false;
  let _entDebugIdx = 0;

  // Wrap grid content in #kiosk-fx-wrap so applyZoom's transform on #kiosk-anim-wrap
  // is never touched by transition animations (including transform-based ones).
  const _animWrap = document.getElementById("kiosk-anim-wrap");
  const _fxWrap = document.createElement("div");
  _fxWrap.id = "kiosk-fx-wrap";
  while (_animWrap.firstChild) _fxWrap.appendChild(_animWrap.firstChild);
  _animWrap.appendChild(_fxWrap);

  // Checkerboard canvas — fixed overlay, hidden until a checkerboard transition runs
  const _checkerCanvas = document.createElement("canvas");
  _checkerCanvas.id = "kiosk-checker-canvas";
  Object.assign(_checkerCanvas.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    opacity: "0",
    zIndex: "9998",
  });
  document.body.appendChild(_checkerCanvas);

  const _kioskTargets = [_fxWrap];

  // Transition helpers
  function _kioskAnimate(name, dir) {
    if (name === "checkerboard") return _kioskCheckerAnim(dir);
    return new Promise((resolve) => {
      _kioskTargets.forEach((el) => {
        el.style.animation = `kiosk-${name}-${dir} ${KIOSK_ANIM_MS}ms ease both`;
      });
      setTimeout(resolve, KIOSK_ANIM_MS);
    });
  }

  function _kioskCheckerAnim(dir) {
    return new Promise((resolve) => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      _checkerCanvas.width = W;
      _checkerCanvas.height = H;
      const ctx = _checkerCanvas.getContext("2d");
      const TILE = Math.max(20, Math.round(Math.min(W, H) / 24));
      const cols = Math.ceil(W / TILE);
      const rows = Math.ceil(H / TILE);
      const total = cols * rows;
      // Pseudo-random tile reveal order (deterministic, looks random)
      const order = Array.from({ length: total }, (_, i) => i).sort(
        (a, b) => ((a * 2654435761) >>> 0) - ((b * 2654435761) >>> 0),
      );

      // Pre-fill for "in" so there is no single-frame flash of the new content
      if (dir === "in") {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, H);
      }
      _checkerCanvas.style.opacity = "1";

      let start = null;
      function draw(ts) {
        if (!start) start = ts;
        const progress = Math.min((ts - start) / KIOSK_ANIM_MS, 1);
        const revealed = Math.floor(progress * total);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#000";
        if (dir === "out") {
          // Progressively cover screen with black tiles
          for (let k = 0; k < revealed; k++) {
            const idx = order[k];
            ctx.fillRect(
              (idx % cols) * TILE,
              Math.floor(idx / cols) * TILE,
              TILE,
              TILE,
            );
          }
        } else {
          // Start fully black, progressively clear tiles to reveal content beneath
          ctx.fillRect(0, 0, W, H);
          for (let k = 0; k < revealed; k++) {
            const idx = order[k];
            ctx.clearRect(
              (idx % cols) * TILE,
              Math.floor(idx / cols) * TILE,
              TILE,
              TILE,
            );
          }
        }
        if (progress < 1) {
          requestAnimationFrame(draw);
        } else {
          if (dir === "in") _checkerCanvas.style.opacity = "0";
          // "out" keeps canvas visible (fully black) until "in" resets and clears it
          resolve();
        }
      }
      requestAnimationFrame(draw);
    });
  }

  function _randTransition() {
    return KIOSK_TRANSITIONS[
      Math.floor(Math.random() * KIOSK_TRANSITIONS.length)
    ];
  }

  // Issues slide renderer (steps 1 and 3)
  function _applyIssuesSlide() {
    issuesModeActive = true;
    document.body.classList.add("issues-mode");
    applyIssuesFilter();
    requestAnimationFrame(_syncIssuesFilterOffset);

    const allVis = [...gridEl.querySelectorAll(".card")]
      .filter((c) => c.style.display !== "none")
      .sort((a, b) => {
        const aSlot = a.dataset.slot,
          bSlot = b.dataset.slot;
        const aIss = slotActiveIssues.get(aSlot),
          bIss = slotActiveIssues.get(bSlot);
        const aPri = aIss
          ? Math.min(...[...aIss].map((t) => ISSUE_PRIORITY[t] ?? 99))
          : 99;
        const bPri = bIss
          ? Math.min(...[...bIss].map((t) => ISSUE_PRIORITY[t] ?? 99))
          : 99;
        if (aPri !== bPri) return aPri - bPri;
        const aScore = _issueSeverityScore(aSlot),
          bScore = _issueSeverityScore(bSlot);
        if (aScore !== bScore) return aScore - bScore;
        return (bIss?.size || 0) - (aIss?.size || 0);
      });
    allVis.slice(3).forEach((c) => {
      c.style.display = "none";
    });
    allVis.slice(0, 3).forEach((c, i) => {
      c.style.order = i;
    });

    const cardSize =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--card-size")
        .trim() || "230px";
    gridEl.style.display = "grid";
    gridEl.style.gridTemplateColumns = `repeat(3, ${cardSize})`;
    gridEl.style.gridAutoFlow = "row";
    gridEl.style.gridTemplateRows = "auto";
    gridEl.style.gap = "6px";
    gridEl.style.width = "fit-content";
    gridEl.style.minWidth = "0";
    gridEl.style.maxWidth = "none";
    gridEl.style.padding = "0";
    gridEl.style.marginTop = "0";
  }

  function _applyGridSlide() {
    issuesModeActive = false;
    document.body.classList.remove("issues-mode");
    applyIssuesFilter();
    requestAnimationFrame(_syncIssuesFilterOffset);
    gridEl.style.display =
      gridEl.style.gridTemplateColumns =
      gridEl.style.gridAutoFlow =
      gridEl.style.gridTemplateRows =
      gridEl.style.gap =
      gridEl.style.width =
      gridEl.style.minWidth =
      gridEl.style.maxWidth =
      gridEl.style.padding =
      gridEl.style.marginTop =
        "";
  }

  // Main cycle (self-scheduling via setTimeout)
  // Steps 0,2 → issues (top 3); step 1 → grid; step 3 → entertainment then grid.
  async function _kioskCycle() {
    if (!_kioskActive) return;
    const name = _randTransition();
    const step = _entDebug ? 3 : _kioskStep;

    await _kioskAnimate(name, "out");
    _kioskTargets.forEach((el) => {
      el.style.animation = "";
      el.style.opacity = "0";
    });

    if (step === 3) {
      // Switch to grid while _fxWrap is already invisible (post animate-out),
      // so the grid is ready underneath before the entertainment panel fades in.
      // This prevents any issues-slide content from flashing during the fade-out.
      _stopIssuesRefit();
      _applyGridSlide();
      await new Promise((r) => requestAnimationFrame(r));
      if (isZoomed) applyZoom();

      await _entShowPanel();

      if (!_entDebug) {
        _kioskTargets.forEach((el) => {
          el.style.opacity = "";
        });
        await _kioskAnimate(name, "in");
        _kioskTargets.forEach((el) => {
          el.style.animation = "";
        });
      }
    } else {
      // Steps 0,2 → issues (top 3); step 1 → grid
      const wantIssues = step === 0 || step === 2;
      if (wantIssues) {
        _applyIssuesSlide();
      } else {
        _applyGridSlide();
      }
      await new Promise((r) => requestAnimationFrame(r));
      if (wantIssues) {
        _kioskZoomToVisibleCards();
        _startIssuesRefit();
      } else {
        _stopIssuesRefit();
        if (isZoomed) applyZoom();
      }
      _kioskTargets.forEach((el) => {
        el.style.opacity = "";
      });
      await _kioskAnimate(name, "in");
      _kioskTargets.forEach((el) => {
        el.style.animation = "";
      });
    }

    if (!_entDebug) _kioskStep = (_kioskStep + 1) % KIOSK_SEQ_LEN;
    if (_kioskActive)
      _kioskInterval = setTimeout(_kioskCycle, _entDebug ? 0 : KIOSK_CYCLE_MS);
  }

  // Entertainment panel
  function _entWeatherTheme(desc, tempF, isDay) {
    const d = (desc || "").toLowerCase();
    const t = Number(tempF) || 80;
    if (d.includes("thunder") || d.includes("storm"))
      return { cls: "ent-storm", emoji: "⛈️" };
    if (d.includes("snow") || d.includes("blizzard") || d.includes("ice"))
      return { cls: "ent-snow", emoji: "🌨️" };
    if (d.includes("rain") || d.includes("drizzle") || d.includes("shower"))
      return { cls: "ent-rain", emoji: "🌧️" };
    if (d.includes("fog") || d.includes("mist") || d.includes("haze"))
      return { cls: "ent-fog", emoji: "🌫️" };
    if (d.includes("overcast") || (d.includes("cloud") && !d.includes("part")))
      return { cls: "ent-cloudy", emoji: "☁️" };
    if (!isDay) return { cls: "ent-night", emoji: "🌙" };
    if (d.includes("partly")) return { cls: "ent-partly", emoji: "⛅" };
    if (t >= 100) return { cls: "ent-hot", emoji: "🔥" };
    return { cls: "ent-sunny", emoji: "☀️" };
  }

  function _entBuildHTML(type, data) {
    if (type === "weather") {
      const th = _entWeatherTheme(data.desc, data.tempF, data.isDay);
      return {
        cls: `ent-weather ${th.cls}`,
        html: `
          <div class="ent-bg-deco"></div>
          <div class="ent-inner">
            <div class="ent-weather-layout">
              <div class="ent-weather-info">
                <div class="ent-big-icon">${th.emoji}</div>
                <div class="ent-temp">${data.tempF}<span class="ent-temp-deg">°F</span></div>
                <div class="ent-cond">${data.desc}</div>
                <div class="ent-weather-row">
                  <span>💧 ${data.humidity}% humidity</span>
                  <span>💨 ${data.windMph} mph winds</span>
                  <span>🌡️ Feels like ${data.feelsLike}°F</span>
                </div>
                <div class="ent-clock"></div>
              </div>
              <div class="ent-lv-sign-wrap">
                <img src="lv-sign.png" alt="Welcome to Fabulous Las Vegas Nevada" class="ent-lv-sign">
              </div>
            </div>
          </div>`,
      };
    }
    if (type === "trivia") {
      return {
        cls: "ent-trivia",
        html: `
          <div class="ent-bg-deco"></div>
          <div class="ent-inner">
            <div class="ent-big-icon">🧠</div>
            <div class="ent-badge">${data.category}</div>
            <div class="ent-qtext">${data.question}</div>
            <div class="ent-answer" data-reveal>${data.correct}</div>
            <div class="ent-hint" data-hint>Answer reveals shortly…</div>
          </div>`,
      };
    }
    if (type === "funeral-news") {
      return {
        cls: "ent-funeral-news",
        html: `
          <div class="ent-bg-deco"></div>
          <div class="ent-inner">
            <div class="ent-big-icon">⚰️</div>
            <div class="ent-badge">Funeral Industry News</div>
            <div class="ent-news-headline">${data.title}</div>
            <div class="ent-news-meta">${data.source}</div>
            <div class="ent-news-age">${data.age}</div>
          </div>`,
      };
    }
    if (type === "nor-news") {
      return {
        cls: "ent-nor-news",
        html: `
          <div class="ent-bg-deco"></div>
          <div class="ent-inner">
            <div class="ent-big-icon">🌿</div>
            <div class="ent-badge">NOR in the News</div>
            <div class="ent-news-headline">${data.title}</div>
            <div class="ent-news-meta">${data.source}</div>
            <div class="ent-news-age">${data.age}</div>
          </div>`,
      };
    }
    if (type === "x-posts") {
      const tweet = data.tweets[Math.floor(Math.random() * data.tweets.length)];
      const safeText = (tweet.text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      const date = tweet.time
        ? new Date(tweet.time).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })
        : "";
      const avatarHtml = tweet.profileImg
        ? `<img class="ent-tweet-avatar" src="${tweet.profileImg}" alt="">`
        : `<div class="ent-tweet-avatar ent-tweet-avatar-placeholder"></div>`;
      const imgsHtml = tweet.imgs?.length
        ? `<div class="ent-tweet-images ent-tweet-img-${Math.min(tweet.imgs.length, 4)}">${tweet.imgs
            .slice(0, 4)
            .map((u) => `<img src="${u}" alt="">`)
            .join("")}</div>`
        : "";
      return {
        cls: "ent-x-posts",
        html: `<div class="ent-tweet-card">
          <div class="ent-tweet-header">
            ${avatarHtml}
            <div class="ent-tweet-byline">
              <span class="ent-tweet-name">${tweet.displayName || ""}</span>
              <span class="ent-tweet-handle">${tweet.handle || ""}</span>
            </div>
            <span class="ent-tweet-x-logo">&#x1D54F;</span>
          </div>
          <p class="ent-tweet-text">${safeText}</p>
          ${imgsHtml}
          ${date ? `<span class="ent-tweet-date">${date}</span>` : ""}
        </div>`,
      };
    }
    // joke
    if (data.type === "twopart") {
      return {
        cls: "ent-joke",
        html: `
          <div class="ent-bg-deco"></div>
          <div class="ent-inner">
            <div class="ent-big-icon">😄</div>
            <div class="ent-joke-setup">${data.setup}</div>
            <div class="ent-punchline" data-reveal>${data.delivery}</div>
          </div>`,
      };
    }
    return {
      cls: "ent-joke",
      html: `
        <div class="ent-bg-deco"></div>
        <div class="ent-inner">
          <div class="ent-big-icon">😂</div>
          <div class="ent-joke-setup">${data.joke}</div>
        </div>`,
    };
  }

  async function _entShowPanel() {
    const panel = document.getElementById("kiosk-ent-panel");
    if (!panel) return;

    const types = [
      "weather",
      "trivia",
      "joke",
      "funeral-news",
      "nor-news",
    ].filter((t) => _entCache[t]);
    if (!types.length) return;
    const type = _entDebug
      ? types[_entDebugIdx++ % types.length]
      : types[Math.floor(Math.random() * types.length)];
    const { cls, html } = _entBuildHTML(type, _entCache[type]);

    panel.className = cls;
    panel.innerHTML = html;

    let _clockTick = null;
    if (type === "weather") {
      const tick = () => {
        const el = panel.querySelector(".ent-clock");
        if (el)
          el.textContent = new Date().toLocaleString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            hour12: true,
          });
      };
      tick();
      _clockTick = setInterval(tick, 1000);
    }

    panel.style.display = "flex";
    await new Promise((r) => requestAnimationFrame(r));

    // Scale content down if it overflows the visible viewport.
    // getBoundingClientRect reports actual viewport clipping, bypassing any
    // discrepancy between CSS layout measurements and what's visually visible.
    // Tweet card sizing is handled entirely by CSS:
    // max-height keeps it within the panel; kiosk-mode zoom:2 targets 50% browser zoom.

    panel.classList.add("ent-visible");
    document.body.classList.add("ent-showing");

    _entRevealTimer = setTimeout(() => {
      const reveal = panel.querySelector("[data-reveal]");
      const hint = panel.querySelector("[data-hint]");
      if (reveal) reveal.classList.add("revealed");
      if (hint) hint.classList.add("revealed");
    }, ENT_REVEAL_MS);

    await new Promise((r) => setTimeout(r, ENT_DISPLAY_MS));
    clearTimeout(_entRevealTimer);
    clearInterval(_clockTick);
    panel.classList.remove("ent-visible");
    document.body.classList.remove("ent-showing");
    await new Promise((r) => setTimeout(r, ENT_FADE_MS));
    panel.style.display = "none";
    panel.innerHTML = "";

    // Silently refresh this type's cache for next appearance
    _entFetch(type)
      .then((d) => {
        if (d) _entCache[type] = d;
      })
      .catch(() => {});
  }

  // API fetchers
  //omit obituaries with funeral home sources, which are likely paid placements rather than newsworthy events
  const _OBT_RE = new RegExp(
    [
      // explicit obit labels
      "\\bobituar(?:y|ies)\\b",
      "\\bobit\\b",
      "\\bin memoriam\\b",
      "\\bdeceased\\b",
      "\\bin loving memory\\b",
      "\\brest in peace\\b",
      "\\blaid to rest\\b",
      "\\beulog(?:y|ies|ize)\\b",
      "\\bcondolences?\\b",
      // death verbs — standalone and with qualifiers
      "\\bdies\\b",
      "\\bdied\\b",
      "\\bhas died\\b",
      "\\bpassed away\\b",
      "\\bpasses away\\b",
      "\\bdeath of\\b",
      "\\bpassing of\\b",
      // funeral / memorial events
      "\\bfuneral (?:for|of|service for)\\b",
      "\\bmemorial service\\b",
      "\\bwake for\\b",
      "\\bvigil for\\b",
      // grief / remembrance language
      "\\bremember(?:ing)?\\b",
      "\\btribute to\\b",
      "\\bsurvived by\\b",
      "\\bgriev(?:ing|es|ed)\\b",
      "\\bmourns?\\b",
      "\\bbeloved\\b",
      "\\bcelebrat(?:ing|es) (?:the )?life\\b",
      "\\bfarewells?\\b",
    ].join("|"),
    "i",
  );
  // Catches "[First Last], 87" and "[First Last] dies/died/passes/passed"
  const _NAME_AGE_RE = /\b[A-Z][a-z]{1,15} [A-Z][a-z]{1,15},\s*\d{2,3}\b/;
  const _NAME_DEATH_RE =
    /\b[A-Z][a-z]{1,15} [A-Z][a-z]{1,15}\b.{0,40}\b(?:dies|died|passes|passed|dead|gone)\b/;
  const _isObituary = (title) =>
    _OBT_RE.test(title) ||
    _NAME_AGE_RE.test(title) ||
    _NAME_DEATH_RE.test(title);
  // Rejects items whose Google News source (the part after the last " - ") is a funeral home
  const _FH_SOURCE_RE =
    /\bfuneral home\b|\bfuneral chapel\b|\bfuneral parlou?r\b|\bfuneral service\b|\bmortuary\b|\bcrematorium\b|\bcremation\b/i;
  const _isFuneralHomeSource = (raw) => {
    const dash = raw.lastIndexOf(" - ");
    return dash > 0 && _FH_SOURCE_RE.test(raw.slice(dash + 3));
  };

  async function _entFetch(type) {
    try {
      if (type === "weather") {
        const j = await fetch(
          "https://api.open-meteo.com/v1/forecast?latitude=36.1699&longitude=-115.1398" +
            "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day" +
            "&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FLos_Angeles",
        ).then((r) => r.json());
        const c = j.current;
        const WMO = {
          0: "Clear Sky",
          1: "Mainly Clear",
          2: "Partly Cloudy",
          3: "Overcast",
          45: "Fog",
          48: "Icy Fog",
          51: "Light Drizzle",
          53: "Drizzle",
          55: "Heavy Drizzle",
          61: "Light Rain",
          63: "Rain",
          65: "Heavy Rain",
          71: "Light Snow",
          73: "Snow",
          75: "Heavy Snow",
          77: "Snow Grains",
          80: "Light Showers",
          81: "Showers",
          82: "Heavy Showers",
          85: "Light Snow Showers",
          86: "Snow Showers",
          95: "Thunderstorm",
          96: "Thunderstorm w/ Hail",
          99: "Thunderstorm w/ Heavy Hail",
        };
        return {
          tempF: Math.round(c.temperature_2m),
          desc: WMO[c.weather_code] ?? "Clear Sky",
          humidity: c.relative_humidity_2m,
          windMph: Math.round(c.wind_speed_10m),
          feelsLike: Math.round(c.apparent_temperature),
          isDay: c.is_day === 1,
        };
      }
      if (type === "trivia") {
        const j = await fetch(
          "https://opentdb.com/api.php?amount=1&type=multiple",
        ).then((r) => r.json());
        const q = j.results[0];
        const dec = (s) => {
          const el = document.createElement("textarea");
          el.innerHTML = s;
          return el.value;
        };
        return {
          category: dec(q.category),
          question: dec(q.question),
          correct: dec(q.correct_answer),
        };
      }
      if (type === "funeral-news") {
        const cutoff = _entDebug ? 0 : Date.now() - 30 * 24 * 60 * 60 * 1000;
        // Multiple query passes so a broad range of funeral industry topics gets covered
        const queries = [
          '"funeral home" OR "funeral industry" OR "death care industry"',
          '"cremation" OR "alkaline hydrolysis" OR "aquamation" OR "green burial"',
          '"mortuary" OR "funeral director" OR "funeral service"',
        ];
        const q = encodeURIComponent(
          queries[Math.floor(Math.random() * queries.length)],
        );
        const xml = await fetch(
          `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
        ).then((r) => r.text());
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        const items = [...doc.querySelectorAll("item")].filter((el) => {
          const pub = new Date(el.querySelector("pubDate")?.textContent ?? 0);
          const title = el.querySelector("title")?.textContent ?? "";
          return (
            pub.getTime() >= cutoff &&
            !_isObituary(title) &&
            !_isFuneralHomeSource(title)
          );
        });
        if (!items.length) return null; // skip slide if nothing within 30 days
        const el = items[Math.floor(Math.random() * items.length)];
        const raw = el.querySelector("title")?.textContent ?? "";
        const dash = raw.lastIndexOf(" - ");
        const title = dash > 0 ? raw.slice(0, dash).trim() : raw;
        const source = dash > 0 ? raw.slice(dash + 3).trim() : "News";
        const pub = new Date(el.querySelector("pubDate")?.textContent ?? "");
        const daysAgo = Math.floor((Date.now() - pub.getTime()) / 86_400_000);
        const age =
          daysAgo === 0
            ? "Today"
            : daysAgo === 1
              ? "Yesterday"
              : `${daysAgo} days ago`;
        return { title, source, age };
      }
      if (type === "nor-news") {
        const cutoff = _entDebug ? 0 : Date.now() - 30 * 24 * 60 * 60 * 1000;
        const q = encodeURIComponent(
          '"natural organic reduction" OR "human composting" OR terramation',
        );
        const xml = await fetch(
          `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
        ).then((r) => r.text());
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        const items = [...doc.querySelectorAll("item")].filter((el) => {
          const pub = new Date(el.querySelector("pubDate")?.textContent ?? 0);
          const title = el.querySelector("title")?.textContent ?? "";
          return (
            pub.getTime() >= cutoff &&
            !_isObituary(title) &&
            !_isFuneralHomeSource(title)
          );
        });
        if (!items.length) return null;
        const el = items[Math.floor(Math.random() * items.length)];
        const raw = el.querySelector("title")?.textContent ?? "";
        const dash = raw.lastIndexOf(" - ");
        const title = dash > 0 ? raw.slice(0, dash).trim() : raw;
        const source = dash > 0 ? raw.slice(dash + 3).trim() : "News";
        const pub = new Date(el.querySelector("pubDate")?.textContent ?? "");
        const daysAgo = Math.floor((Date.now() - pub.getTime()) / 86_400_000);
        const age =
          daysAgo === 0
            ? "Today"
            : daysAgo === 1
              ? "Yesterday"
              : `${daysAgo} days ago`;
        return { title, source, age };
      }
      if (type === "x-posts") {
        const xResult = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ type: "x:fetch-from-tab" }, resolve),
        );
        console.log(
          "[ent] x-posts result:",
          xResult?.ok,
          "tweets:",
          xResult?.tweets?.length,
        );
        if (!xResult?.ok || !xResult.tweets?.length) return null;
        // tweets is now an array of oEmbed HTML strings
        return { tweets: xResult.tweets };
      }
      // joke
      const j = await fetch(
        "https://v2.jokeapi.dev/joke/Misc,Dark,Pun,Spooky,Christmas?safe-mode&blacklistFlags=nsfw,racist,sexist,explicit,political,religious",
      ).then((r) => r.json());
      return j.type === "twopart"
        ? { type: "twopart", setup: j.setup, delivery: j.delivery }
        : { type: "single", joke: j.joke };
    } catch {
      return null;
    }
  }

  function _entPrefetch() {
    [
      "weather",
      "trivia",
      "joke",
      "funeral-news",
      "nor-news",
      "x-posts",
    ].forEach((t) =>
      _entFetch(t)
        .then((d) => {
          if (d) _entCache[t] = d;
        })
        .catch(() => {}),
    );
  }

  // Issues slide continuous re-fit
  // Runs every 1.5 s while the issues slide is displayed so card additions /
  // removals are reflected immediately without waiting for the next data push.
  function _startIssuesRefit() {
    _stopIssuesRefit();
    _issuesRefitInterval = setInterval(() => {
      if (issuesModeActive) _kioskZoomToVisibleCards();
      else _stopIssuesRefit();
    }, 1500);
  }
  function _stopIssuesRefit() {
    if (_issuesRefitInterval) {
      clearInterval(_issuesRefitInterval);
      _issuesRefitInterval = null;
    }
  }

  function _refresh(type) {
    _entFetch(type)
      .then((d) => {
        if (d) _entCache[type] = d;
      })
      .catch(() => {});
  }
  function _startEntRefresh() {
    _stopEntRefresh();
    _entWeatherTimer = setInterval(
      () => _refresh("weather"),
      ENT_WEATHER_REFRESH_MS,
    );
    _entNewsTimer = setInterval(() => {
      _refresh("nor-news");
      _refresh("funeral-news");
      _refresh("x-posts");
    }, ENT_NEWS_REFRESH_MS);
  }
  function _stopEntRefresh() {
    clearInterval(_entWeatherTimer);
    _entWeatherTimer = null;
    clearInterval(_entNewsTimer);
    _entNewsTimer = null;
  }

  // Enter / exit
  const _kioskToggleBtn = document.getElementById("kiosk-toggle");

  async function _enterKiosk() {
    if (issuesModeActive) {
      issuesModeActive = false;
      document.body.classList.remove("issues-mode");
      if (issuesFilterBar) issuesFilterBar.style.display = "none";
      applyIssuesFilter();
    }
    _kioskActive = true;
    _kioskModeActive = true;
    _kioskStep = 0; // always start at grid slide
    document.body.classList.add("kiosk-mode");
    document.body.classList.add("kiosk-cursor-hidden");
    if (document.documentElement.requestFullscreen)
      document.documentElement.requestFullscreen().catch(() => {});
    if (_kioskToggleBtn) _kioskToggleBtn.classList.add("active");
    _entPrefetch();
    _startEntRefresh();
    if (typeof window._slackTickerFetch === "function")
      window._slackTickerFetch();
    if (typeof window._slackTickerShow === "function")
      window._slackTickerShow(true);

    // Animate out, apply fit-all zoom while hidden, animate back in — no jarring jump
    const name = _randTransition();
    await _kioskAnimate(name, "out");
    _kioskTargets.forEach((el) => {
      el.style.animation = "";
      el.style.opacity = "0";
    });
    if (!isZoomed) {
      isZoomed = true;
      document.body.classList.add("zoom-fit");
    }
    await new Promise((r) => requestAnimationFrame(r));
    applyZoom();
    _kioskTargets.forEach((el) => {
      el.style.opacity = "";
    });
    await _kioskAnimate(name, "in");
    _kioskTargets.forEach((el) => {
      el.style.animation = "";
    });

    _kioskInterval = setTimeout(_kioskCycle, KIOSK_CYCLE_MS);
  }

  function _exitKiosk() {
    _kioskActive = false;
    _kioskModeActive = false;
    clearTimeout(_cursorTimer);
    document.body.classList.remove("kiosk-cursor-hidden");
    _stopIssuesRefit();
    _stopEntRefresh();
    document.body.classList.remove("kiosk-mode");
    // Restore viewport scrolling that was locked during kiosk
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
    if (typeof window._slackTickerShow === "function")
      window._slackTickerShow(false);
    if (_kioskToggleBtn) _kioskToggleBtn.classList.remove("active");
    if (document.fullscreenElement && document.exitFullscreen)
      document.exitFullscreen().catch(() => {});
    clearTimeout(_kioskInterval);
    clearTimeout(_entRevealTimer);
    document.body.classList.remove("ent-showing");
    const panel = document.getElementById("kiosk-ent-panel");
    if (panel) {
      panel.classList.remove("ent-visible");
      panel.style.display = "none";
      panel.innerHTML = "";
    }
    _kioskTargets.forEach((el) => {
      el.style.animation = "";
      el.style.opacity = "";
      el.style.transform = "";
      el.style.clipPath = "";
      el.style.filter = "";
    });
    _checkerCanvas.style.opacity = "0";
    // Restore grid layout in case we exit while on the issues slide
    gridEl.style.display =
      gridEl.style.gridTemplateColumns =
      gridEl.style.gridAutoFlow =
      gridEl.style.gridTemplateRows =
      gridEl.style.gap =
      gridEl.style.width =
      gridEl.style.minWidth =
      gridEl.style.maxWidth =
      gridEl.style.padding =
      gridEl.style.marginTop =
        "";
    if (issuesModeActive) {
      issuesModeActive = false;
      document.body.classList.remove("issues-mode");
      if (issuesFilterBar) issuesFilterBar.style.display = "none";
      applyIssuesFilter();
    }
  }

  // Cursor: add kiosk-cursor-hidden class to hide it; remove on mouse move
  // so the cursor reappears for 3 s, then hides again.
  // Class toggle beats !important — inline style approach cannot.
  let _cursorTimer = null;
  document.addEventListener("mousemove", () => {
    if (!_kioskActive) return;
    document.body.classList.remove("kiosk-cursor-hidden");
    clearTimeout(_cursorTimer);
    _cursorTimer = setTimeout(() => {
      if (_kioskActive) document.body.classList.add("kiosk-cursor-hidden");
    }, 3000);
  });

  if (_kioskToggleBtn) {
    _kioskToggleBtn.addEventListener("click", () => {
      if (_kioskActive) _exitKiosk();
      else _enterKiosk();
    });
  }

  // DevTools helper — call from console while kiosk is running:
  //   entDebug(true)   → entertainment-only mode, cycles all types in order
  //   entDebug(false)  → restore normal kiosk behavior
  window.entDebug = (on) => {
    _entDebug = !!on;
    _entDebugIdx = 0;
    console.log(`[kiosk] entertainment debug ${_entDebug ? "ON" : "OFF"}`);
  };

  // DevTools helper — run testXcancel() from the dashboard console to manually probe the full fetch pipeline
  window.testXcancel = async () => {
    console.log("[testXcancel] fetching from x.com tab...");
    const xResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "x:fetch-from-tab" }, (resp) => {
        if (chrome.runtime.lastError)
          console.error(
            "[testXcancel] lastError:",
            chrome.runtime.lastError.message,
          );
        resolve(resp);
      });
    });
    if (xResult?.reason === "no-tab") {
      console.warn(
        "[testXcancel] open https://x.com/Earth_Funeral in a tab and stay logged in, then re-run",
      );
      return;
    }
    if (!xResult?.ok || !xResult.tweets?.length) {
      console.error("[testXcancel] failed:", xResult);
      return;
    }
    console.log(`[testXcancel] got ${xResult.tweets.length} tweets`);
    xResult.tweets.forEach((t, i) =>
      console.log(`  [${i}] @${t.handle}: ${t.text?.slice(0, 80)}`),
    );
    _entCache["x-posts"] = { tweets: xResult.tweets };
    console.log(
      "[testXcancel] DONE — cache populated, entDebug(true) will show the slide",
    );
  };
})();

/* SLACK OPEN-TICKET TICKER
   Polls the Slack maintenance log channel every 5 min for messages whose
   status line contains :looking: OPEN.  Renders them as a vertical step-
   scroller immediately above the legend strip, visible only in kiosk mode.
   */
(function initSlackTicker() {
  const POLL_MS = 5 * 60 * 1000; // refresh every 5 minutes
  const ADVANCE_MS = 5_000; // seconds each ticket is displayed
  const SCROLL_PX_PER_SEC = 9; // continuous scroll speed (px/s)

  let _tickets = [];
  let _idx = 0;
  let _stepTimer = null;
  let _offsets = []; // cumulative Y offsets per ticket (step-scroll mode)

  function _esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function _extractText(msg) {
    // Top-level text (user posts and most bot posts)
    if (msg.text && msg.text.trim()) return msg.text;
    // Legacy attachment format (older bot integrations)
    const att = (msg.attachments || [])[0];
    if (att?.text && att.text.trim()) return att.text;
    if (att?.fallback && att.fallback.trim()) return att.fallback;
    // Block kit format — flatten all plain/mrkdwn text elements
    const blockText = (msg.blocks || [])
      .flatMap((b) => [b.text, ...(b.fields || []), ...(b.elements || [])])
      .map((el) => el?.text || "")
      .join("\n");
    return blockText;
  }

  function _parseMsg(msg) {
    const text = _extractText(msg);
    if (!/:looking:\s+OPEN/i.test(text)) return null;

    const idMatch = text.match(/Ticket\s+ID:\*?\s*(\d+)/i);
    const priorityMatch = text.match(/Priority:\*?\s*(\S+)/i);
    const equipmentMatch = text.match(/Equipment:\*?\s*(.+)/i);
    const issueMatch = text.match(/Issue:\*?\s*\n([\s\S]+)/i);

    return {
      id: idMatch ? idMatch[1] : "—",
      date: new Date(parseFloat(msg.ts) * 1000),
      priority: priorityMatch ? priorityMatch[1].trim() : "—",
      equipment: equipmentMatch ? equipmentMatch[1].trim() : null,
      issue: issueMatch ? issueMatch[1].replace(/\n/g, " ").trim() : "",
    };
  }

  async function _fetchTickets() {
    // Hold a keepAlive port open so the MV3 service worker cannot suspend
    // mid-fetch before it calls sendResponse.
    const port = chrome.runtime.connect({ name: "keepAlive" });
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "slack:fetch-tickets",
      });
      if (!resp?.ok) {
        console.warn(
          "[slack-ticker] API error:",
          resp?.data?.error || resp?.error || "no response",
        );
        return;
      }
      const allMsgs = resp.data.messages || [];
      _tickets = allMsgs.map(_parseMsg).filter(Boolean).reverse();
      console.log(
        "[slack-ticker] open tickets found:",
        _tickets.length,
        _tickets.map((t) => `#${t.id}`),
      );
      _renderTicker();
    } catch (e) {
      console.warn("[slack-ticker] fetch error:", e);
    } finally {
      port.disconnect();
    }
  }

  function _showWrapper(visible) {
    const w = document.getElementById("slack-ticker-wrapper");
    if (w) w.style.display = visible ? "flex" : "none";
  }

  function _buildHtml() {
    return _tickets
      .map((t) => {
        const dateStr = t.date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const parts = [
          `#${_esc(t.id)}`,
          dateStr,
          `Priority: ${_esc(t.priority.toUpperCase())}`,
        ];
        if (t.equipment && t.equipment !== "N/A") parts.push(_esc(t.equipment));
        return `
        <div class="slack-ticker-item">
          <div class="slack-ticker-line1">${parts.join("&ensp;&middot;&ensp;")}</div>
          <div class="slack-ticker-line2">${_esc(t.issue)}</div>
        </div>`;
      })
      .join("");
  }

  function _renderTicker() {
    const inner = document.getElementById("slack-ticker-inner");
    const vp = document.getElementById("slack-ticker-viewport");
    if (!inner || !vp) return;

    clearInterval(_stepTimer);
    _stepTimer = null;
    _idx = 0;
    _offsets = [];
    inner.style.animation = "";
    inner.style.transition = "none";
    inner.style.transform = "translateY(0)";

    if (!_tickets.length) {
      inner.innerHTML = `
        <div class="slack-ticker-item slack-ticker-none">
          <div class="slack-ticker-line1">No open tickets</div>
          <div class="slack-ticker-line2"></div>
        </div>`;
      return;
    }

    inner.innerHTML = _buildHtml();

    // Measure after the browser has laid out the wrapped text
    setTimeout(() => {
      const viewH = vp.clientHeight;
      const items = [...inner.querySelectorAll(".slack-ticker-item")];
      let cumY = 0;
      _offsets = items.map((el) => {
        const top = cumY;
        cumY += el.offsetHeight;
        return top;
      });
      const totalH = cumY;

      if (totalH > viewH) {
        // Content taller than viewport — duplicate for seamless loop, then animate
        inner.innerHTML = _buildHtml() + _buildHtml();
        setTimeout(() => {
          const dur = (totalH / SCROLL_PX_PER_SEC).toFixed(1);
          inner.style.animation = `slack-ticker-scroll ${dur}s linear infinite`;
        }, 16);
      } else if (_tickets.length > 1) {
        // Multiple short tickets — step-scroll using measured offsets
        _stepTimer = setInterval(_advance, ADVANCE_MS);
      }
      // Single ticket that fits — show statically
    }, 60);
  }

  function _advance() {
    const inner = document.getElementById("slack-ticker-inner");
    if (!inner || !_offsets.length) return;

    const next = (_idx + 1) % _tickets.length;

    if (next === 0) {
      inner.style.transition = "none";
      inner.style.transform = "translateY(0)";
      inner.offsetHeight; // force reflow
    } else {
      inner.style.transition = "transform 0.65s ease";
      inner.style.transform = `translateY(-${_offsets[next]}px)`;
    }
    _idx = next;
  }

  // Expose so kiosk enter/exit can drive visibility and trigger immediate refresh
  window._slackTickerFetch = _fetchTickets;
  window._slackTickerShow = _showWrapper;

  // Initial fetch; subsequent fetches on interval
  _fetchTickets();
  setInterval(_fetchTickets, POLL_MS);
})();

// ============================================================
// WATCHDOG UI
// Button is a direct toggle - green = active, default = off.
// chrome.storage.onChanged keeps all open sessions in sync.
// ============================================================

const _wdSessionName =
  "Client " + Math.random().toString(36).slice(2, 6).toUpperCase();

function _wdUpdateBtn(enabled) {
  const btn = document.getElementById("watchdog-toggle");
  if (!btn) return;
  btn.classList.toggle("wd-active", !!enabled);
  btn.title = enabled
    ? "Watchdog ON — click to disable"
    : "Watchdog OFF — click to enable";
}

// Set initial button state from storage
chrome.storage.local.get(["watchdog_state"], ({ watchdog_state }) => {
  _wdUpdateBtn(!!watchdog_state?.enabled);
});

// Keep all open sessions in sync the moment any tab toggles
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.watchdog_state) {
    _wdUpdateBtn(!!changes.watchdog_state.newValue?.enabled);
  }
});

// Button click directly toggles the watchdog on/off
document.getElementById("watchdog-toggle")?.addEventListener("click", () => {
  chrome.storage.local.get(["watchdog_state"], ({ watchdog_state }) => {
    const enabled = !watchdog_state?.enabled;
    chrome.runtime
      .sendMessage({
        type: "watchdog:toggle",
        enabled,
        sessionName: _wdSessionName,
      })
      .catch(() => {});
  });
});
