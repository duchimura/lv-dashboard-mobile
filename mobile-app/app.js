const FETCH_INTERVAL_MS = 15_000;
const STALE_MS          = 2 * 60_000;
const DRIVE_URL = () =>
  `https://www.googleapis.com/drive/v3/files/${VESSEL_STATE_FILE_ID}?alt=media&key=${GOOGLE_API_KEY}&ts=${Date.now()}`;

let _currentData  = null;
let _slotColors   = {};  // slotName → hex from vessel_state.json

/* ── Phase segment classifier ───────────────────────────────────────────── */
// Returns 0 (no phase), 1 (Biofirst), 2 (PFRP), 3 (Compost), or 4 (Dry Down)
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
  let h = 0;
  const d = max - min;
  if (max === r)      h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else                h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  if (h >= 40 && h <= 80) return 1;  // yellow / amber  → Biofirst
  if (h >= 10 && h <  40) return 2;  // orange / terracotta → PFRP
  return 1;
}

const _PHASE_SEG_COLORS = ["#ffd966", "#f4a030", "#ffffff", "#999999"];
const _PHASE_EMPTY = "#1a1a2e";  // matches page background — unfilled slots invisible

/* ── Fetch ─────────────────────────────────────────────────────────────── */
async function fetchState() {
  const res = await fetch(DRIVE_URL(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ── Stale detection ────────────────────────────────────────────────────── */
function checkStale(updated) {
  const ageMs = Date.now() - new Date(updated).getTime();
  const banner = document.getElementById("stale-banner");
  const indicator = document.getElementById("live-indicator");
  if (ageMs > STALE_MS) {
    const mins = Math.floor(ageMs / 60_000);
    banner.textContent = `Data may be stale — last update ${mins} min ago`;
    banner.classList.add("visible");
    indicator.classList.add("stale");
    indicator.textContent = `⚠ ${mins}m ago`;
  } else {
    banner.classList.remove("visible");
    indicator.classList.remove("stale");
    const secs = Math.floor(ageMs / 1000);
    indicator.textContent = `● Live · ${secs}s ago`;
  }
}

/* ── Bubble helper ──────────────────────────────────────────────────────── */
function makeBubble(letter, state) {
  const el = document.createElement("div");
  el.className = `bubble ${state}`;
  el.textContent = letter;
  return el;
}

/* ── Card border class ───────────────────────────────────────────────────── */
function cardClass(vessel) {
  if (vessel.status === "empty") return "vessel-card vessel-empty";
  if (vessel.mBubble === "fault") return "vessel-card issue-orange";
  if (vessel.mBubble === "stopped" || vessel.tBubble === "error" || vessel.bBubble === "stopped")
    return "vessel-card issue-red";
  if (vessel.status === "off") return "vessel-card vessel-off";
  return "vessel-card";
}

/* ── Format value ────────────────────────────────────────────────────────── */
function fmt(v, unit) {
  return v !== null && v !== undefined ? `${v} ${unit}` : `— ${unit}`;
}

/* ── Render grid ─────────────────────────────────────────────────────────── */
function renderGrid(data) {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  const byRack = new Map();
  for (const v of (data.vessels ?? [])) {
    if (!byRack.has(v.rack)) byRack.set(v.rack, []);
    byRack.get(v.rack).push(v);
  }

  for (const rackNum of [...byRack.keys()].sort((a, b) => a - b)) {
    const section = document.createElement("div");
    section.className = "rack-section";
    section.dataset.rack = rackNum;

    const label = document.createElement("div");
    label.className = "rack-label";
    label.textContent = `Rack ${rackNum}`;
    section.appendChild(label);

    const cardsEl = document.createElement("div");
    cardsEl.className = "rack-cards";
    for (const v of byRack.get(rackNum).sort((a, b) => a.slot.localeCompare(b.slot))) {
      cardsEl.appendChild(makeCard(v));
    }
    section.appendChild(cardsEl);
    grid.appendChild(section);
  }
}

/* ── Make card ───────────────────────────────────────────────────────────── */
function makeCard(v) {
  const card = document.createElement("div");
  card.className = cardClass(v);

  // Header row: slot ID · vessel name (center) · days (right)
  const headerRow = document.createElement("div");
  headerRow.className = "card-header-row";

  const idEl = document.createElement("span");
  idEl.className = "slot-id";
  idEl.textContent = v.vesselName ? `${v.id} - ${v.vesselName}` : v.id;
  headerRow.appendChild(idEl);

  // Empty slot — just show the header row
  if (v.status === "empty") {
    card.appendChild(headerRow);
    return card;
  }

  card.addEventListener("click", () => openDetail(v));

  if (v.daysSince !== null) {
    const daysEl = document.createElement("span");
    daysEl.className = "card-days";
    daysEl.textContent = `${v.daysSince} days`;
    headerRow.appendChild(daysEl);
  }

  card.appendChild(headerRow);

  const bubblesRow = document.createElement("div");
  bubblesRow.className = "bubbles-row";
  bubblesRow.appendChild(makeBubble("M", v.mBubble));
  bubblesRow.appendChild(makeBubble("T", v.tBubble));
  bubblesRow.appendChild(makeBubble("B", v.bBubble));

  const telem = document.createElement("div");
  telem.className = "card-telem";

  if (v.status === "off") {
    telem.innerHTML = `<div class="dim">— °F</div><div class="dim">— l/m</div><div class="dim">— kPa</div>`;
  } else {
    const tempClass  = v.tBubble === "error" ? "warn" : "";
    const flowClass  = v.bBubble === "stopped" ? "err" : "";
    const pressClass = (v.pressure !== null && v.pressure > 9) ? "err" : "";
    telem.innerHTML =
      `<div class="${tempClass}">${fmt(v.temp, "°F")}</div>` +
      `<div class="${flowClass}">${fmt(v.airflow, "l/m")}</div>` +
      `<div class="${pressClass}">${fmt(v.pressure, "kPa")}</div>`;
  }

  card.appendChild(bubblesRow);
  card.appendChild(telem);

  // Phase progress bar — 4 pill divs replacing the card's bottom border.
  // Filled pills show the phase color; empty pills show #333 (card border color).
  const _phaseSegs = _hexToPhaseSegments(_slotColors[v.id]);
  card.style.borderBottomColor = _phaseSegs > 0 ? "transparent" : "";
  if (_phaseSegs > 0) {
    const _bar = document.createElement("div");
    _bar.className = "phase-bar";
    _bar.style.cssText = "position:absolute;bottom:-3px;left:2px;right:2px;height:5px;display:flex;gap:2px;pointer-events:none;z-index:2;";
    for (let i = 0; i < 4; i++) {
      const _pill = document.createElement("div");
      _pill.style.cssText = `flex:1;border-radius:3px;background:${i < _phaseSegs ? _PHASE_SEG_COLORS[i] : _PHASE_EMPTY};`;
      _bar.appendChild(_pill);
    }
    card.appendChild(_bar);
  }

  return card;
}

/* ── Fleet summary ───────────────────────────────────────────────────────── */
function renderFleet(fleet) {
  document.querySelector(".fleet-chip.running .count").textContent  = fleet.running;
  document.querySelector(".fleet-chip.issues .count").textContent   = fleet.issues;
  document.querySelector(".fleet-chip.fault .count").textContent    = fleet.fault;
  document.querySelector(".fleet-chip.off .count").textContent      = fleet.off;
}

/* ── Watchdog control bar ────────────────────────────────────────────────── */
let _confirmingAction = null;

function renderWatchdog(watchdog) {
  if (_confirmingAction) return; // don't overwrite confirmation UI during a data refresh
  const bar      = document.getElementById("watchdog-bar");
  const statusEl = document.getElementById("watchdog-status");
  const btnsEl   = document.getElementById("watchdog-btns");
  if (!watchdog) { bar.style.display = "none"; return; }
  bar.style.display = "";
  const on = !!watchdog.enabled;
  statusEl.innerHTML =
    `Watchdog&nbsp;<span class="wd-badge ${on ? "on" : "off"}">${on ? "ENABLED" : "DISABLED"}</span>`;
  btnsEl.style.display =
    (typeof REMOTE_CONTROL_URL === "string" && REMOTE_CONTROL_URL) ? "" : "none";
}

function _promptWatchdogCmd(action) {
  _confirmingAction = action;
  document.getElementById("watchdog-bar").style.display  = "none";
  document.getElementById("watchdog-conf").style.display = "";
  document.getElementById("wdconf-label").textContent = action === "pause_all"
    ? "Pause all racks + disable watchdog?"
    : "Restart all racks + enable watchdog?";
}

function _cancelWatchdogConf() {
  _confirmingAction = null;
  document.getElementById("watchdog-conf").style.display = "none";
  if (_currentData) renderWatchdog(_currentData.watchdog ?? null);
}

async function _sendWatchdogCmd(action) {
  _confirmingAction = null;
  document.getElementById("watchdog-conf").style.display = "none";
  if (_currentData) renderWatchdog(_currentData.watchdog ?? null);

  const msgEl = document.getElementById("watchdog-msg");
  msgEl.textContent = "Sending…";
  msgEl.className = "watchdog-msg visible";
  try {
    const fd = new FormData();
    fd.append("action", action);
    const res  = await fetch(REMOTE_CONTROL_URL, { method: "POST", body: fd });
    const data = await res.json();
    msgEl.textContent = data.ok ? `✓ ${data.message}` : `✗ ${data.error || "Error"}`;
    msgEl.className   = `watchdog-msg visible ${data.ok ? "ok" : "err"}`;
  } catch (e) {
    msgEl.textContent = "✗ Network error";
    msgEl.className   = "watchdog-msg visible err";
  }
  setTimeout(() => { msgEl.className = "watchdog-msg"; }, 5000);
}

/* ── Detail view ─────────────────────────────────────────────────────────── */
function openDetail(v) {
  document.getElementById("detail-title").textContent =
    v.vesselName ? `${v.id} · ${v.vesselName}` : `Vessel ${v.id}`;
  const badge = document.getElementById("detail-status-badge");
  badge.textContent = v.status.toUpperCase();
  badge.className = `detail-status-badge ${v.status}`;

  const bubblesEl = document.getElementById("detail-bubbles");
  bubblesEl.innerHTML = "";
  const defs = [
    { letter: "M", state: v.mBubble, label: "Motor",     stateLabel: { on:"Running", off:"Off", stopped:"Stopped", fault:"Fault" } },
    { letter: "T", state: v.tBubble, label: "Temp Ctrl",  stateLabel: { on:"On",     off:"Off", error:"Off (⚠)" } },
    { letter: "B", state: v.bBubble, label: "Blower",    stateLabel: { on:"Running", off:"Off", stopped:"Stopped" } },
  ];
  for (const d of defs) {
    const cell = document.createElement("div");
    cell.className = "detail-bubble-cell";
    const bbl = makeBubble(d.letter, d.state);
    const lbl = document.createElement("div");
    lbl.className = "detail-bubble-label";
    lbl.textContent = d.label;
    const stEl = document.createElement("div");
    stEl.className = "detail-bubble-state";
    stEl.textContent = d.stateLabel[d.state] ?? d.state;
    stEl.style.color = d.state === "on" ? "#0f0" : d.state === "off" ? "#777" : "#c00";
    cell.appendChild(bbl);
    cell.appendChild(lbl);
    cell.appendChild(stEl);
    bubblesEl.appendChild(cell);
  }

  // Temperature section
  document.getElementById("detail-temp").textContent        = fmt(v.temp, "°F");
  document.getElementById("detail-heater").textContent      = fmt(v.heaterTemp, "°F");
  const probes = Array.isArray(v.probes) ? v.probes : [null, null, null];
  document.getElementById("detail-probe1").textContent      = fmt(probes[0], "°F");
  document.getElementById("detail-probe2").textContent      = fmt(probes[1], "°F");
  document.getElementById("detail-probe3").textContent      = fmt(probes[2], "°F");
  // Airflow & pressure
  document.getElementById("detail-airflow").textContent     = fmt(v.airflow, "l/m");
  document.getElementById("detail-pressure").textContent    = fmt(v.pressure, "kPa");
  // Mechanical
  document.getElementById("detail-angle").textContent       = fmt(v.motorAngle, "°");
  document.getElementById("detail-mass").textContent        = fmt(v.mass, "lbs");
  // Status strings
  document.getElementById("detail-motor-status").textContent  = v.motorStatus   || "—";
  document.getElementById("detail-mech-status").textContent   = v.mechStatus    || "—";
  document.getElementById("detail-temp-status").textContent   = v.tempModStatus || "—";
  // Uptime
  const uptimeEl = document.getElementById("detail-uptime");
  uptimeEl.textContent = v.uptimePct !== null && v.uptimePct !== undefined
    ? `${v.uptimePct.toFixed(1)} %` : "—";

  const issuesEl = document.getElementById("detail-issues");
  const issues = Array.isArray(v.issues) ? v.issues : [];
  if (issues.length) {
    issuesEl.textContent = `⚠ Active issues: ${issues.join(" · ")}`;
    issuesEl.classList.add("has-issues");
  } else {
    issuesEl.textContent = "";
    issuesEl.classList.remove("has-issues");
  }

  document.getElementById("detail-footer").textContent =
    `Rack ${v.paused ? "paused" : "active"}`;

  document.getElementById("detail").classList.add("open");
  document.body.style.overflow = "hidden";
  history.pushState({ detail: true }, "");
}

function closeDetail() {
  document.getElementById("detail").classList.remove("open");
  document.body.style.overflow = "";
  // Re-render grid from last known data so empty slots always reappear correctly
  if (_currentData) renderGrid(_currentData);
}

/* ── Main render ─────────────────────────────────────────────────────────── */
function render(data) {
  _currentData = data;
  if (data.slotColors) _slotColors = data.slotColors;
  document.getElementById("status-message").classList.remove("visible");
  document.getElementById("grid").style.display = "";
  document.getElementById("fleet-summary").style.display = "";
  if (data.fleet) renderFleet(data.fleet);
  renderWatchdog(data.watchdog ?? null);
  renderGrid(data);
  checkStale(data.updated);
}

/* ── Fetch loop ──────────────────────────────────────────────────────────── */
async function tick() {
  try {
    const data = await fetchState();
    render(data);
  } catch (e) {
    if (!_currentData) {
      const msg = document.getElementById("status-message");
      msg.textContent = "Unable to reach data source.";
      msg.classList.add("visible");
    }
    const ind = document.getElementById("live-indicator");
    ind.classList.add("stale");
    ind.textContent = "⚠ Offline";
  }
}

/* ── Init ────────────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  if (!VESSEL_STATE_FILE_ID || VESSEL_STATE_FILE_ID === "PASTE_FILE_ID_HERE") {
    const msg = document.getElementById("status-message");
    msg.textContent = "Configuration needed: set VESSEL_STATE_FILE_ID in config.js";
    msg.classList.add("visible");
    return;
  }

  // In-app back arrow uses history.back() so popstate fires and both
  // the browser back button and the in-app button share one code path
  document.getElementById("btn-pause-all").addEventListener("click",   () => _promptWatchdogCmd("pause_all"));
  document.getElementById("btn-restart-all").addEventListener("click", () => _promptWatchdogCmd("restart_all"));
  document.getElementById("btn-wdconf-cancel").addEventListener("click", () => _cancelWatchdogConf());
  document.getElementById("btn-wdconf-ok").addEventListener("click",    () => _sendWatchdogCmd(_confirmingAction));
  document.getElementById("detail-back").addEventListener("click", () => history.back());
  window.addEventListener("popstate", () => {
    if (document.getElementById("detail").classList.contains("open")) {
      closeDetail();
    }
  });

  const msg = document.getElementById("status-message");
  msg.textContent = "Loading…";
  msg.classList.add("visible");
  document.getElementById("grid").style.display = "none";
  document.getElementById("fleet-summary").style.display = "none";

  tick();
  setInterval(tick, FETCH_INTERVAL_MS);
  setInterval(() => { if (_currentData) checkStale(_currentData.updated); }, 10_000);
});
