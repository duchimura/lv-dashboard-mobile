# Mobile Operations Status App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only mobile web app that fetches live vessel state from Google Drive and renders a condensed M/T/B bubble grid matching the desktop dashboard.

**Architecture:** `background.js` pre-computes bubble states and writes `vessel_state.json` to Google Drive every 15 s via an extended `drive-sync.js`. A static mobile web app hosted on GitHub Pages fetches that public file every 15 s and renders vessel cards with M/T/B bubbles, telemetry, and a tap-to-detail view.

**Tech Stack:** Vanilla ES modules (extension side, matching existing codebase); vanilla HTML/CSS/JS (mobile app, no framework, no bundler)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `drive-sync.js` | Modify | Add `writeVesselState(payload)` export |
| `background.js` | Modify | Angle tracking, bubble computation, snapshot write loop |
| `mobile-app/config.js` | Create | Drive file ID constant |
| `mobile-app/app.css` | Create | Dark theme, bubble styles, card grid, detail view |
| `mobile-app/app.js` | Create | Fetch loop, render grid, detail view, stale detection |
| `mobile-app/index.html` | Create | App shell |

---

## Task 1: Add `writeVesselState()` to `drive-sync.js`

**Files:**
- Modify: `drive-sync.js`

Follow the exact same pattern as `writeUptimeState()` / `_getUptimeFileId()` directly above it in the file.

- [ ] **Step 1: Add the file-name constant and cache variable**

Add after the existing `UPTIME_FILE_NAME` constant at line ~403:

```js
/* ── Mobile app vessel state (vessel_state.json) ───────────────────────── */
const VESSEL_STATE_FILE_NAME = "vessel_state.json";
let _vesselStateFileId = null;
```

- [ ] **Step 2: Add `_getVesselStateFileId()`**

Add immediately after the cache variable:

```js
async function _getVesselStateFileId() {
  if (_vesselStateFileId) return _vesselStateFileId;
  const tok = await _getToken();
  const q = encodeURIComponent(
    `name='${VESSEL_STATE_FILE_NAME}' and '${FOLDER_ID}' in parents and trashed=false`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!res.ok) throw new Error(`vessel state list ${res.status}`);
  const j = await res.json();
  if (j.files?.length) { _vesselStateFileId = j.files[0].id; return _vesselStateFileId; }
  const boundary = "vessel_state_mp";
  const mp = [
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify({ name: VESSEL_STATE_FILE_NAME, parents: [FOLDER_ID] }),
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n{}`,
    `--${boundary}--`,
  ].join("\r\n");
  const cr = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    { method: "POST",
      headers: { Authorization: `Bearer ${tok}`,
                 "Content-Type": `multipart/related; boundary=${boundary}` },
      body: mp }
  );
  if (!cr.ok) throw new Error(`vessel state create ${cr.status}`);
  _vesselStateFileId = (await cr.json()).id;
  return _vesselStateFileId;
}
```

- [ ] **Step 3: Add `writeVesselState()` export**

Add immediately after `_getVesselStateFileId()`:

```js
export async function writeVesselState(payload) {
  const tok = await _getToken();
  const id  = await _getVesselStateFileId();
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`,
    { method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload) }
  );
  if (!res.ok) throw new Error(`vessel state write ${res.status}`);
}
```

- [ ] **Step 4: Verify the file loads without errors**

Open `chrome://extensions`, reload the extension. Open the service worker DevTools console — there should be no new syntax errors. The file `vessel_state.json` does not need to exist in Drive yet; it will be created on the first write.

- [ ] **Step 5: Commit**

```
git add drive-sync.js
git commit -m "feat: add writeVesselState() to drive-sync.js"
```

---

## Task 2: Add motor tracking and bubble helpers to `background.js`

**Files:**
- Modify: `background.js`

- [ ] **Step 1: Add tracking maps and `_toF` near the top of `background.js`**

Add after the `lastHeaterActiveSeen` / `HEATER_ACTIVE_GRACE_MS` block (~line 98):

```js
// ── Mobile snapshot: motor angle tracking (mirrors dashboard.js logic) ───
const _bgLastAngles       = new Map(); // slotName → last currentAngle
const _bgMotorActiveUntil = new Map(); // slotName → ms timestamp
const _bgMotorSteadyGreen = new Map(); // slotName → boolean
// ─────────────────────────────────────────────────────────────────────────

function _toF(c) {
  return typeof c === "number" && !isNaN(c)
    ? Math.round((c * 9 / 5 + 32) * 10) / 10
    : null;
}
```

- [ ] **Step 2: Call `_updateMotorTracking()` inside `handleWsData()`**

Locate the line in `handleWsData()` that assigns `t.currentAngle`:

```js
if (typeof d.current_angle === "number") t.currentAngle = d.current_angle;
```

Replace it with:

```js
if (typeof d.current_angle === "number") {
  t.currentAngle = d.current_angle;
  _updateMotorTracking(v.slotName, d.current_angle);
}
```

Then add the `_updateMotorTracking` function definition right before `handleWsData`:

```js
function _updateMotorTracking(slotName, currentAngle) {
  if (isNaN(currentAngle)) return;
  const prev = _bgLastAngles.get(slotName);
  if (prev !== undefined && Math.abs(currentAngle - prev) > 10) {
    _bgMotorActiveUntil.set(slotName, Date.now() + 30000);
    _bgMotorSteadyGreen.set(slotName, true);
  }
  _bgLastAngles.set(slotName, currentAngle);
}
```

- [ ] **Step 3: Add bubble state helpers**

Add these three functions after `_updateMotorTracking`:

```js
function _mBubble(slotName, v) {
  const cmd = (v.mixerModuleStatus || "").toUpperCase();
  const commandIsOn  = cmd === "MIXER_RUNNING" || cmd === "MIXER_MIXING" || cmd === "ON";
  const commandIsOff = cmd === "OFF" || cmd === "MIXER_OFF";
  const stoppedUnexpectedly = cmd === "MIXER_STOPPED";
  const hasFault = v.valveModuleStatus === "VALVE_FAULT";
  const ctrlInactive = (v.mechanicalStatus || "").toLowerCase().includes("ctrl_inactive");
  const manuallyPaused = v.rackGroupPaused === true && v.row === 0;

  if (_bgMotorSteadyGreen.get(slotName)) return "on";
  if ((_bgMotorActiveUntil.get(slotName) || 0) > Date.now()) return "on";
  if (commandIsOff) return "off";
  if (stoppedUnexpectedly && hasFault) return "fault";
  if (stoppedUnexpectedly && (ctrlInactive || manuallyPaused)) return "off";
  if (stoppedUnexpectedly) return "stopped";
  if (commandIsOn) return "on";
  return "off";
}

function _tBubble(v) {
  if (v.tempControlOn === true)  return "on";
  if (v.tempControlOn === false) return "error";
  return "off";
}

function _bBubble(slotName, v) {
  const t = v.telemetry || {};
  const declogActive   = v.intake_declog_req === 1 || v.exhaust_declog_req === 1;
  const ctrlInactive   = (v.mechanicalStatus || "").toLowerCase().includes("ctrl_inactive");
  const manuallyPaused = v.rackGroupPaused === true && v.row === 0;
  if (declogActive || ctrlInactive || manuallyPaused) return "off";
  const pressure    = Number(t.pressure ?? 0);
  const rawBlowerOn = Number(t.airflow) > 0;
  const blowerOn    = (v.lastAirflowPositiveAt && Date.now() - v.lastAirflowPositiveAt < 30000)
                      || rawBlowerOn;
  if (pressure > 9 && !rawBlowerOn) return "off";
  return blowerOn ? "on" : "stopped";
}
```

- [ ] **Step 4: Reload the extension and confirm no errors**

Open the service worker DevTools console. The new functions are never called yet — there should be zero errors from this change.

- [ ] **Step 5: Commit**

```
git add background.js
git commit -m "feat: add motor tracking and bubble helpers to background.js"
```

---

## Task 3: Add snapshot payload builder and write loop to `background.js`

**Files:**
- Modify: `background.js`

- [ ] **Step 1: Import `writeVesselState` at the top of `background.js`**

The first line currently reads:

```js
import { readDriveState, writeDriveState, appendSetpointLogRows, appendMotorAuditRows, readUptimeState, writeUptimeState } from "./drive-sync.js";
```

Replace it with:

```js
import { readDriveState, writeDriveState, appendSetpointLogRows, appendMotorAuditRows, readUptimeState, writeUptimeState, writeVesselState } from "./drive-sync.js";
```

- [ ] **Step 2: Add the debounce variable and `_buildMobilePayload()`**

Add after the `_bgMotorSteadyGreen` / `_toF` block from Task 2:

```js
let _lastMobileSnapshotAt = 0;
const MOBILE_SNAPSHOT_MS  = 15_000;

async function _buildMobilePayload() {
  const { watchdog_state } = await new Promise(r =>
    chrome.storage.local.get("watchdog_state", r)
  );
  const watchdogEnabled = !!watchdog_state?.enabled;

  let running = 0, off = 0, stopped = 0, fault = 0, issues = 0;
  const vessels = [];

  for (const [slotName, v] of Object.entries(dashboardState)) {
    if (!v.vesselPresent) continue;

    const t   = v.telemetry || {};
    const mB  = _mBubble(slotName, v);
    const tB  = _tBubble(v);
    const bB  = _bBubble(slotName, v);

    const issueList = [];
    if (mB === "stopped" || mB === "fault") issueList.push("motor");
    if (tB === "error")                     issueList.push("temp");
    if (bB === "stopped")                   issueList.push("airflow");
    if (Number(t.pressure ?? 0) > 9)        issueList.push("pressure");

    const vesselStatus =
      mB === "fault"   ? "fault"   :
      mB === "stopped" ? "stopped" :
      mB === "on"      ? "running" : "off";

    if (vesselStatus === "running")      running++;
    else if (vesselStatus === "stopped") stopped++;
    else if (vesselStatus === "fault")   fault++;
    else                                 off++;
    if (issueList.length) issues++;

    const probes = [_toF(Number(t.temp0)), _toF(Number(t.temp1)), _toF(Number(t.temp2))]
      .filter(x => x !== null);
    const avgTemp = probes.length
      ? Math.round(probes.reduce((a, b) => a + b, 0) / probes.length * 10) / 10
      : null;

    vessels.push({
      id:      slotName,
      rack:    parseInt(slotName.slice(0, 3), 10),
      slot:    slotName.slice(3),
      status:  vesselStatus,
      mBubble: mB,
      tBubble: tB,
      bBubble: bB,
      temp:     avgTemp,
      airflow:  typeof t.airflow   === "number" ? Math.round(t.airflow   * 10) / 10 : null,
      pressure: typeof t.pressure  === "number" ? Math.round(t.pressure  * 100) / 100 : null,
      issues:  issueList,
      paused:  v.rackGroupPaused === true,
    });
  }

  return {
    updated: new Date().toISOString(),
    fleet:   { running, off, stopped, fault, issues },
    vessels,
    watchdog: { enabled: watchdogEnabled },
  };
}
```

- [ ] **Step 3: Add `_writeMobileSnapshot()` and `_scheduleMobileSnapshot()`**

Add immediately after `_buildMobilePayload()`:

```js
async function _writeMobileSnapshot() {
  try {
    const payload = await _buildMobilePayload();
    await writeVesselState(payload);
  } catch (e) {
    _log("⚠️ [MOBILE] snapshot write failed:", e.message);
  }
}

function _scheduleMobileSnapshot() {
  if (Date.now() - _lastMobileSnapshotAt < MOBILE_SNAPSHOT_MS) return;
  _lastMobileSnapshotAt = Date.now();
  _writeMobileSnapshot();
}
```

- [ ] **Step 4: Call `_scheduleMobileSnapshot()` at the end of `handleWsData()`**

Find the last line of `handleWsData()` — it currently ends with:

```js
  safeSend({ type: "dashboard:update", slotName: v.slotName, vessel: v });
}
```

Add the call after the `safeSend`:

```js
  safeSend({ type: "dashboard:update", slotName: v.slotName, vessel: v });
  _scheduleMobileSnapshot();
}
```

- [ ] **Step 5: Add fallback call in the watchdog alarm handler**

Find the `chrome.alarms.onAlarm.addListener` block near the bottom of the file:

```js
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "watchdogDriveSync") _drivePoll();
});
```

Replace with:

```js
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "watchdogDriveSync") {
    _drivePoll();
    _scheduleMobileSnapshot();
  }
});
```

- [ ] **Step 6: Smoke test the write**

1. Reload the extension from `chrome://extensions`.
2. Open the HMI tab (`atlas.earthfuneral.com/internal/hmi/...`) so WS data flows.
3. Wait 15–20 seconds.
4. Open Google Drive → shared folder → confirm `vessel_state.json` has appeared.
5. Open the file — confirm it is valid JSON matching the schema with real vessel data.

- [ ] **Step 7: Share `vessel_state.json` publicly**

In Google Drive: right-click `vessel_state.json` → Share → Change to "Anyone with the link" → Viewer → Copy link.

The file ID is the long alphanumeric string between `/d/` and `/view` in the link URL.

- [ ] **Step 8: Commit**

```
git add background.js
git commit -m "feat: write live vessel state snapshot to Drive every 15s"
```

---

## Task 4: Create `mobile-app/config.js`

**Files:**
- Create: `mobile-app/config.js`

- [ ] **Step 1: Create the file**

```js
// Paste the file ID from the Drive share URL (the string between /d/ and /view).
const VESSEL_STATE_FILE_ID = "PASTE_FILE_ID_HERE";
```

Replace `PASTE_FILE_ID_HERE` with the actual file ID from Task 3 Step 7.

- [ ] **Step 2: Commit**

```
git add mobile-app/config.js
git commit -m "feat: add mobile-app/config.js with Drive file ID"
```

---

## Task 5: Create `mobile-app/app.css`

**Files:**
- Create: `mobile-app/app.css`

- [ ] **Step 1: Write the stylesheet**

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  min-height: 100dvh;
}

/* ── Header ─────────────────────────────────────────────────────────────── */
#header {
  background: #0f3460;
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: sticky;
  top: 0;
  z-index: 10;
}
#header h1 { font-size: 15px; font-weight: bold; color: #f2e8d5; }
#live-indicator { font-size: 11px; color: #0f0; }
#live-indicator.stale { color: #ff9800; }

/* ── Stale banner ────────────────────────────────────────────────────────── */
#stale-banner {
  display: none;
  background: #7a5c00;
  color: #ffe082;
  font-size: 12px;
  padding: 6px 12px;
  text-align: center;
}
#stale-banner.visible { display: block; }

/* ── Fleet summary ───────────────────────────────────────────────────────── */
#fleet-summary {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
}
.fleet-chip {
  flex: 1;
  border-radius: 6px;
  padding: 6px 4px;
  text-align: center;
}
.fleet-chip .count { font-size: 16px; font-weight: bold; display: block; }
.fleet-chip .label { font-size: 9px; color: #aaa; display: block; }
.fleet-chip.running  { background: #1e3a1e; }
.fleet-chip.running .count { color: #0f0; }
.fleet-chip.issues   { background: #3a1e1e; }
.fleet-chip.issues .count  { color: #f44336; }
.fleet-chip.fault    { background: #2a2a1e; }
.fleet-chip.fault .count   { color: #ff8800; }
.fleet-chip.off      { background: #222; }
.fleet-chip.off .count     { color: #888; }

/* ── Rack sections ───────────────────────────────────────────────────────── */
#grid { padding: 0 8px 80px; }
.rack-section { margin-bottom: 12px; }
.rack-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #555;
  margin-bottom: 4px;
  padding: 0 2px;
}
.rack-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
}

/* ── Vessel card ─────────────────────────────────────────────────────────── */
.vessel-card {
  background: #222;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 7px 5px;
  text-align: center;
  cursor: pointer;
  transition: opacity 0.15s;
  -webkit-tap-highlight-color: transparent;
}
.vessel-card:active { opacity: 0.7; }
.vessel-card.issue-red    { background: #3a1e1e; border-color: #c00; }
.vessel-card.issue-orange { background: #2a2a1e; border-color: #ff8800; }
.vessel-card.vessel-off   { background: #1a1a1a; border-color: #2a2a2a; opacity: 0.5; }

.slot-id { font-size: 9px; color: #aaa; margin-bottom: 4px; font-weight: bold; }

/* ── Bubbles ─────────────────────────────────────────────────────────────── */
.bubbles-row {
  display: flex;
  justify-content: center;
  gap: 3px;
  margin-bottom: 5px;
}
.bubble {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  font-weight: bold;
  flex-shrink: 0;
}
.bubble.on      { background: #0f0;    color: #000; }
.bubble.off     { background: #777;    color: #ccc; }
.bubble.stopped { background: #c00;    color: #fff; }
.bubble.fault   { background: #ff8800; color: #fff; }
.bubble.error   { background: #c00;    color: #fff; }

/* ── Card telemetry values ───────────────────────────────────────────────── */
.card-telem {
  font-size: 8px;
  line-height: 1.7;
  color: #e0e0e0;
}
.card-telem .warn { color: #ff9800; }
.card-telem .err  { color: #c00; }
.card-telem .dim  { color: #555; }

/* ── Detail view ─────────────────────────────────────────────────────────── */
#detail {
  display: none;
  position: fixed;
  inset: 0;
  background: #1a1a2e;
  z-index: 20;
  overflow-y: auto;
}
#detail.open { display: block; }
#detail-header {
  background: #0f3460;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  position: sticky;
  top: 0;
}
#detail-back { color: #0f0; font-size: 20px; cursor: pointer; background: none; border: none; }
#detail-title { font-size: 16px; font-weight: bold; color: #f2e8d5; flex: 1; }
#detail-status-badge {
  font-size: 10px;
  font-weight: bold;
  padding: 3px 8px;
  border-radius: 10px;
  text-transform: uppercase;
}
#detail-status-badge.running  { background: #1e3a1e; color: #0f0; }
#detail-status-badge.stopped  { background: #3a1e1e; color: #c00; }
#detail-status-badge.fault    { background: #2a2a1e; color: #ff8800; }
#detail-status-badge.off      { background: #333;    color: #888; }

#detail-body { padding: 14px; }
.detail-section-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #555;
  margin-bottom: 6px;
}
#detail-bubbles {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.detail-bubble-cell {
  flex: 1;
  background: #222;
  border-radius: 6px;
  padding: 8px 4px;
  text-align: center;
}
.detail-bubble-cell .bubble { width: 22px; height: 22px; font-size: 10px; margin: 0 auto 4px; }
.detail-bubble-label { font-size: 8px; color: #aaa; }
.detail-bubble-state { font-size: 9px; margin-top: 2px; }

.detail-telem-row {
  background: #222;
  border-radius: 5px;
  padding: 10px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 5px;
}
.detail-telem-row .telem-label { color: #aaa; font-size: 13px; }
.detail-telem-row .telem-value { font-size: 15px; font-weight: bold; color: #e0e0e0; }

#detail-issues {
  margin-top: 12px;
  background: #2a1e1e;
  border-radius: 5px;
  padding: 8px 12px;
  font-size: 11px;
  color: #f44336;
  display: none;
}
#detail-issues.has-issues { display: block; }
#detail-footer {
  margin-top: 10px;
  font-size: 9px;
  color: #555;
  text-align: center;
}

/* ── Empty / loading states ──────────────────────────────────────────────── */
#status-message {
  display: none;
  text-align: center;
  padding: 60px 20px;
  color: #555;
  font-size: 14px;
}
#status-message.visible { display: block; }
```

- [ ] **Step 2: Commit**

```
git add mobile-app/app.css
git commit -m "feat: add mobile-app/app.css dark theme"
```

---

## Task 6: Create `mobile-app/app.js`

**Files:**
- Create: `mobile-app/app.js`

- [ ] **Step 1: Write the full app logic**

```js
const FETCH_INTERVAL_MS = 15_000;
const STALE_MS          = 2 * 60_000;
const DRIVE_URL = () =>
  `https://drive.google.com/uc?export=download&id=${VESSEL_STATE_FILE_ID}&ts=${Date.now()}`;

let _currentData = null;

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
  const byRack = new Map();
  for (const v of data.vessels) {
    if (!byRack.has(v.rack)) byRack.set(v.rack, []);
    byRack.get(v.rack).push(v);
  }

  const rackNums = [...byRack.keys()].sort((a, b) => a - b);
  // Reuse existing rack sections to avoid full re-render flicker
  const existingRacks = new Map([...grid.querySelectorAll(".rack-section")]
    .map(el => [parseInt(el.dataset.rack, 10), el]));

  for (const rackNum of rackNums) {
    const vessels = byRack.get(rackNum).sort((a, b) => a.slot.localeCompare(b.slot));
    let section = existingRacks.get(rackNum);
    if (!section) {
      section = document.createElement("div");
      section.className = "rack-section";
      section.dataset.rack = rackNum;
      const label = document.createElement("div");
      label.className = "rack-label";
      label.textContent = `Rack ${rackNum}`;
      section.appendChild(label);
      const cards = document.createElement("div");
      cards.className = "rack-cards";
      section.appendChild(cards);
      grid.appendChild(section);
    }
    const cardsEl = section.querySelector(".rack-cards");
    cardsEl.innerHTML = "";
    for (const v of vessels) {
      cardsEl.appendChild(makeCard(v));
    }
  }
}

/* ── Make card ───────────────────────────────────────────────────────────── */
function makeCard(v) {
  const card = document.createElement("div");
  card.className = cardClass(v);
  card.addEventListener("click", () => openDetail(v));

  const id = document.createElement("div");
  id.className = "slot-id";
  id.textContent = v.id;

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
    const tempClass = v.tBubble === "error" ? "warn" : "";
    const flowClass = v.bBubble === "stopped" ? "err" : "";
    const pressClass = (v.pressure !== null && v.pressure > 9) ? "err" : "";
    telem.innerHTML =
      `<div class="${tempClass}">${fmt(v.temp, "°F")}</div>` +
      `<div class="${flowClass}">${fmt(v.airflow, "l/m")}</div>` +
      `<div class="${pressClass}">${fmt(v.pressure, "kPa")}</div>`;
  }

  card.appendChild(id);
  card.appendChild(bubblesRow);
  card.appendChild(telem);
  return card;
}

/* ── Fleet summary ───────────────────────────────────────────────────────── */
function renderFleet(fleet) {
  document.querySelector(".fleet-chip.running .count").textContent  = fleet.running;
  document.querySelector(".fleet-chip.issues .count").textContent   = fleet.issues;
  document.querySelector(".fleet-chip.fault .count").textContent    = fleet.fault;
  document.querySelector(".fleet-chip.off .count").textContent      = fleet.off;
}

/* ── Detail view ─────────────────────────────────────────────────────────── */
function openDetail(v) {
  document.getElementById("detail-title").textContent = `Vessel ${v.id}`;
  const badge = document.getElementById("detail-status-badge");
  badge.textContent = v.status.toUpperCase();
  badge.className = `detail-status-badge ${v.status}` ;

  const bubblesEl = document.getElementById("detail-bubbles");
  bubblesEl.innerHTML = "";
  const defs = [
    { letter: "M", state: v.mBubble, label: "Motor",    stateLabel: { on:"Running", off:"Off", stopped:"Stopped", fault:"Fault" } },
    { letter: "T", state: v.tBubble, label: "Temp Ctrl", stateLabel: { on:"On",     off:"Off", error:"Off (⚠)" } },
    { letter: "B", state: v.bBubble, label: "Blower",   stateLabel: { on:"Running", off:"Off", stopped:"Stopped" } },
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

  document.getElementById("detail-temp").textContent    = fmt(v.temp, "°F");
  document.getElementById("detail-airflow").textContent = fmt(v.airflow, "l/m");
  document.getElementById("detail-pressure").textContent = fmt(v.pressure, "kPa");

  const issuesEl = document.getElementById("detail-issues");
  if (v.issues.length) {
    issuesEl.textContent = `⚠ Active issues: ${v.issues.join(" · ")}`;
    issuesEl.classList.add("has-issues");
  } else {
    issuesEl.classList.remove("has-issues");
  }

  document.getElementById("detail-footer").textContent =
    `Rack ${v.rack === 0 || v.paused ? "paused" : "active"}`;

  document.getElementById("detail").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeDetail() {
  document.getElementById("detail").classList.remove("open");
  document.body.style.overflow = "";
}

/* ── Main render ─────────────────────────────────────────────────────────── */
function render(data) {
  _currentData = data;
  document.getElementById("status-message").classList.remove("visible");
  document.getElementById("grid").style.display = "";
  document.getElementById("fleet-summary").style.display = "";
  renderFleet(data.fleet);
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
  document.getElementById("detail-back").addEventListener("click", closeDetail);

  // Show loading state
  const msg = document.getElementById("status-message");
  msg.textContent = "Loading…";
  msg.classList.add("visible");
  document.getElementById("grid").style.display = "none";
  document.getElementById("fleet-summary").style.display = "none";

  tick();
  setInterval(tick, FETCH_INTERVAL_MS);
  setInterval(() => { if (_currentData) checkStale(_currentData.updated); }, 10_000);
});
```

- [ ] **Step 2: Commit**

```
git add mobile-app/app.js
git commit -m "feat: add mobile-app/app.js fetch loop and render logic"
```

---

## Task 7: Create `mobile-app/index.html`

**Files:**
- Create: `mobile-app/index.html`

- [ ] **Step 1: Write the HTML shell**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="theme-color" content="#0f3460" />
  <title>Operations Status</title>
  <link rel="stylesheet" href="app.css" />
</head>
<body>

  <div id="header">
    <h1>⚙ Operations</h1>
    <span id="live-indicator">● Connecting…</span>
  </div>

  <div id="stale-banner"></div>

  <div id="fleet-summary">
    <div class="fleet-chip running">
      <span class="count">—</span>
      <span class="label">Running</span>
    </div>
    <div class="fleet-chip issues">
      <span class="count">—</span>
      <span class="label">Issues</span>
    </div>
    <div class="fleet-chip fault">
      <span class="count">—</span>
      <span class="label">Fault</span>
    </div>
    <div class="fleet-chip off">
      <span class="count">—</span>
      <span class="label">Off</span>
    </div>
  </div>

  <div id="status-message"></div>
  <div id="grid"></div>

  <!-- Detail view (full-screen overlay) -->
  <div id="detail">
    <div id="detail-header">
      <button id="detail-back">&#8592;</button>
      <span id="detail-title"></span>
      <span id="detail-status-badge"></span>
    </div>
    <div id="detail-body">
      <div class="detail-section-label" style="margin-bottom:6px">Status</div>
      <div id="detail-bubbles"></div>

      <div class="detail-section-label" style="margin-bottom:6px">Telemetry</div>
      <div class="detail-telem-row">
        <span class="telem-label">Avg Temp</span>
        <span class="telem-value" id="detail-temp">—</span>
      </div>
      <div class="detail-telem-row">
        <span class="telem-label">Airflow</span>
        <span class="telem-value" id="detail-airflow">—</span>
      </div>
      <div class="detail-telem-row">
        <span class="telem-label">Pressure</span>
        <span class="telem-value" id="detail-pressure">—</span>
      </div>

      <div id="detail-issues"></div>
      <div id="detail-footer"></div>
    </div>
  </div>

  <script src="config.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Test locally in a browser**

Open `mobile-app/index.html` directly in Chrome (file:// URL). Because the Drive URL is cross-origin, `fetch()` will be blocked in file:// context. To test locally:

```
# From inside mobile-app/
npx serve .
# or: python -m http.server 8080
```

Open `http://localhost:8080`. After a few seconds you should see the fleet summary, rack sections, and vessel cards with M/T/B bubbles. Confirm:
- Bubble colors match the desktop dashboard
- Tapping a card opens the detail overlay
- Back button closes detail
- If `vessel_state.json` has a real `updated` timestamp, the live indicator shows the correct age

- [ ] **Step 3: Test stale banner**

Temporarily set `STALE_MS = 1` in `app.js`, reload, confirm the yellow banner appears. Revert.

- [ ] **Step 4: Test on a real phone**

On the same local network as your laptop, open `http://<laptop-ip>:8080` in Safari (iPhone) or Chrome (Android). Confirm cards render at correct size and tapping works.

- [ ] **Step 5: Commit**

```
git add mobile-app/index.html
git commit -m "feat: add mobile-app/index.html shell"
```

---

## Task 8: Deploy to GitHub Pages

**Files:** None (deployment config only)

- [ ] **Step 1: Create a GitHub repo for the mobile app**

```
gh repo create operations-status-mobile --public --source=mobile-app --push
```

Or manually: create a new repo on GitHub, add `mobile-app/` as the root, push.

- [ ] **Step 2: Enable GitHub Pages**

In the repo → Settings → Pages → Source: Deploy from branch `main`, folder `/` (root). Save.

GitHub will publish the app at `https://<username>.github.io/operations-status-mobile/`.

- [ ] **Step 3: Verify on a phone over cellular**

Switch your phone to cellular data (no WiFi). Open the GitHub Pages URL in Safari/Chrome. Confirm vessel data loads — this proves the Drive fetch works from outside the facility network.

- [ ] **Step 4: Share the URL**

Send the URL to anyone who needs access. They open it in their phone browser; optionally tap "Share → Add to Home Screen" for an app-like icon.

---

## Self-Review Notes

- **Spec coverage:** Architecture ✓ · Data schema ✓ · Grid view ✓ · Detail view ✓ · Stale banner ✓ · drive-sync.js ✓ · background.js ✓ · mobile-app files ✓ · One-time setup ✓ · Edge cases (stale, 404, offline) ✓
- **Type consistency:** `writeVesselState` defined in Task 1, imported in Task 3 Step 1. Bubble state strings (`"on"`, `"off"`, `"stopped"`, `"fault"`, `"error"`) consistent across background.js helpers and app.js CSS classes.
- **No placeholders:** All code shown in full. `PASTE_FILE_ID_HERE` in config.js is intentional — filled during Task 3 Step 7.
