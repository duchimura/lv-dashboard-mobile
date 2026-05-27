import { readDriveState, writeDriveState, appendSetpointLogRows, appendMotorAuditRows, readUptimeState, writeUptimeState, writeVesselState } from "./drive-sync.js";

// date+time stamp for every console.log post
function _log(...args) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}]`, ...args);
}

let dashboardState = {};
let vesselIdToSlot = {}; // numeric vessel_id → slot name (e.g. 36 → "001A")
let unrackedVessels = []; // [{ id, name }, …] vessels not assigned to any rack slot

// ═══ UPTIME TRACKING ════════════════════════════════════════════════════════
// Owner (kiosk PC) polls Grafana every 2 min and writes results to Drive.
// All other machines read from Drive — they never poll Grafana directly.
//
// _uptimeData shape: { [vesselId]: { caseName, caseStartAt, grafanaPct, lastFetchAt } }
//   grafanaPct  — 0-100 from last successful Grafana poll, null until first fetch
//   caseStartAt — vessel's lastUsed date, used as the Grafana query start time
//   caseName    — from hall-view scrape, used to detect case turnovers
//
// Credentials stored in chrome.storage.local:
//   GRAFANA_URL      — e.g. "https://grafana.earthfuneral.tech"
//   GRAFANA_USER     — basic-auth username
//   GRAFANA_PASS     — basic-auth password
//   GRAFANA_DS_UID   — datasource UID (e.g. "dstimescale1")
//   GRAFANA_RACK_PFX — facility rack_id prefix (e.g. "11")
let _uptimeData        = {};
let _hallViewCaseNames = {}; // slotName → case name from content.js hall-view scrape

function _caseStartTs(slotName) {
  const lu = dashboardState[slotName]?.lastUsed;
  const d  = lu ? Date.parse(lu) : NaN;
  return isNaN(d) ? Date.now() : d;
}

function _uptimeRecord(caseName, caseStartAt) {
  return { caseName: caseName ?? null, caseStartAt: caseStartAt ?? Date.now(),
           grafanaPct: null, lastFetchAt: null };
}

function computeUptimePct(vesselId) {
  return _uptimeData[vesselId]?.grafanaPct ?? null;
}
// ════════════════════════════════════════════════════════════════════════════
let _initialSyncDone = false; // true after first syncRackPauseState() completes on startup

// Serial queue for reset-motor-card: HMI shows one card at a time,
// so concurrent card-open requests must be serialized.
let _motorCardResetQueue = Promise.resolve();

// Watchdog
let _watchdogInterval = null;
let _driveLastKnownAt = 0; // changedAt of the last Drive state we wrote or applied
// Tracks slots that received a first-attempt motor restart (speed 59).
// If the slot is still stopped on the next tick, a fault-reset + speed 60 is sent.
// Entries are cleared when the motor confirms running or enters the fault path.
const _watchdogMotorRetry     = new Map(); // slotName → timestamp of first attempt
const _watchdogMotorFailCount = new Map(); // slotName → exhausted retry cycle count
const _watchdogRackResetAt    = new Map(); // slotName → timestamp of last rack reset
const _pendingMotorLog        = new Map(); // slotName → row pending motor-running confirmation
const _watchdogValveFaultActive = new Map(); // slotName → true while valve fault is active; cleared when fault resolves
const RACK_RESET_THRESHOLD    = 3;         // exhausted retry cycles before rack reset

// Tracks all hidden popup window IDs opened by watchdog helper functions.
// Swept clean at the start of each new popup call so windows left open by a
// previously interrupted call (e.g. service worker killed mid-execution) are
// closed before a new one is created.
const _popupWinIds = new Set();
async function _closeStalePopups() {
  // Close windows tracked in-memory from this service worker lifetime.
  for (const id of [..._popupWinIds]) {
    try { await chrome.windows.remove(id); } catch (_) {}
    _popupWinIds.delete(id);
  }
  // Also sweep chrome.windows for any popup windows at the HMI vessel URL that
  // were left open by a previous service worker instance (survived SW restart).
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
    for (const win of wins) {
      const isHmiPopup = win.tabs?.some(t =>
        t.url?.includes("/internal/hmi/vessels/") ||
        t.url?.includes("/internal/hmi/v2/vessels/")
      );
      if (isHmiPopup) {
        try { await chrome.windows.remove(win.id); } catch (_) {}
      }
    }
  } catch (_) {}
}
const RACK_RESET_COOLDOWN_MS  = 10 * 60_000; // 10 min between rack resets per slot

// Tracks the last time heater_control_active:true was seen per slot.
// Used to debounce the OFF transition — a single frame without the field
// does not mean the heater is off; it just means that frame didn't include it.
const lastHeaterActiveSeen = {}; // slotName → Date.now() ms
const HEATER_ACTIVE_GRACE_MS = 30000; // 30 s without heater_control_active:true → OFF

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

const injectedTabs = new Set();
let lastWsMessage = Date.now();

/************************************************************
 * SERVICE WORKER KEEP-ALIVE
 *
 * MV3 service workers suspend after ~30 s of inactivity. Any
 * in-flight async operation that spans a suspension boundary
 * silently drops the message port ("message port closed before
 * a response was received"). Holding an open chrome.runtime
 * connect port prevents suspension for the duration.
 *
 * dashboard.js opens a "keepAlive" port before each automation
 * and disconnects it once the response arrives.
 ************************************************************/
const keepAlivePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "keepAlive") return;
  keepAlivePorts.add(port);
  port.onDisconnect.addListener(() => keepAlivePorts.delete(port));
});

// Prevent Chrome from discarding the dashboard tab
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url && tab.url.includes("dashboard.html")) {
    chrome.tabs.update(tab.id, { autoDiscardable: false });
    _log("🔒 Dashboard tab protected from discard:", tab.id);
  }
});

// SAFE MESSAGE SENDER
function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (e) {}
}

// MAIN WORLD HOOK (WebSocket + EventSource)
function injectWSHook(tabId) {
  if (injectedTabs.has(tabId)) return;
  injectedTabs.add(tabId);

  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      (function installHook() {
        if (window.__WS_HOOK_INSTALLED__) return;
        window.__WS_HOOK_INSTALLED__ = true;

        const OriginalWebSocket = window.WebSocket;
        function WrappedWebSocket(url, protocols) {
          const ws = new OriginalWebSocket(url, protocols);

          // ── Track all open sockets by URL ──────────────────────
          // Stored as window.__WS_SOCKETS__ (Map: url → ws) so the
          // send helper can filter to the HMI host and ignore any
          // third-party sockets (PostHog, etc.) that open later and
          // would otherwise overwrite a single-socket reference.
          if (!window.__WS_SOCKETS__) window.__WS_SOCKETS__ = new Map();
          ws.addEventListener("open", () => {
            window.__WS_SOCKETS__.set(ws.url, ws);
          });
          ws.addEventListener("close", () => {
            window.__WS_SOCKETS__.delete(ws.url);
          });
          // ── Outgoing command interceptor ───────────────────────
          // Wraps ws.send so every command the HMI page sends to the
          // server is forwarded to the background as WS_CTRL. This
          // lets us discover the exact payload for any HMI action
          // (e.g. fault reset) without needing to open a card.
          const _origSend = ws.send.bind(ws);
          ws.send = function (data) {
            try {
              const parsed = JSON.parse(data);
              window.postMessage(
                { __rack: true, type: "WS_CTRL", data: parsed },
                window.location.origin,
              );
            } catch (e) {}
            return _origSend(data);
          };
          // ── Incoming telemetry ─────────────────────────────────
          ws.addEventListener("message", (event) => {
            try {
              const data = JSON.parse(event.data);
              if (data && data.type === "data" && data.vessel_id) {
                window.postMessage(
                  { __rack: true, type: "WS_DATA", data },
                  window.location.origin,
                );
              }
            } catch (e) {
              console.log("📨 HMI WS RAW (non-JSON):", event.data);
            }
          });

          return ws;
        }
        WrappedWebSocket.prototype = OriginalWebSocket.prototype;
        Object.setPrototypeOf(WrappedWebSocket, OriginalWebSocket);
        window.WebSocket = WrappedWebSocket;

        // Passive fetch interceptor
        // Kept as a stub in case future endpoints need interception.
        if (!window.__FETCH_INTERCEPTOR_INSTALLED__) {
          window.__FETCH_INTERCEPTOR_INSTALLED__ = true;
        }

        const OriginalEventSource = window.EventSource;
        function WrappedEventSource(url, config) {
          const es = new OriginalEventSource(url, config);
          es.addEventListener("message", (event) => {
            try {
              const data = JSON.parse(event.data);
              if (data && data.type === "data" && data.vessel_id) {
                window.postMessage(
                  { __rack: true, type: "WS_DATA", data },
                  window.location.origin,
                );
              }
            } catch (e) {}
          });
          return es;
        }
        WrappedEventSource.prototype = OriginalEventSource.prototype;
        Object.setPrototypeOf(WrappedEventSource, OriginalEventSource);
        window.EventSource = WrappedEventSource;

        console.log("✅ HOOK ACTIVE");
      })();
    },
  });
}

// INJECT HOOK ASAP — clear injectedTabs on loading so the
// hook is always reinstalled after a reload or navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    injectedTabs.delete(tabId);
  }

  // When the dashboard tab finishes loading, give WS 5 s to prove it's alive.
  // If no messages arrive by then, trigger recovery immediately rather than
  // waiting for the 30-second stale timer.
  if (changeInfo.status === "complete" && tab.url?.includes("dashboard.html")) {
    setTimeout(() => {
      if (Date.now() - lastWsMessage <= 5000) return;
      chrome.tabs.query({}, (tabs) => {
        const hmiTab = tabs.find((t) => t.url?.includes("/internal/hmi/"));
        if (!hmiTab) return;
        if (Date.now() - lastReloadTime < RELOAD_COOLDOWN) {
          console.warn(
            "⚠️ Dashboard opened, WS stale — re-injection only (reload on cooldown)",
          );
          injectedTabs.delete(hmiTab.id);
          injectWSHook(hmiTab.id);
          return;
        }
        console.warn("🔥 Dashboard opened with stale WS → fast HMI reload");
        lastReloadTime = Date.now();
        injectedTabs.delete(hmiTab.id);
        chrome.tabs.reload(hmiTab.id, { bypassCache: true });
      });
    }, 5000);
  }

  if (!tab.url?.includes("/internal/hmi/")) return;
  if (changeInfo.status === "loading" || changeInfo.status === "complete") {
    injectWSHook(tabId);
  }
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  injectedTabs.delete(removedTabId);
});

// HANDLE WS_DATA

function _updateMotorTracking(slotName, currentAngle) {
  if (isNaN(currentAngle)) return;
  const prev = _bgLastAngles.get(slotName);
  if (prev !== undefined && Math.abs(currentAngle - prev) > 10) {
    _bgMotorActiveUntil.set(slotName, Date.now() + 30000);
    _bgMotorSteadyGreen.set(slotName, true);
  }
  _bgLastAngles.set(slotName, currentAngle);
}

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

function handleWsData(msg) {
  lastWsMessage = Date.now();

  const d = msg.data;
  // Incoming telemetry vessel_id may be the slot name ("001A") OR a numeric
  // database ID depending on message type. Try the direct slot-name lookup
  // first (the common case), then fall back to the numeric reverse-map.
  const v =
    dashboardState[d.vessel_id] ??
    (vesselIdToSlot[d.vessel_id] != null
      ? dashboardState[vesselIdToSlot[d.vessel_id]]
      : null);
  if (!v) {
    // One-time diagnostic — remove once vessel_id format is confirmed
    if (!handleWsData._logged) {
      handleWsData._logged = true;
      console.warn(
        "⚠️ handleWsData: no slot found for vessel_id",
        d.vessel_id,
        "| type:",
        typeof d.vessel_id,
        "| sample keys:",
        Object.keys(dashboardState).slice(0, 3),
      );
    }
    return;
  }

  if (!v.telemetry) v.telemetry = {};
  const t = v.telemetry;

  if (typeof d.process_temp === "number") t.processTemp = d.process_temp;
  if (typeof d.heater_temp === "number") t.heaterTemp = d.heater_temp;
  if (typeof d.temp_0 === "number") t.temp0 = d.temp_0;
  if (typeof d.temp_1 === "number") t.temp1 = d.temp_1;
  if (typeof d.temp_2 === "number") t.temp2 = d.temp_2;
  if (typeof d.mass === "number") t.mass = d.mass;
  if (typeof d.current_angle === "number") {
    t.currentAngle = d.current_angle;
    _updateMotorTracking(v.slotName, d.current_angle);
  }
  if (typeof d.airflow === "number") {
    t.airflow = d.airflow;
    if (d.airflow > 0) v.lastAirflowPositiveAt = Date.now();
  }
  if (typeof d.pressure === "number") t.pressure = d.pressure;

  if (typeof d.intake_declog_req !== "undefined" || typeof d.exhaust_declog_req !== "undefined") {
    const wasActive = v.intake_declog_req === 1 || v.exhaust_declog_req === 1;
    if (typeof d.intake_declog_req  !== "undefined") v.intake_declog_req  = d.intake_declog_req;
    if (typeof d.exhaust_declog_req !== "undefined") v.exhaust_declog_req = d.exhaust_declog_req;
    const nowActive = v.intake_declog_req === 1 || v.exhaust_declog_req === 1;
    if (wasActive && !nowActive) v.lastDeclogClearedAt = Date.now();
  }

  // Update mixer status from live WS data — more current than the 2-min API refresh.
  // Strip ANSI color codes from the status string before storing.
  // Handle both {str: "..."} object form and plain string form from the HMI.
  const _mixerStatusRaw =
    d.mixer_status?.str ??
    (typeof d.mixer_status === "string" ? d.mixer_status : null);
  if (_mixerStatusRaw) {
    v.mixerModuleStatus = _mixerStatusRaw
      .replace(/\x1b\[[0-9;]*m/g, "")
      .trim();
  }

  // Clear motor steady-green latch when status confirms motor is off/faulted
  const _mixerUpper = (v.mixerModuleStatus || "").toUpperCase();
  const _motorKnownOff =
    _mixerUpper === "OFF" ||
    _mixerUpper === "MIXER_OFF" ||
    _mixerUpper === "POWER_INACTIVE" ||
    _mixerUpper === "MIXER_STOPPED" ||
    _mixerUpper.includes("FAULTED");
  if (_motorKnownOff) {
    _bgMotorSteadyGreen.set(v.slotName, false);
    _bgMotorActiveUntil.set(v.slotName, 0);
  }

  // TEMP CONTROL STATE (authoritative from WS telemetry)
  // Rules:
  // - heater_control_active: true → ON
  // - field absent BUT temp data present → OFF
  // - no temp data → leave unchanged

  const hasTempData =
    typeof d.process_temp === "number" || typeof d.heater_temp === "number";

  // heater_control_active:true appears in frames when the heater is running.
  // It is NOT in every frame — partial frames omit it even when the heater is on.
  // So only declare OFF after a sustained absence (grace period), not on a
  // single frame that lacks the field.
  if (d.heater_control_active === true) {
    lastHeaterActiveSeen[v.slotName] = Date.now();
    if (v.tempControlOn !== true) v.tempControlOn = true;
  } else if (hasTempData) {
    const age = Date.now() - (lastHeaterActiveSeen[v.slotName] || 0);
    if (age > HEATER_ACTIVE_GRACE_MS && v.tempControlOn !== false) {
      v.tempControlOn = false;
    }
  }

  t.lastUpdate = new Date().toISOString();

  // ═══ UPTIME: attach computed % to vessel before broadcast ════════════
  v.motorUptimePct = v.vesselId != null ? computeUptimePct(v.vesselId) : null;
  // ════════════════════════════════════════════════════════════════════

  safeSend({ type: "dashboard:update", slotName: v.slotName, vessel: v });
  _scheduleMobileSnapshot();
}

// MESSAGE HANDLER (CLEAN + DIRECT WS CONTROL)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "heartbeat") {
    sendResponse({ ok: true });
    return true;
  }

  // WS_CTRL — outgoing HMI commands captured by the send interceptor in the hook.
  // Logged here so we can read the exact payload for any button click (e.g. fault
  // reset) and later replicate it via sendWsSetpoint without opening a card.
  if (msg.type === "WS_CTRL") {
    _log("📡 [HMI-OUT]", JSON.stringify(msg.data));
    return;
  }

  if (msg.type === "dashboard:get") {
    sendResponse({ state: dashboardState, unrackedVessels });
    return true;
  }

  if (msg.type === "dashboard:request-pause-sync") {
    // Dashboard just opened — pull latest watchdog state from Drive immediately
    _drivePoll().catch(() => {});
    // Run a fresh sync and signal when done.
    (async () => {
      try {
        await syncRackPauseState(true);
      } catch (e) {
        _log("⚠️ on-demand syncRackPauseState error:", e);
      }
      try {
        const dashTabs = await chrome.tabs.query({
          url: chrome.runtime.getURL("dashboard.html"),
        });
        for (const tab of dashTabs) {
          chrome.tabs
            .sendMessage(tab.id, { type: "hmi:sync-complete" })
            .catch(() => {});
        }
      } catch (e) {}
    })();
    return false;
  }

  if (msg.type === "dashboard:refresh-setpoints") {
    if (!setpointCollectionRunning) collectAllSetpoints();
    return;
  }

  if (msg.type === "dashboard:ping") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "xcancel:fetch-page") {
    (async () => {
      try {
        const res = await fetch("https://xcancel.com/Earth_Funeral", {
          signal: AbortSignal.timeout(8000),
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
          },
        });
        console.log("[xcancel] fetch status:", res.status, res.ok);
        if (!res.ok) { sendResponse({ ok: false }); return; }
        const html = await res.text();
        console.log("[xcancel] html length:", html.length);
        const doc = new DOMParser().parseFromString(html, "text/html");
        const rawHref = doc.querySelector('link[rel="stylesheet"]')?.getAttribute("href") ?? "";
        const stylesheet = rawHref.startsWith("http")
          ? rawHref
          : `https://xcancel.com${rawHref.startsWith("/") ? "" : "/"}${rawHref}`;
        console.log("[xcancel] stylesheet:", stylesheet);
        const allItems = [...doc.querySelectorAll(".timeline-item")];
        console.log("[xcancel] .timeline-item count:", allItems.length);
        const tweets = allItems
          .filter((el) => !el.querySelector(".pinned"))
          .slice(0, 4)
          .map((el) => el.outerHTML);
        console.log("[xcancel] tweets after filter:", tweets.length);
        if (!tweets.length) {
          // Log a snippet of the body to check if markup changed
          console.warn("[xcancel] no tweets found; body snippet:", doc.body?.innerHTML?.slice(0, 500));
          sendResponse({ ok: false }); return;
        }
        sendResponse({ ok: true, tweets, stylesheet });
      } catch (err) {
        console.error("[xcancel] fetch error:", err);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === "nitter:fetch-rss") {
    if (!_isWatchdogOwner()) { sendResponse({ ok: false }); return true; }
    // Service worker fetches are fingerprinted as bots (Sec-Fetch-Mode: cors).
    // Open a real browser tab (Sec-Fetch-Mode: navigate) to the HTML profile
    // page, read .timeline-item nodes from the already-rendered DOM, close tab.
    const NITTER_HOSTS = [
      "https://nitter.poast.org",
      "https://nitter.space",
    ];
    (async () => {
      for (const host of NITTER_HOSTS) {
        let tabId;
        try {
          const url = `${host}/Earth_Funeral`;
          const tab = await chrome.tabs.create({ url, active: false });
          tabId = tab.id;
          console.log(`[nitter-tab] opened tab ${tabId} → ${url}`);

          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), 12000);
            const listener = (id, info) => {
              if (id !== tabId) return;
              if (info.status === "complete") {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });

          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const stylesheet = document.querySelector('link[rel="stylesheet"]')?.href ?? "";
              const tweets = [...document.querySelectorAll(".timeline-item")]
                .filter(el => !el.querySelector(".pinned"))
                .slice(0, 4)
                .map(el => el.outerHTML);
              return { tweets, stylesheet };
            },
          });

          await chrome.tabs.remove(tabId);
          tabId = null;

          const { tweets, stylesheet } = results?.[0]?.result ?? {};
          console.log(`[nitter-tab] ${host} tweets: ${tweets?.length ?? 0}`);
          if (tweets?.length) {
            sendResponse({ ok: true, tweets, stylesheet, host });
            return;
          }
        } catch (err) {
          console.warn(`[nitter-tab] ${host} error:`, err?.message ?? err);
          if (tabId) chrome.tabs.remove(tabId).catch(() => {});
        }
      }
      sendResponse({ ok: false });
    })();
    return true;
  }

  if (msg.type === "x:fetch-from-tab") {
    (async () => {
      const allTabs = await chrome.tabs.query({});
      const xTab = allTabs.find(t =>
        t.url && (t.url.includes("x.com/Earth_Funeral") || t.url.includes("twitter.com/Earth_Funeral"))
      );
      if (!xTab) {
        console.warn("[x-tab] no x.com/Earth_Funeral tab found");
        sendResponse({ ok: false, reason: "no-tab" });
        return;
      }
      console.log(`[x-tab] found tab ${xTab.id}: ${xTab.url}`);
      try {
        // Extract structured tweet data directly from the live x.com tab
        const results = await chrome.scripting.executeScript({
          target: { tabId: xTab.id },
          func: () => {
            const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 5);
            return articles.map(a => {
              const nameEl = a.querySelector('[data-testid="User-Name"]');
              const nameText = nameEl?.textContent?.trim() || '';
              const handleMatch = nameText.match(/@[\w]+/);
              const handle = handleMatch ? handleMatch[0] : '';
              const displayName = handle
                ? nameText.slice(0, nameText.indexOf(handle)).trim().replace(/\s+/g, ' ')
                : nameText;

              const profileImg = a.querySelector('img[src*="profile_images"]')?.src || '';

              const textEl = a.querySelector('[data-testid="tweetText"]');
              const text = textEl?.textContent?.trim() || '';

              const imgs = [...a.querySelectorAll('[data-testid="tweetPhoto"] img')]
                .map(img => img.src.replace(/([?&]name=)[^&]+/, '$1large'))
                .filter(Boolean);

              const time = a.querySelector('time')?.getAttribute('datetime') || '';

              return { displayName, handle, profileImg, text, imgs, time };
            }).filter(t => t.text);
          },
        });

        const tweets = results?.[0]?.result ?? [];
        console.log(`[x-tab] extracted ${tweets.length} tweets`);
        sendResponse({ ok: tweets.length > 0, tweets });
      } catch (err) {
        console.error("[x-tab] error:", err?.message);
        sendResponse({ ok: false, reason: err?.message });
      }
    })();
    return true;
  }

  if (msg.type === "slack:fetch-tickets") {
    (async () => {
      const s = await new Promise(r => chrome.storage.local.get(["SLACK_TOKEN"], r));
      const token = s.SLACK_TOKEN;
      if (!token) { sendResponse({ ok: false, error: "Slack token not configured — open Extension Options." }); return; }
      fetch(
        "https://slack.com/api/conversations.history?channel=C07FMS4UFPV&limit=200",
        { headers: { Authorization: `Bearer ${token}` } },
      )
        .then((r) => r.json())
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
    })();
    return true;
  }

  if (msg.type === "WS_DATA") {
    handleWsData(msg);
    return;
  }

  //  DIRECT SETPOINT CONTROL (NO HMI CLICKING)
  if (msg.type === "setpoint:set") {
    (async () => {
      const { slotName, spType, value } = msg;
      const numVal = Number(value);

      const SETPOINT_LIMITS = {
        temp: { min: 32, max: 212 }, // °F — freezing to boiling
        motor: { min: 0, max: 3600 }, // rotations/hr
        blower: { min: 0, max: 100 }, // airflow units
        "temp-ctrl": { min: 0, max: 1 },
      };
      const limits = SETPOINT_LIMITS[spType];
      if (
        !limits ||
        isNaN(numVal) ||
        numVal < limits.min ||
        numVal > limits.max
      ) {
        console.warn(
          `❌ setpoint:set — value ${value} out of range for type ${spType}`,
        );
        sendResponse({
          ok: false,
          error: `Value ${value} out of range for ${spType}`,
        });
        return;
      }

      _log(
        `📥 setpoint:set received — slot:${slotName} type:${spType} value:${value}`,
      );

      const vessel = dashboardState[slotName];
      if (!vessel || vessel.vesselId == null) {
        console.warn(`❌ setpoint:set — no vessel at slot ${slotName}`);
        sendResponse({ ok: false, error: `No vessel at slot ${slotName}` });
        return;
      }

      const tabs = await chrome.tabs.query({});
      const hmiTab = tabs.find((t) => t.url?.includes("/internal/hmi/"));

      if (!hmiTab) {
        console.warn("❌ setpoint:set — HMI tab not found");
        sendResponse({ ok: false, error: "HMI tab not found" });
        return;
      }

      _log(
        `🌐 setpoint:set — sending to HMI tab ${hmiTab.id} vesselId:${vessel.vesselId}`,
      );

      try {
        await sendWsSetpoint(hmiTab.id, vessel.vesselId, spType, numVal);
        _log(
          `✅ setpoint:set — sendWsSetpoint resolved for slot:${slotName} type:${spType} value:${numVal}`,
        );
        chrome.tabs.sendMessage(hmiTab.id, { type: "SCRAPE_NOW" });

        setTimeout(collectAllSetpoints, 1000);

        // Optimistic UI update
        if (!vessel.setpoints) vessel.setpoints = {};

        if (spType === "temp") vessel.setpoints.tempSp = numVal;
        if (spType === "motor") vessel.setpoints.motorSp = numVal;
        if (spType === "blower") vessel.setpoints.airflowSp = numVal;
        if (spType === "temp-ctrl") {
          // do NOT set tempControlOn optimistically
          // wait for real state from HMI/API
        }

        safeSend({
          type: "dashboard:update",
          slotName,
          vessel,
        });

        sendResponse({ ok: true });
      } catch (err) {
        console.error(
          `❌ setpoint:set — error for slot:${slotName} type:${spType} value:${value} →`,
          err.message,
        );
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "pause-all-racks") {
    (async () => {
      // Always disable watchdog — must happen even when triggered from a non-kiosk
      // PC (no HMI tab here). Drive sync propagates the disabled state to the kiosk.
      // Watchdog is restarted manually only.
      const time = new Date().toLocaleTimeString("en-US", { hour12: false });
      const disabledState = {
        enabled: false,
        changedBy: "pause-all",
        ownedBy: null,
        time,
        changedAt: Date.now(),
      };
      await new Promise(resolve => {
        chrome.storage.local.get(["watchdog_log"], ({ watchdog_log = [] }) => {
          const entry = { time, type: "toggle", action: "Disabled", by: "Pause All Racks", ts: Date.now() };
          const log = [entry, ...watchdog_log].slice(0, 100);
          chrome.storage.local.set({ watchdog_state: disabledState, watchdog_log: log }, resolve);
        });
      });
      _driveLastKnownAt = disabledState.changedAt;
      writeDriveState(disabledState).catch(e => _log("⚠️ [DRIVE SYNC] Write failed:", e.message));
      _log("🤖 Watchdog DISABLED by pause-all-racks");

      const tabs = await chrome.tabs.query({});
      const hmiTab = tabs.find((t) => t.url?.includes("/internal/hmi/"));
      if (!hmiTab) {
        console.warn("❌ pause-all-racks — HMI tab not found");
        sendResponse({ ok: false, error: "HMI tab not found" });
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: hmiTab.id },
          world: "MAIN",
          func: () => {
            const groups = document.querySelectorAll(
              "#vessels_hall_view .hmi_vessels_view__content__rack_groups > div",
            );
            let clicked = 0;
            for (const group of groups) {
              const btn = group.querySelector(
                ".hmi_vessels_view__content__rack_groups__group__footer div > a",
              );
              if (btn) {
                btn.click();
                clicked++;
              }
            }
            return clicked;
          },
        });
        const clicked = results?.[0]?.result ?? 0;
        _log(`✅ pause-all-racks — clicked ${clicked} rack pause buttons`);
        setTimeout(syncRackPauseState, 800);
        sendResponse({ ok: true, clicked });
      } catch (err) {
        console.error("❌ pause-all-racks error:", err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "pause-rack") {
    const { column } = msg; // 1-based column number matching dashboard column headers
    (async () => {
      const tabs = await chrome.tabs.query({});
      const hmiTab = tabs.find((t) => t.url?.includes("/internal/hmi/"));
      if (!hmiTab) {
        console.warn("❌ pause-rack — HMI tab not found");
        sendResponse({ ok: false, error: "HMI tab not found" });
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: hmiTab.id },
          world: "MAIN",
          func: async (col, dialogSel) => {
            // 1. Click the rack footer toggle (pause ↔ reset)
            const groups = Array.from(
              document.querySelectorAll(
                "#vessels_hall_view .hmi_vessels_view__content__rack_groups > div",
              ),
            );
            const group = groups[col - 1];
            if (!group)
              return {
                ok: false,
                error: `No rack group at index ${col - 1} (column ${col})`,
              };
            const btn = group.querySelector(
              ".hmi_vessels_view__content__rack_groups__group__footer div > a",
            );
            if (!btn)
              return {
                ok: false,
                error: `No pause button found in column ${col} rack group`,
              };
            btn.click();

            // 2. Poll up to 3 s for the HMI confirmation dialog to appear
            let dialogBtn = null;
            for (let i = 0; i < 30; i++) {
              await new Promise((r) => setTimeout(r, 100));
              dialogBtn = document.querySelector(dialogSel);
              if (dialogBtn) break;
            }
            if (!dialogBtn) return { ok: true, dialogClicked: false };

            // 3. Click the dialog action button
            dialogBtn.click();

            // 4. Wait up to 20 s for the dialog to close (automation complete)
            for (let i = 0; i < 200; i++) {
              await new Promise((r) => setTimeout(r, 100));
              if (!document.querySelector(dialogSel)) break;
            }

            return { ok: true, dialogClicked: true };
          },
          args: [
            column,
            "body > div:nth-child(13) > div > div > div.modalContent > div > button",
          ],
        });
        const result = results?.[0]?.result ?? {
          ok: false,
          error: "No script result",
        };
        if (result.ok) {
          _log(
            `✅ pause-rack — column ${column} toggled${result.dialogClicked ? " (dialog confirmed)" : ""}`,
          );
          setTimeout(syncRackPauseState, 800);
          sendResponse({ ok: true, dialogClicked: !!result.dialogClicked });
        } else {
          console.warn(`❌ pause-rack — ${result.error}`);
          sendResponse({ ok: false, error: result.error });
        }
      } catch (err) {
        console.error("❌ pause-rack error:", err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "reset-slot-card") {
    const { slotName } = msg;
    (async () => {
      const vessel = dashboardState[slotName];
      if (!vessel) {
        sendResponse({ ok: false, error: `No vessel at slot ${slotName}` });
        return;
      }
      const tabs = await chrome.tabs.query({});
      const hmiTab = tabs.find((t) => t.url?.includes("/internal/hmi/"));
      if (!hmiTab) {
        sendResponse({ ok: false, error: "HMI tab not found" });
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: hmiTab.id },
          world: "MAIN",
          func: (vesselName) => {
            const containers = Array.from(
              document.querySelectorAll(".vessel-details__container"),
            );
            for (const container of containers) {
              const nameEl =
                container.querySelector(
                  ".vessel-details__header__info__case_name",
                ) ||
                container.querySelector(
                  ".vessel-details__header__info__name_location",
                );
              if (
                !nameEl ||
                nameEl.textContent.trim().toLowerCase() !==
                  vesselName.toLowerCase()
              )
                continue;
              const btn = container.querySelector(
                ".vessel-details__content > div:nth-child(1) > div:nth-child(6) > div:nth-child(3) > div > button",
              );
              if (!btn)
                return { ok: false, error: "Reset button not found in card" };
              btn.click();
              return { ok: true };
            }
            return {
              ok: false,
              error: `Card not found for vessel: ${vesselName}`,
            };
          },
          args: [vessel.vesselName || ""],
        });
        const result = results?.[0]?.result ?? {
          ok: false,
          error: "No script result",
        };
        if (result.ok) {
          _log(`✅ reset-slot-card — ${slotName}`);
          sendResponse({ ok: true });
        } else {
          console.warn(`❌ reset-slot-card — ${result.error}`);
          sendResponse({ ok: false, error: result.error });
        }
      } catch (err) {
        console.error("❌ reset-slot-card error:", err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "reset-motor-card") {
    const { slotName } = msg;
    // Serialize via queue — HMI shows only one vessel card at a time.
    _motorCardResetQueue = _motorCardResetQueue.then(async () => {
      const col = parseInt(slotName.slice(0, 3), 10);
      const rowIndex = slotName.charCodeAt(3) - 65; // A=0, B=1, C=2

      if (isNaN(col) || rowIndex < 0 || rowIndex > 10) {
        console.warn(`❌ reset-motor-card — cannot parse slot: ${slotName}`);
        sendResponse({ ok: false, error: `Cannot parse slot: ${slotName}` });
        return;
      }

      const tabs = await chrome.tabs.query({});
      const hmiTab = tabs.find((t) => t.url?.includes("/internal/hmi/"));
      if (!hmiTab) {
        sendResponse({ ok: false, error: "HMI tab not found" });
        return;
      }

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: hmiTab.id },
          world: "MAIN",
          func: async (col, rowIndex) => {
            // Navigate to the vessel by position in the hall view rack grid.
            const groups = Array.from(
              document.querySelectorAll(
                "#vessels_hall_view .hmi_vessels_view__content__rack_groups > div",
              ),
            );
            const group = groups[col - 1];
            if (!group)
              return { ok: false, error: `No rack group at column ${col}` };

            // Vessel cells are direct children that are not the rack footer.
            const vesselCells = Array.from(group.children).filter(
              (el) =>
                !el.classList.contains(
                  "hmi_vessels_view__content__rack_groups__group__footer",
                ),
            );
            const vesselEl = vesselCells[rowIndex];
            if (!vesselEl)
              return {
                ok: false,
                error: `No vessel cell at col:${col} row:${rowIndex}`,
              };

            // Click the vessel to open its detail card.
            vesselEl.click();

            // Wait up to 1.5 s for the card panel to appear.
            let card = null;
            for (let i = 0; i < 15; i++) {
              await new Promise((r) => setTimeout(r, 100));
              const c = document.querySelector(".vessel-details__container");
              if (c && c.offsetHeight > 0) {
                card = c;
                break;
              }
            }
            if (!card)
              return {
                ok: false,
                error: `Card did not open for col:${col} row:${rowIndex}`,
              };

            // Find the motor section button.
            const btn = card.querySelector(
              "div.vessel-details__content > div:nth-child(3) > div:nth-child(10) > div:nth-child(3) > div > button",
            );
            if (!btn)
              return {
                ok: false,
                error: "Motor reset button not found in card",
              };

            // Safety check: only click when the button indicates a fault/reset
            // state. If it reads "Park stop" the motor is running normally and
            // clicking would pause the entire rack — abort instead.
            const btnLabel = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
            if (btnLabel.toLowerCase().includes("park")) {
              return {
                ok: false,
                error: `Aborted — button is in park-stop state ("${btnLabel}"), not reset state`,
              };
            }

            btn.click();

            // Click every "Send command" dialog that appears — there may be
            // multiple stacked. Keep looping until none remain.
            function findModalBtn() {
              return document.querySelector("div.modalContent button");
            }

            let dialogClicked = false;
            // Wait up to 5 s for the first dialog.
            for (let i = 0; i < 50; i++) {
              await new Promise((r) => setTimeout(r, 100));
              if (findModalBtn()) break;
            }
            // Dismiss every stacked dialog.
            let b = findModalBtn();
            while (b) {
              b.click();
              dialogClicked = true;
              // Wait 500 ms for the close animation before looking for the next.
              await new Promise((r) => setTimeout(r, 500));
              b = findModalBtn();
            }

            // Return to the hall view so the next card opens cleanly.
            window.history.back();
            await new Promise((r) => setTimeout(r, 300));

            return { ok: dialogClicked };
          },
          args: [col, rowIndex],
        });

        const result = results?.[0]?.result ?? {
          ok: false,
          error: "No script result",
        };
        if (result.ok) {
          _log(`✅ reset-motor-card — ${slotName}`);
          sendResponse({ ok: true });
        } else {
          console.warn(`❌ reset-motor-card — ${result.error}`);
          sendResponse({ ok: false, error: result.error });
        }
      } catch (err) {
        console.error("❌ reset-motor-card error:", err.message);
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }

  if (msg.type === "force-refresh") {
    chrome.tabs.query({}, (tabs) => {
      const hmiTab = tabs.find(
        (t) => t.url && t.url.includes("/internal/hmi/"),
      );
      if (hmiTab) {
        injectedTabs.delete(hmiTab.id);
        injectWSHook(hmiTab.id);
      }
    });
    return; // fire-and-forget — no response expected
  }

  /* --------------------------------------------------------
     HMI VESSEL MAP — content.js requests vessel→slot mapping
     so it can tag scraped items with the exact slotName,
     eliminating all fuzzy name/location matching.
  -------------------------------------------------------- */
  if (msg.type === "hmi:get-vessel-map") {
    const map = {};
    for (const [slotName, v] of Object.entries(dashboardState)) {
      // Name-based key (works when API human_name matches HMI case name)
      if (v.vesselName) {
        map[v.vesselName.trim().toLowerCase()] = slotName;
      }
      // ID-based key (used when URL contains numeric vessel ID)
      if (v.vesselId != null) {
        map["id:" + v.vesselId] = slotName;
      }
    }
    sendResponse({ vesselNameToSlot: map });
    return true;
  }

  /* --------------------------------------------------------
     HMI SCRAPE — temp control switch state + last temp set
     content.js sends { type:"hmi:scrape", items:[...] }
     Each item carries a slotName resolved by content.js
     using the vessel map from hmi:get-vessel-map.
  -------------------------------------------------------- */
  if (msg.type === "hmi:scrape") {
    const updates = [];

    for (const item of msg.items || []) {
      // Direct lookup by slotName (resolved in content.js via vessel map)
      const slot = item.slotName ? dashboardState[item.slotName] : null;

      if (!slot) {
        console.warn(
          `[hmi:scrape] ⚠️ No slot for slotName="${item.slotName}" vesselName="${item.vesselName}"`,
        );
        continue;
      }

      if (typeof item.tempControlOn === "boolean") {
        if (slot.tempControlOn !== item.tempControlOn) {
          slot.tempControlOn = item.tempControlOn;

          updates.push({
            slotName: slot.slotName,
            tempControlOn: slot.tempControlOn,
            lastTempSet: slot.lastTempSet,
          });
        }
      }

      // Blower setpoint scraped directly from the HMI input field — overrides
      // the API command history value so the watchdog acts on the live field state.
      if (typeof item.blowerSetpointFieldValue === "number") {
        if (!slot.setpoints) slot.setpoints = {};
        if (slot.setpoints.airflowSp !== item.blowerSetpointFieldValue) {
          _log(`💨 [hmi:scrape] ${slot.slotName} blower SP field: ${slot.setpoints.airflowSp} → ${item.blowerSetpointFieldValue} l/min`);
          slot.setpoints.airflowSp = item.blowerSetpointFieldValue;
          updates.push({
            slotName: slot.slotName,
            tempControlOn: slot.tempControlOn,
            lastTempSet: slot.lastTempSet,
          });
        }
      }
    }

    if (updates.length > 0) {
      safeSend({ type: "hmi:data", updates });
    }
    return;
  }

  /* --------------------------------------------------------
     HALL VIEW CASE NAMES — content.js scrapes all slot case
     names from the hall view DOM and reports them here.
     A name change on a vessel that was previously tracked
     signals a new case; uptime resets for that vessel.
  -------------------------------------------------------- */
  if (msg.type === "hmi:case-names") {
    // Only the kiosk/owner machine tracks case changes and writes uptime data
    if (_isWatchdogOwner()) {
      for (const [slotName, caseName] of Object.entries(msg.slots)) {
        _hallViewCaseNames[slotName] = caseName;
        const v = dashboardState[slotName];
        if (!v || v.vesselId == null) continue;
        const vId = v.vesselId;
        const ud  = _uptimeData[vId];
        if (!ud) {
          _uptimeData[vId] = _uptimeRecord(caseName, _caseStartTs(slotName));
          _saveUptimeData();
        } else if (ud.caseName && ud.caseName !== caseName) {
          _log(`[uptime] 🔄 Case change on ${slotName}: "${ud.caseName}" → "${caseName}"`);
          _uptimeData[vId] = _uptimeRecord(caseName, _caseStartTs(slotName));
          _saveUptimeData();
        } else if (!ud.caseName) {
          ud.caseName = caseName;
          _saveUptimeData();
        }
      }
    }
    return;
  }

  /* --------------------------------------------------------
     MACHINE IP — dashboard detects local IP via WebRTC and
     reports it here so the service worker knows which host it is.
  -------------------------------------------------------- */
  /* --------------------------------------------------------
     UPTIME DEBUG — trigger poll + return state snapshot
     Usage from dashboard console:
       chrome.runtime.sendMessage({type:"uptime:debug"}, console.log)
  -------------------------------------------------------- */
  if (msg.type === "uptime:debug") {
    _pollGrafanaUptime().then(() => {
      sendResponse({
        machineIp: _machineIp,
        isOwner:   _isWatchdogOwner(),
        uptimeData: Object.fromEntries(
          Object.entries(_uptimeData).slice(0, 5) // first 5 slots
        )
      });
    });
    return true; // async response
  }

  if (msg.type === "machine:ip") {
    _machineIp = msg.ip ?? null;
    chrome.storage.local.set({ machine_ip: _machineIp });
    _log(`🖥️ Machine IP set: ${_machineIp}`);
    return;
  }

  /* --------------------------------------------------------
     WATCHDOG TOGGLE — any dashboard tab can enable/disable;
     background persists state and starts/stops the interval.
  -------------------------------------------------------- */
  if (msg.type === "watchdog:toggle") {
    (async () => {
      try {
        const { enabled, sessionName } = msg;
        const time = new Date().toLocaleTimeString("en-US", { hour12: false });
        const newState = {
          enabled: !!enabled,
          changedBy: sessionName,
          ownedBy: enabled ? WATCHDOG_HOST_IP : null,
          time,
          changedAt: Date.now(),
        };
        const { watchdog_log = [] } = await chrome.storage.local.get(["watchdog_log"]);
        const entry = {
          time,
          type: "toggle",
          action: enabled ? "Enabled" : "Disabled",
          by: sessionName,
          ts: Date.now(),
        };
        const log = [entry, ...watchdog_log].slice(0, 100);
        await chrome.storage.local.set({ watchdog_state: newState, watchdog_log: log });
        sendResponse({ ok: true });
        _driveLastKnownAt = newState.changedAt;
        writeDriveState(newState).catch(e => _log("⚠️ [DRIVE SYNC] Write failed:", e.message));
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

// OPEN DASHBOARD
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create(
    { url: chrome.runtime.getURL("dashboard.html"), active: true },
    (tab) => {
      chrome.tabs.update(tab.id, { active: true });
    },
  );
});

// INITIAL BASE STATE
(async () => {
  const [rackGroupsRaw, vesselsRaw] = await Promise.all([
    fetch("https://atlas.earthfuneral.com/api/rack-groups/?facility=2&page_size=1000", {
      credentials: "include",
    }).then((r) => r.json()),
    fetch("https://atlas.earthfuneral.com/api/vessels/?facility=2&page_size=1000", {
      credentials: "include",
    }).then((r) => r.json()),
  ]);

  // API may return a paginated envelope ({ results: [...] }) or a plain array.
  const rackGroups = Array.isArray(rackGroupsRaw)
    ? rackGroupsRaw
    : (rackGroupsRaw?.results ?? []);
  const vessels = Array.isArray(vesselsRaw)
    ? vesselsRaw
    : (vesselsRaw?.results ?? []);

  const vesselsById = new Map(vessels.map((v) => [v.id, v]));
  const state = {};

  for (const group of rackGroups) {
    for (const rack of group.racks) {
      const slot = rack.name;
      const vessel = rack.vessel ? vesselsById.get(rack.vessel) : null;
      if (rack.vessel != null && vessel === undefined) {
        console.warn(`⚠️ init: skipping slot "${rack.name}" — vessel ${rack.vessel} not found in API`);
        continue;
      }

      state[slot] = {
        slotName: slot,
        row: rack.row,
        column: rack.column,
        rackGroupId: group.id,
        doorOpen: !!group.door_open,
        noPower: !!group.no_power,
        mechanicalStatus: rack.mechanical_status,
        tempModuleStatus: rack.temp_module_status,
        mixerModuleStatus: rack.mixer_module_status,
        valveModuleStatus: rack.valve_module_status,
        vesselPresent: vessel !== null,
        vesselId: vessel?.id ?? null,
        vesselName: vessel?.human_name ?? vessel?.name ?? null,
        status: vessel?.status ?? null,
        statusDisplay: vessel?.status_display ?? null,
        version: vessel?.version ?? null,
        versionDisplay: vessel?.version_display ?? null,
        lastUsed: vessel?.last_used ?? null,
        lastMaintained: vessel?.last_maintained ?? null,
        telemetry: {},
        tempControlOn: null,
      };
    }
  }

  dashboardState = state;

  // Build reverse map: numeric vessel_id → slot name.
  // WS telemetry messages carry a numeric vessel_id, not a slot name.
  vesselIdToSlot = {};
  for (const [slot, v] of Object.entries(state)) {
    if (v.vesselId != null) vesselIdToSlot[v.vesselId] = slot;
  }

  // Compute vessels not assigned to any rack slot.
  const rackedIds = new Set(
    rackGroups.flatMap((g) => g.racks.map((r) => r.vessel)).filter(Boolean),
  );
  unrackedVessels = vessels
    .filter((v) => !rackedIds.has(v.id))
    .map((v) => ({ id: v.id, name: v.human_name ?? v.name }))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  _log(
    "✅ dashboardState initialized",
    Object.keys(dashboardState).length,
    "| vesselIdToSlot entries:",
    Object.keys(vesselIdToSlot).length,
    "| unracked:",
    unrackedVessels.length,
  );


  // Re-inject WS hook into any HMI tabs that were already open when the
  // service worker restarted. Without this, the hook is only installed
  // on tab navigation events — existing loaded tabs would have no hook
  // until the 30-second auto-recovery fires (~45 s later).
  const existingHmiTabs = await chrome.tabs.query({
    url: "https://atlas.earthfuneral.com/internal/hmi/*",
  });
  for (const tab of existingHmiTabs) {
    injectedTabs.delete(tab.id);
    injectWSHook(tab.id);
  }
  if (existingHmiTabs.length) {
    _log(
      `🔌 WS hook re-injected into ${existingHmiTabs.length} existing HMI tab(s) on startup`,
    );
  }

  // Kick off initial setpoint collection shortly after startup,
  // then refresh every 120 s to stay current without any DOM scraping.
  setTimeout(collectAllSetpoints, 5000);
  setInterval(collectAllSetpoints, 120000);

  // Poll the live blower setpoint input field from each vessel's HMI v2 page.
  // Offset by 60 s so it doesn't overlap with collectAllSetpoints.
  // Runs sequentially (one popup per vessel) — ~3-5 s per vessel at most.
  setTimeout(() => {
    collectBlowerSetpointsFromHmi();
    setInterval(collectBlowerSetpointsFromHmi, 120000);
  }, 65000);

  // Sync pause state after HMI has had time to fully render, then notify dashboards.
  setTimeout(async () => {
    try {
      await syncRackPauseState();
    } catch (e) {
      _log("⚠️ startup syncRackPauseState error:", e);
    }
    _initialSyncDone = true;
    try {
      const dashTabs = await chrome.tabs.query({
        url: chrome.runtime.getURL("dashboard.html"),
      });
      for (const tab of dashTabs) {
        chrome.tabs
          .sendMessage(tab.id, { type: "hmi:sync-complete" })
          .catch(() => {});
      }
    } catch (e) {}
  }, 8000);

  const hmiTabsForState = await chrome.tabs.query({
    url: "https://atlas.earthfuneral.com/internal/hmi/*",
  });
  if (hmiTabsForState.length) {
    const tabId = hmiTabsForState[0].id;
    chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        chrome.tabs.sendMessage(tabId, { type: "DASHBOARD_STATE", state });
      }
    });
  }

  const dashboardTabs = await chrome.tabs.query({
    url: chrome.runtime.getURL("dashboard.html"),
  });
  for (const tab of dashboardTabs) {
    chrome.tabs.sendMessage(tab.id, { type: "DASHBOARD_STATE", state });
  }
  // Periodically re-check vessel presence so removals are reflected without
  // requiring the service worker to restart.
  setInterval(refreshRackState, 30000);
})().catch((e) => _log("⚠️ startup init error:", e));

/************************************************************
 * RACK STATE REFRESH  (vessel presence — runs every 2 min)
 *
 * Re-fetches rack-groups + vessels from the API and updates
 * vesselPresent (plus related fields) for every slot.
 * When a vessel is removed the slot's stale telemetry and
 * setpoints are cleared and a dashboard:update is broadcast.
 ************************************************************/
async function refreshRackState() {
  try {
    const [rackGroupsResult, vesselsResult] = await Promise.allSettled([
      fetch("https://atlas.earthfuneral.com/api/rack-groups/?facility=2&page_size=1000", {
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`rack-groups fetch failed: ${r.status}`);
        return r.json();
      }),
      fetch("https://atlas.earthfuneral.com/api/vessels/?facility=2&page_size=1000", {
        credentials: "include",
      }).then((r) => {
        if (!r.ok) throw new Error(`vessels fetch failed: ${r.status}`);
        return r.json();
      }),
    ]);

    if (rackGroupsResult.status === "rejected") {
      console.error("❌ refreshRackState:", rackGroupsResult.reason);
      return;
    }

    const rackGroupsRaw = rackGroupsResult.value;
    const rackGroups = Array.isArray(rackGroupsRaw)
      ? rackGroupsRaw
      : (rackGroupsRaw?.results ?? []);

    if (!rackGroups.length) {
      console.warn(
        "⚠️ refreshRackState: API returned no rack groups (session expired?)",
        { rackGroupsRaw },
      );
      return;
    }

    // vessels fetch is optional — when it fails we still update rack infrastructure
    // and derive presence from rack.vessel, but skip vessel identity fields.
    const vesselsFailed = vesselsResult.status === "rejected";
    if (vesselsFailed) {
      console.error("❌ refreshRackState:", vesselsResult.reason);
    }
    const vesselsRaw = vesselsFailed ? [] : vesselsResult.value;
    const vessels = Array.isArray(vesselsRaw) ? vesselsRaw : (vesselsRaw?.results ?? []);
    const vesselsById = new Map(vessels.map((v) => [v.id, v]));

    for (const group of rackGroups) {
      for (const rack of group.racks) {
        const slot = rack.name;
        if (!dashboardState[slot]) continue;

        const vessel = rack.vessel ? vesselsById.get(rack.vessel) : null;
        // When vessels fetch succeeded: skip slots whose vessel ID isn't in the map
        // (stale rack-groups data referencing a vessel we don't have details for).
        // When vessels fetch failed: rack.vessel non-null is enough to mark presence.
        if (!vesselsFailed && rack.vessel != null && vessel === undefined) continue;

        const wasPresent = dashboardState[slot].vesselPresent;
        const isPresent = vesselsFailed ? rack.vessel != null : vessel !== null;
        const prevMechStatus = dashboardState[slot].mechanicalStatus;
        const prevValveStatus = dashboardState[slot].valveModuleStatus;

        // Only update vessel-identity and rack-infrastructure fields.
        // mixerModuleStatus is intentionally excluded — WS telemetry provides
        // it live and the API lags, so overwriting would cause M-bubble flicker.
        // mechanicalStatus, tempModuleStatus, and valveModuleStatus have NO WS
        // source, so the API is the only truth and must be refreshed here.
        dashboardState[slot].doorOpen = !!group.door_open;
        dashboardState[slot].noPower = !!group.no_power;
        dashboardState[slot].mechanicalStatus = rack.mechanical_status;
        dashboardState[slot].tempModuleStatus = rack.temp_module_status;
        dashboardState[slot].valveModuleStatus = rack.valve_module_status;
        dashboardState[slot].vesselPresent = isPresent;

        // Vessel identity fields only updated when vessels fetch succeeded.
        if (!vesselsFailed) {
          dashboardState[slot].vesselId = vessel?.id ?? null;
          dashboardState[slot].vesselName =
            vessel?.human_name ?? vessel?.name ?? null;
          dashboardState[slot].status = vessel?.status ?? null;
          dashboardState[slot].statusDisplay = vessel?.status_display ?? null;
        }

        // Vessel removed → wipe stale telemetry and setpoints
        if (wasPresent && !isPresent) {
          dashboardState[slot].telemetry = {};
          dashboardState[slot].setpoints = {};
          dashboardState[slot].lastTempSet = null;
          dashboardState[slot].tempControlOn = null;
          _log(
            `🗑️ refreshRackState: vessel removed from ${slot} — telemetry cleared`,
          );
        }

        // Broadcast on vessel-presence change OR mechanicalStatus change
        // (pause/unpause from HMI must propagate immediately).
        // Always broadcast for empty slots so the dashboard recovers if it
        // missed a previous push (e.g. service worker restart, popup blocked render).
        const mechChanged = rack.mechanical_status !== prevMechStatus;
        const valveChanged = rack.valve_module_status !== prevValveStatus;
        if (!isPresent || wasPresent !== isPresent || mechChanged || valveChanged) {
          safeSend({
            type: "dashboard:update",
            slotName: slot,
            vessel: dashboardState[slot],
          });
        }
      }
    }

    // Rebuild the numeric vesselId → slotName reverse map
    vesselIdToSlot = {};
    for (const [slot, v] of Object.entries(dashboardState)) {
      if (v.vesselId != null) vesselIdToSlot[v.vesselId] = slot;
    }

    // Recompute unracked vessels only when vessels fetch succeeded.
    if (!vesselsFailed) {
      const rackedIdsRefresh = new Set(
        rackGroups.flatMap((g) => g.racks.map((r) => r.vessel)).filter(Boolean),
      );
      const freshUnracked = vessels
        .filter((v) => !rackedIdsRefresh.has(v.id))
        .map((v) => ({ id: v.id, name: v.human_name ?? v.name }))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      const prevIds = unrackedVessels.map((v) => v.id).join(",");
      const freshIds = freshUnracked.map((v) => v.id).join(",");
      if (prevIds !== freshIds) {
        unrackedVessels = freshUnracked;
        const dashTabs = await chrome.tabs.query({
          url: chrome.runtime.getURL("dashboard.html"),
        });
        for (const tab of dashTabs) {
          chrome.tabs
            .sendMessage(tab.id, {
              type: "dashboard:unracked-update",
              unrackedVessels,
            })
            .catch(() => {});
        }
      }
    }

    _log(`🔄 refreshRackState complete${vesselsFailed ? " (vessels unavailable — identity fields unchanged)" : ""}`);
    syncRackPauseState();
  } catch (err) {
    console.error("❌ refreshRackState error:", err);
  }
}

// RACK PAUSE STATE SYNC  (reads HMI DOM — API has no pause field)
// The HMI footer button reads "pause rack" when running and "reset rack" when
// paused.  We scrape that text to get ground-truth pause state per column and
// store it as rackGroupPaused on every slot in that column.
async function syncRackPauseState(force = false) {
  const tabs = await chrome.tabs.query({});
  const hmiTab = tabs.find((t) => t.url?.includes("/internal/hmi/"));
  if (!hmiTab) return;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: hmiTab.id },
      world: "MAIN",
      func: () => {
        const groups = Array.from(
          document.querySelectorAll(
            "#vessels_hall_view .hmi_vessels_view__content__rack_groups > div",
          ),
        );
        return groups.map((group, i) => {
          const btn = group.querySelector(
            ".hmi_vessels_view__content__rack_groups__group__footer div > a",
          );
          const text = (btn?.textContent ?? "").trim().toLowerCase();
          return { col: i + 1, paused: text.includes("reset") };
        });
      },
    });

    const groupStates = results?.[0]?.result;
    if (!Array.isArray(groupStates)) return;

    for (const { col, paused } of groupStates) {
      for (const slot of Object.values(dashboardState)) {
        if (slot.column !== col) continue;
        if (!force && slot.rackGroupPaused === paused) continue;
        slot.rackGroupPaused = paused;
        safeSend({
          type: "dashboard:update",
          slotName: slot.slotName,
          vessel: slot,
        });
      }
    }
  } catch {
    // HMI may not be showing the main rack view — skip silently
  }
}

// Re-sync pause state every 300 s as a background fallback.
// The watchdog also calls syncRackPauseState() at the top of every tick so pause
// state is always current before any restart decision is made.
setInterval(syncRackPauseState, 300000);

// SETPOINT COLLECTION  (pure REST API — no card opening)
// Temperature command metadata (setpoint + last-set info + ctrl state)
async function fetchTempCommandMeta(vesselId) {
  try {
    const url =
      `https://atlas.earthfuneral.com/api/vessel-commands/` +
      `?type=temperature&ordering=-created&vessel=${vesselId}&limit=50`;
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return {};
    const data = await r.json();

    //contains nothing useful to extract but leaving here for debugging and future reference if needed
    /*
    _log("🔍 RAW SETPOINT RESPONSE for", vesselId, data);
    _log(
      "🔍 FULL RAW JSON for",
      vesselId,
      JSON.stringify(data, null, 2),
    );
    */
    const results = data?.results || [];

    // Most recent command that carries a set_temp value
    const tempCmd = results.find(
      (item) => typeof item?.command_values?.set_temp === "number",
    );

    // dumps the last temp set data
    /*
    _log(
      "🔎 FULL tempCmd SOURCE OBJECT:",
      JSON.stringify(tempCmd, null, 2),
    );
    */

    // Most recent command that carries a temp-control toggle
    const ctrlCmd = results
      .filter(
        (item) =>
          typeof item?.command_values?.compost_temp_ctrl_active_req !==
          "undefined",
      )
      .sort((a, b) => new Date(b.created) - new Date(a.created))[0];

    let tempSpF = null;
    let lastTempSet = null;
    let tempControlOn = null;

    if (tempCmd) {
      tempSpF =
        Math.round(((tempCmd.command_values.set_temp * 9) / 5 + 32) * 10) / 10;

      const userStr = tempCmd.responsible_name || "";
      const d = tempCmd.created ? new Date(tempCmd.created) : null;
      const dateStr = d ? `${d.getMonth() + 1}/${d.getDate()}` : "";

      const parts = [dateStr, userStr ? "by " + userStr : null].filter(Boolean);

      lastTempSet = {
        value: `Last set: ${tempSpF}°F`,
        secondary: parts.length ? ` ${parts.join(" ")}` : "",
      };
    }

    if (ctrlCmd) {
      const req = ctrlCmd.command_values.compost_temp_ctrl_active_req;
      tempControlOn = req !== 0 && req !== false && req !== null;
    }

    return { tempSpF, lastTempSet, tempControlOn };
  } catch {
    return {};
  }
}

// setpoint fetch
async function fetchSetpoint(vesselId, type, valueField) {
  try {
    // Fetch up to 10 most recent commands — multiple subtypes share the same
    // "type" string (e.g. both "set_temp" and "compost_temp_ctrl_active_req"
    // are type=temperature). We find the first result that actually contains
    // the specific field we need.
    const url =
      `https://atlas.earthfuneral.com/api/vessel-commands/` +
      `?type=${type}&ordering=-created&vessel=${vesselId}&limit=10`;
    const r = await fetch(url, {
      credentials: "include",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      console.warn(
        `⚠️ fetchSetpoint(${vesselId}, ${type}, ${valueField}): HTTP ${r.status}`,
      );
      return null;
    }
    const data = await r.json();
    const result = data?.results?.find(
      (item) => typeof item?.command_values?.[valueField] === "number",
    );
    if (!result) {
      // Log the first result's command_values so we can see the actual field names
      const first = data?.results?.[0];
      console.warn(
        `⚠️ fetchSetpoint(${type}, ${valueField}): field not found.` +
          ` First result command_values:`,
        first ? JSON.stringify(first.command_values) : "no results",
      );
    }
    return result ? result.command_values[valueField] : null;
  } catch (err) {
    console.warn(
      `⚠️ fetchSetpoint(${type}, ${valueField}) error:`,
      err.message,
    );
    return null;
  }
}

// Main setpoint collection pass
let setpointCollectionRunning = false;

async function collectAllSetpoints() {
  if (setpointCollectionRunning) return;
  setpointCollectionRunning = true;

  try {
    const slots = Object.values(dashboardState).filter((v) => v.vesselId);
    _log(`🎯 Fetching setpoints for ${slots.length} vessels via API…`);

    await Promise.all(
      slots.map(async (v) => {
        //this is the telemetry - already captured so no need to log
        /*
        _log(
          "🧩 FULL VESSEL OBJECT BEFORE EXTRACTION:",
          JSON.stringify(v, null, 2),
        );
        */

        const [motorSp, airflowSp, tempMeta] = await Promise.all([
          fetchSetpoint(v.vesselId, "motor", "set_rotations_hr"),
          fetchSetpoint(v.vesselId, "air", "set_air"),
          fetchTempCommandMeta(v.vesselId),
        ]);

        //too much data to log, leaving this here for future debugging if needed
        /*
        _log(
          `📊 Setpoints API [${v.slotName}]` +
            ` | motorSp:${motorSp}` +
            ` | airflowSp:${airflowSp}` +
            ` | tempSp:${tempMeta.tempSpF}` +
            ` | tempCtrlOn:${tempMeta.tempControlOn}`,
        );
        */

        if (!dashboardState[v.slotName]) return;
        if (!dashboardState[v.slotName].setpoints)
          dashboardState[v.slotName].setpoints = {};

        dashboardState[v.slotName].setpoints.tempSp = tempMeta.tempSpF ?? null;
        dashboardState[v.slotName].setpoints.motorSp = motorSp;
        dashboardState[v.slotName].setpoints.airflowSp = airflowSp;

        if (tempMeta.lastTempSet) {
          dashboardState[v.slotName].lastTempSet = tempMeta.lastTempSet;
        }
        // tempControlOn is NOT set from command history — history only ever
        // contains ON commands and cannot reflect the current hardware state.
        // Source of truth is heater_control_active in WS telemetry frames.

        safeSend({
          type: "dashboard:update",
          slotName: v.slotName,
          vessel: dashboardState[v.slotName],
        });
      }),
    );

    _log("✅ Setpoints collected and updated");
  } catch (err) {
    console.error("❌ collectAllSetpoints error:", err);
  } finally {
    setpointCollectionRunning = false;
  }
}

// Scrapes the live blower setpoint input field from each vessel's HMI v2 detail
// page by opening a hidden popup window, waiting for React to render, reading the
// field value, then closing the window. Runs sequentially to avoid flooding the
// browser with tabs. Overrides the API command-history value so the watchdog acts
// on the actual HMI field state rather than a potentially stale last-sent value.
let _blowerSpScrapeRunning = false;

async function collectBlowerSetpointsFromHmi() {
  if (!_isWatchdogOwner()) return;
  if (_blowerSpScrapeRunning) return;
  _blowerSpScrapeRunning = true;

  const BLOWER_SP_SELECTOR =
    "body > div.hmi_container > div:nth-child(3) > div.vessel-details__container > " +
    "div.vessel-details__content > div:nth-child(5) > div:nth-child(10) > " +
    "div:nth-child(3) > div > div > input";

  const slots = Object.values(dashboardState).filter((v) => v.vesselId);
  _log(`💨 [blowerSpScrape] Polling HMI blower SP fields for ${slots.length} vessels…`);

  for (const v of slots) {
    const vesselUrl = `https://atlas.earthfuneral.com/internal/hmi/v2/vessels/${v.vesselId}/details`;
    let bgTab = null;
    try {
      bgTab = await chrome.tabs.create({ url: vesselUrl, active: false });
      const tabId = bgTab.id;
      if (!tabId) throw new Error("No tab ID from background tab");

      let spValue = null;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const val = parseFloat(el.value);
            return isNaN(val) ? null : val;
          },
          args: [BLOWER_SP_SELECTOR],
        });
        const val = results?.[0]?.result;
        if (val !== null && val !== undefined) {
          spValue = val;
          break;
        }
      }

      if (!dashboardState[v.slotName]) continue;
      if (!dashboardState[v.slotName].setpoints) dashboardState[v.slotName].setpoints = {};

      if (spValue !== null) {
        if (dashboardState[v.slotName].setpoints.airflowSp !== spValue) {
          _log(`💨 [blowerSpScrape] ${v.slotName} SP: ${dashboardState[v.slotName].setpoints.airflowSp ?? "null"} → ${spValue} l/min`);
          dashboardState[v.slotName].setpoints.airflowSp = spValue;
          safeSend({ type: "dashboard:update", slotName: v.slotName, vessel: dashboardState[v.slotName] });
        } else {
          _log(`💨 [blowerSpScrape] ${v.slotName} SP unchanged: ${spValue} l/min`);
        }
      } else {
        _log(`⚠️ [blowerSpScrape] ${v.slotName} blower SP field not found — selector may need updating`);
      }
    } catch (err) {
      _log(`❌ [blowerSpScrape] ${v.slotName}: ${err.message}`);
    } finally {
      if (bgTab?.id) {
        try { await chrome.tabs.remove(bgTab.id); } catch (_) {}
      }
    }
  }

  _log("✅ [blowerSpScrape] Complete");
  _blowerSpScrapeRunning = false;
}

/************************************************************
 * SILENT SETPOINT WRITE  (via stored WS socket reference)
 *
 * Injects a tiny script into the HMI tab's MAIN world that
 * calls window.__WS_SOCKET__.send() with the command JSON.
 * No tab focus switch, no card opening — completely invisible.
 *
 * Command formats (confirmed from WS tap):
 *   temp   → { type:"temperature", value:{ set_temp:<°C> },   id:<uuid>, vessel_id:<n> }
 *   motor  → { type:"motor",       value:{ set_rotations_hr:<n> }, id:<uuid>, vessel_id:<n> }
 *   blower → { type:"air",         value:{ set_air:<n> },     id:<uuid>, vessel_id:<n> }
 ************************************************************/
async function sendWsSetpoint(hmiTabId, vesselId, spType, value) {
  let command;

  if (spType === "temp") {
    const tempC = Math.round((((value - 32) * 5) / 9) * 100) / 100;

    // 1) Turn temp control ON — MUST be awaited and MUST be sent first
    await chrome.scripting.executeScript({
      target: { tabId: hmiTabId },
      world: "MAIN",
      func: (vesselId, hmiHost) => {
        const sockets = window.__WS_SOCKETS__;
        let ws = null;

        console.log("📡 TEMP CTRL ON (pre-step)", vesselId);

        if (sockets) {
          for (const [url, s] of sockets) {
            if (url.includes(hmiHost) && s.readyState === WebSocket.OPEN) {
              ws = s;
              break;
            }
          }
        }

        if (!ws) throw new Error("No open HMI WebSocket");

        const preCmd = {
          type: "temperature",
          value: { compost_temp_ctrl_active_req: 1 },
          id: crypto.randomUUID(),
          vessel_id: vesselId,
        };
        console.log("📤 WS SEND (temp-ctrl pre-step):", JSON.stringify(preCmd));
        ws.send(JSON.stringify(preCmd));
      },
      args: [vesselId, "atlas.earthfuneral.com"],
    });

    // 2) Delay to allow HMI to flip the temp switch
    await new Promise((r) => setTimeout(r, 150));

    // 3) Now send the actual set_temp command
    command = {
      type: "temperature",
      value: { set_temp: tempC },
      id: crypto.randomUUID(),
      vessel_id: vesselId,
    };
  } else if (spType === "motor") {
    command = {
      type: "motor",
      value: { set_rotations_hr: value },
      id: crypto.randomUUID(),
      vessel_id: vesselId,
    };
  } else if (spType === "blower") {
    command = {
      type: "air",
      value: { set_air: value },
      id: crypto.randomUUID(),
      vessel_id: vesselId,
    };
  } else if (spType === "temp-ctrl") {
    // value: 1 = enable, 0 = disable
    command = {
      type: "temperature",
      value: { compost_temp_ctrl_active_req: value ? 1 : 0 },
      id: crypto.randomUUID(),
      vessel_id: vesselId,
    };
  } else if (spType === "fault-reset") {
    // Captured from HMI when clicking reset in a valve-fault motor card
    command = {
      type: "reset",
      value: { reset: 1 },
      id: crypto.randomUUID(),
      vessel_id: vesselId,
    };
  } else {
    throw new Error("Unknown setpoint type: " + spType);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: hmiTabId },
    world: "MAIN",
    func: (cmd, hmiHost) => {
      // Find the HMI's WebSocket by matching the server host.
      // Ignores third-party sockets (PostHog, etc.) that share the page.
      const sockets = window.__WS_SOCKETS__;
      let ws = null;

      if (sockets) {
        for (const [url, s] of sockets) {
          if (url.includes(hmiHost) && s.readyState === WebSocket.OPEN) {
            ws = s;
            break;
          }
        }
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        const available = sockets
          ? [...sockets.keys()].join(", ") || "none"
          : "map not initialised — reload HMI tab";
        throw new Error(
          `No open HMI WebSocket on ${hmiHost}. Available: ${available}`,
        );
      }

      console.log("📤 WS SEND:", JSON.stringify(cmd));
      ws.send(JSON.stringify(cmd));
      return "sent";
    },
    args: [command, "atlas.earthfuneral.com"],
  });

  const result = results?.[0]?.result;
  const scriptErr = results?.[0]?.error;
  if (scriptErr) {
    console.error("❌ WS send script error:", scriptErr.message ?? scriptErr);
    throw new Error(scriptErr.message ?? String(scriptErr));
  }
  if (!result) throw new Error("executeScript returned no result");
  _log(`✅ WS send result: "${result}" for command type:${command?.type}`);
  return result;
}

// ============================================================
// Clicks the motor reset button for a vessel to clear a VALVE_FAULT.
// Phase 1 — HMI V2 (/v2/ URL): checks the direct reset button.
//   active   → clicks it, dismisses dialogs, returns true.
//   park-stop / not-found → falls through to Phase 2.
// Phase 2 — HMI V1 (/vessels/ URL, separate window): expands the reset panel
//   header and clicks the reset link.
// Returns true if any reset action was successfully performed.
async function _clickMotorResetButton(slotName, vesselId) {
  const V2_URL = `https://atlas.earthfuneral.com/internal/hmi/v2/vessels/${vesselId}`;
  const V1_URL = `https://atlas.earthfuneral.com/internal/hmi/vessels/${vesselId}`;

  const DIRECT_BTN_SELECTOR =
    "div.vessel-details__content > div:nth-child(3) > " +
    "div:nth-child(10) > div:nth-child(3) > div > button";
  const LEGACY_HEADER_SELECTOR =
    "#simple-tabpanel-0 > div > div > div.vessel_detail_tab_overview__reset > " +
    "div.vessel_detail_tab_overview__reset__header";
  const LEGACY_BTN_SELECTOR =
    "#simple-tabpanel-0 > div > div > div.vessel_detail_tab_overview__reset > " +
    "div.MuiCollapse-root.MuiCollapse-vertical.MuiCollapse-entered.css-1cbf1l2 > " +
    "div > div > div > a";
  const LEGACY_BTN_FLEX_SELECTOR =
    "#simple-tabpanel-0 .vessel_detail_tab_overview__reset .MuiCollapse-root a";

  // ── Phase 1: HMI V2 direct reset button ─────────────────────────────────
  _log(`🔄 [WATCHDOG] ${slotName} motor reset — checking HMI v2 reset button`);
  let phase1 = "notFound";
  let v2Tab = null;
  try {
    v2Tab = await chrome.tabs.create({ url: V2_URL, active: false });
    const tabId = v2Tab.id;
    if (!tabId) throw new Error("No tab ID from background tab");

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (sel) => {
          const btn = document.querySelector(sel);
          if (!btn) return { found: false };
          const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
          if (label.toLowerCase().includes("park"))
            return { found: true, parkStop: true, label };
          btn.click();
          return { found: true, parkStop: false, label };
        },
        args: [DIRECT_BTN_SELECTOR],
      });
      const r = results?.[0]?.result;
      if (r?.found) {
        if (r.parkStop) {
          _log(`⚠️ [WATCHDOG] ${slotName} HMI v2 reset button park-stop ("${r.label}") — falling back to HMI v1`);
          phase1 = "parkStop";
        } else {
          _log(`✅ [WATCHDOG] ${slotName} HMI v2 reset button clicked ("${r.label}")`);
          await new Promise((r) => setTimeout(r, 1000));
          await chrome.scripting.executeScript({
            target: { tabId }, world: "MAIN",
            func: async () => {
              for (let i = 0; i < 10; i++) {
                const b = document.querySelector("div.modalContent button");
                if (!b) break;
                b.click();
                await new Promise((r) => setTimeout(r, 500));
              }
            },
            args: [],
          });
          phase1 = "clicked";
        }
        break;
      }
    }
    if (phase1 === "notFound")
      _log(`🔄 [WATCHDOG] ${slotName} HMI v2 reset button not found — falling back to HMI v1`);
  } catch (err) {
    _log(`❌ [WATCHDOG] ${slotName} HMI v2 reset check error: ${err.message}`);
  } finally {
    if (v2Tab?.id) {
      try { await chrome.tabs.remove(v2Tab.id); _log(`🗑️ [WATCHDOG] ${slotName} background tab closed`); } catch (_) {}
    }
  }

  if (phase1 === "clicked") return true;

  // ── Phase 2: HMI V1 — expand reset panel then click link ────────────────
  _log(`🔄 [WATCHDOG] ${slotName} motor reset — opening HMI v1 legacy path`);
  let v1Tab = null;
  try {
    v1Tab = await chrome.tabs.create({ url: V1_URL, active: false });
    const tabId = v1Tab.id;
    if (!tabId) throw new Error("No tab ID from background tab");

    _log(`🔄 [WATCHDOG] ${slotName} legacy reset — polling for panel header`);
    let headerFound = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (hdrSel, btnSel, flexSel) => {
          if (document.querySelector(btnSel) || document.querySelector(flexSel))
            return { found: true, alreadyExpanded: true };
          const hdr = document.querySelector(hdrSel);
          if (!hdr) return { found: false };
          hdr.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return { found: true, alreadyExpanded: false };
        },
        args: [LEGACY_HEADER_SELECTOR, LEGACY_BTN_SELECTOR, LEGACY_BTN_FLEX_SELECTOR],
      });
      const r = results?.[0]?.result;
      if (r?.found) {
        if (!r.alreadyExpanded) {
          _log(`🔄 [WATCHDOG] ${slotName} legacy reset header clicked — waiting for panel to expand`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        headerFound = true;
        break;
      }
    }

    if (!headerFound) {
      _log(`❌ [WATCHDOG] ${slotName} motor reset — legacy panel header not found after 15 s`);
      return false;
    }

    _log(`🔄 [WATCHDOG] ${slotName} legacy reset — polling for reset link`);
    let clicked = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await chrome.scripting.executeScript({
        target: { tabId }, world: "MAIN",
        func: (exactSel, flexSel) => {
          const btn = document.querySelector(exactSel) || document.querySelector(flexSel);
          if (!btn) return { found: false };
          const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return { found: true, label };
        },
        args: [LEGACY_BTN_SELECTOR, LEGACY_BTN_FLEX_SELECTOR],
      });
      const r = results?.[0]?.result;
      if (r?.found) {
        _log(`✅ [WATCHDOG] ${slotName} legacy reset link clicked ("${r.label}")`);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      _log(`❌ [WATCHDOG] ${slotName} motor reset — legacy reset link not found after panel expand`);
      return false;
    }

    await new Promise((r) => setTimeout(r, 1000));
    await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: async () => {
        for (let i = 0; i < 10; i++) {
          const b = document.querySelector("div.modalContent button");
          if (!b) break;
          b.click();
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
      args: [],
    });
    return true;
  } catch (err) {
    _log(`❌ [WATCHDOG] ${slotName} motor reset click error: ${err.message}`);
    return false;
  } finally {
    if (v1Tab?.id) {
      try { await chrome.tabs.remove(v1Tab.id); _log(`🗑️ [WATCHDOG] ${slotName} background tab closed`); } catch (_) {}
    }
  }
}

// ============================================================
// Clicks the "Reset vessel" link in the process overview section of a vessel
// detail page. Used as the first recovery step when mixerFaulted is true.
// HMI v1 requires expanding the process panel header before the link is reachable.
async function _clickVesselResetLink(slotName, vesselId) {
  const vesselUrl = `https://atlas.earthfuneral.com/internal/hmi/vessels/${vesselId}`;
  const HEADER_SELECTOR =
    "#simple-tabpanel-0 > div > div > div.vessel_detail_tab_overview__process > " +
    "div.vessel_detail_tab_overview__process__header";
  const LINK_SELECTOR =
    "#simple-tabpanel-0 > div > div > div.vessel_detail_tab_overview__process > " +
    "div.MuiCollapse-root.MuiCollapse-vertical.MuiCollapse-entered.css-1cbf1l2 > " +
    "div > div > div > " +
    "div.vessel_detail_tab_overview__section.vessel_detail_tab_overview__reset__actions > a";
  const LINK_FLEX_SELECTOR =
    "#simple-tabpanel-0 .vessel_detail_tab_overview__process " +
    ".vessel_detail_tab_overview__reset__actions a";

  _log(`🔄 [WATCHDOG] ${slotName} vessel reset link click — opening background tab`);
  let bgTab = null;
  try {
    bgTab = await chrome.tabs.create({ url: vesselUrl, active: false });
    const tabId = bgTab.id;
    if (!tabId) throw new Error("No tab ID from background tab");

    // Step 1 — expand the process panel.
    _log(`🔄 [WATCHDOG] ${slotName} vessel reset — polling for process header`);
    let headerFound = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (hdrSel, lnkSel, flexSel) => {
          if (document.querySelector(lnkSel) || document.querySelector(flexSel))
            return { found: true, alreadyExpanded: true };
          const hdr = document.querySelector(hdrSel);
          if (!hdr) return { found: false };
          hdr.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return { found: true, alreadyExpanded: false };
        },
        args: [HEADER_SELECTOR, LINK_SELECTOR, LINK_FLEX_SELECTOR],
      });
      const r = results?.[0]?.result;
      if (r?.found) {
        if (!r.alreadyExpanded) {
          _log(`🔄 [WATCHDOG] ${slotName} process header clicked — waiting for panel to expand`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        headerFound = true;
        break;
      }
    }

    if (!headerFound) {
      _log(`❌ [WATCHDOG] ${slotName} vessel reset — process header not found after 15 s`);
      return false;
    }

    // Step 2 — click the reset link.
    _log(`🔄 [WATCHDOG] ${slotName} vessel reset — polling for reset link`);
    let clicked = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (exactSel, flexSel) => {
          const el = document.querySelector(exactSel) || document.querySelector(flexSel);
          if (!el) return { found: false };
          const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return { found: true, label };
        },
        args: [LINK_SELECTOR, LINK_FLEX_SELECTOR],
      });
      const r = results?.[0]?.result;
      if (r?.found) {
        _log(`✅ [WATCHDOG] ${slotName} vessel reset link clicked ("${r.label}")`);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      _log(`❌ [WATCHDOG] ${slotName} vessel reset — link not found after panel expand`);
      return false;
    }

    await new Promise((r) => setTimeout(r, 1000));
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        for (let i = 0; i < 10; i++) {
          const btn = document.querySelector("div.modalContent button");
          if (!btn) break;
          btn.click();
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
      args: [],
    });

    return true;
  } catch (err) {
    _log(`❌ [WATCHDOG] ${slotName} vessel reset link error: ${err.message}`);
    return false;
  } finally {
    if (bgTab?.id) {
      try {
        await chrome.tabs.remove(bgTab.id);
        _log(`🗑️ [WATCHDOG] ${slotName} background tab closed`);
      } catch (_) {}
    }
  }
}

// ============================================================
// Opens a silent background tab to the HMI v1 vessel detail page and clicks the rack
// reset link in the process overview section. HMI v1 requires expanding the
// process panel header before the link is reachable.
async function _resetRackForSlot(slotName, vesselId) {
  const vesselUrl = `https://atlas.earthfuneral.com/internal/hmi/vessels/${vesselId}`;
  const HEADER_SELECTOR =
    "#simple-tabpanel-0 > div > div > div.vessel_detail_tab_overview__process > " +
    "div.vessel_detail_tab_overview__process__header";
  const LINK_SELECTOR =
    "#simple-tabpanel-0 > div > div > div.vessel_detail_tab_overview__process > " +
    "div.MuiCollapse-root.MuiCollapse-vertical.MuiCollapse-entered.css-1cbf1l2 > " +
    "div > div > div > " +
    "div.vessel_detail_tab_overview__section.vessel_detail_tab_overview__reset__actions > a";
  const LINK_FLEX_SELECTOR =
    "#simple-tabpanel-0 .vessel_detail_tab_overview__process " +
    ".vessel_detail_tab_overview__reset__actions a";

  _log(`🔄 [WATCHDOG] ${slotName} rack reset — opening background tab`);
  let bgTab = null;
  try {
    bgTab = await chrome.tabs.create({ url: vesselUrl, active: false });
    const tabId = bgTab.id;
    if (!tabId) throw new Error("Could not get tab ID from background tab");

    // Step 1 — expand the process panel.
    _log(`🔄 [WATCHDOG] ${slotName} rack reset — polling for process header`);
    let headerFound = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (hdrSel, lnkSel, flexSel) => {
          if (document.querySelector(lnkSel) || document.querySelector(flexSel))
            return { found: true, alreadyExpanded: true };
          const hdr = document.querySelector(hdrSel);
          if (!hdr) return { found: false };
          hdr.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return { found: true, alreadyExpanded: false };
        },
        args: [HEADER_SELECTOR, LINK_SELECTOR, LINK_FLEX_SELECTOR],
      });
      const r = results?.[0]?.result;
      if (r?.found) {
        if (!r.alreadyExpanded) {
          _log(`🔄 [WATCHDOG] ${slotName} process header clicked — waiting for panel to expand`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        headerFound = true;
        break;
      }
    }

    if (!headerFound) {
      _log(`❌ [WATCHDOG] ${slotName} rack reset — process header not found after 15 s`);
      return;
    }

    // Step 2 — click the reset link.
    _log(`🔄 [WATCHDOG] ${slotName} rack reset — polling for reset link`);
    let clicked = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (exactSel, flexSel) => {
          const el = document.querySelector(exactSel) || document.querySelector(flexSel);
          if (!el) return { found: false };
          const label = (el.getAttribute("aria-label") || el.textContent || "").trim();
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return { found: true, label };
        },
        args: [LINK_SELECTOR, LINK_FLEX_SELECTOR],
      });
      const r = results?.[0]?.result;
      if (r?.found) {
        _log(`✅ [WATCHDOG] ${slotName} rack reset link clicked ("${r.label}")`);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      _log(`❌ [WATCHDOG] ${slotName} rack reset — link not found after panel expand`);
      return;
    }

    await new Promise((r) => setTimeout(r, 1000));
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        for (let i = 0; i < 10; i++) {
          const btn = document.querySelector("div.modalContent button");
          if (!btn) break;
          btn.click();
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
      args: [],
    });
    _log(`✅ [WATCHDOG] ${slotName} rack reset complete`);
  } catch (err) {
    _log(`❌ [WATCHDOG] ${slotName} rack reset error: ${err.message}`);
  } finally {
    if (bgTab?.id) {
      try {
        await chrome.tabs.remove(bgTab.id);
        _log(`🗑️ [WATCHDOG] ${slotName} background tab closed`);
      } catch (_) {}
    }
  }
}

// ============================================================
// Opens a silent popup to the HMI v2 vessel detail page (/v2/ URL) and checks
// the state of the direct reset button in the slot card. Returns:
//   "clicked"   — button found in active (fault/reset) state and clicked
//   "park-stop" — button found but in park/park-stop state (motor is parked)
//   "not-found" — button absent after 15 s (not on v2 HMI or page error)
async function _checkV2SlotCardReset(slotName, vesselId) {
  const vesselUrl = `https://atlas.earthfuneral.com/internal/hmi/v2/vessels/${vesselId}/details`;
  const BTN_SELECTOR =
    "div.vessel-details__content > div:nth-child(3) > " +
    "div:nth-child(10) > div:nth-child(3) > div > button";

  let bgTab = null;
  try {
    bgTab = await chrome.tabs.create({ url: vesselUrl, active: false });
    const tabId = bgTab.id;
    if (!tabId) throw new Error("No tab ID from background tab");

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (sel) => {
          const btn = document.querySelector(sel);
          if (!btn) return { found: false };
          const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
          if (label.toLowerCase().includes("park"))
            return { found: true, parkStop: true, label };
          if (btn.disabled)
            return { found: true, notActive: true, label };
          btn.click();
          return { found: true, parkStop: false, label };
        },
        args: [BTN_SELECTOR],
      });
      const r = results?.[0]?.result;
      if (r?.found) {
        if (r.parkStop) {
          _log(`⚠️ [WATCHDOG] ${slotName} v2 slot card reset in park-stop state ("${r.label}")`);
          return "park-stop";
        }
        if (r.notActive) {
          _log(`🟡 [WATCHDOG] ${slotName} v2 slot card reset button found but not active ("${r.label}")`);
          return "not-active";
        }
        _log(`✅ [WATCHDOG] ${slotName} v2 slot card reset clicked ("${r.label}")`);
        await new Promise((r) => setTimeout(r, 1000));
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: async () => {
            for (let i = 0; i < 10; i++) {
              const b = document.querySelector("div.modalContent button");
              if (!b) break;
              b.click();
              await new Promise((r) => setTimeout(r, 500));
            }
          },
          args: [],
        });
        return "clicked";
      }
    }
    _log(`🔄 [WATCHDOG] ${slotName} v2 slot card reset button not found after 15 s`);
    return "not-found";
  } catch (err) {
    _log(`❌ [WATCHDOG] ${slotName} v2 slot card reset error: ${err.message}`);
    return "not-found";
  } finally {
    if (bgTab?.id) {
      try {
        await chrome.tabs.remove(bgTab.id);
        _log(`🗑️ [WATCHDOG] ${slotName} background tab closed`);
      } catch (_) {}
    }
  }
}

// WATCHDOG ENGINE
// Runs every 5 minutes when enabled. Scans all occupied,
// non-parked slots and sends recovery commands as needed.
// ============================================================

async function _watchdogTick() {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const _tickNow = new Date();
  const _tickDate = _tickNow.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
  const _tickTime = _tickNow.toLocaleTimeString("en-US", { hour12: false });
  const _spLogRows = []; // collects successful setpoint sends for Drive Sheet log
  const _confirmedMotorRows = []; // motor rows confirmed running this tick → motor audit log

  // Confirm pending motor setpoints from the previous tick.
  // A row is only logged if the motor is now running; drop either way.
  for (const [slotName, pending] of _pendingMotorLog) {
    _pendingMotorLog.delete(slotName);
    const v = dashboardState[slotName];
    if (!v?.vesselPresent) continue;
    const ms = (v.mixerModuleStatus || "").toUpperCase();
    const confirmed = ms === "MIXER_RUNNING" || ms === "MIXER_MIXING" || ms === "ON";
    if (confirmed) {
      _confirmedMotorRows.push(pending);
    }
  }

  const slots = Object.entries(dashboardState);
  _log(`🤖 [WATCHDOG] Tick — scanning ${slots.length} slots`);

  // Resolve HMI tab once; all commands this tick share it
  const allTabs = await chrome.tabs.query({});
  const hmiTab = allTabs.find((t) => t.url?.includes("/internal/hmi/"));
  if (!hmiTab) {
    _log("⚠️ [WATCHDOG] HMI tab not found — skipping tick");
    return;
  }

  // Refresh pause state immediately so we never act on stale data — without this
  // the watchdog could try to restart slots in the ~5 min window between background
  // polls, giving the operator almost no time to open a rack door after pausing.
  await syncRackPauseState();

  let actionsFound = 0;

  for (const [slotName, v] of slots) {
    if (!v.vesselPresent) continue;

    const t = v.telemetry || {};

    // Skip slots with no telemetry yet (service worker just restarted)
    if (!t.lastUpdate) continue;

    // power_inactive = motor drive has no power (e.g. breaker off); watchdog cannot fix this
    const powerInactive = (v.mixerModuleStatus || "").toLowerCase() === "power_inactive";
    // wait_vessel = rack is waiting for a vessel to be physically connected; nothing to act on
    const waitVessel = (v.mechanicalStatus || "").toLowerCase() === "wait_vessel";
    if (powerInactive || waitVessel) continue;

    // ctrl_inactive = motor control disabled by HMI; may be recoverable.
    // Only skip if the rack group is also deliberately paused (A slot occupied),
    // which confirms an operator intentionally stopped this slot.
    const ctrlInactive = (v.mechanicalStatus || "").toLowerCase().includes("ctrl_inactive");
    if (ctrlInactive && v.rackGroupPaused === true) {
      const aSlotName = slotName.replace(/[A-Z]$/, "A");
      const aSlot = dashboardState[aSlotName];
      // wait_vessel on A (even with a faulted status) means the slot is physically empty —
      // treat it the same as no vessel so B/C slots are not incorrectly skipped.
      const aWaitVessel = (aSlot?.mechanicalStatus || "").toLowerCase() === "wait_vessel";
      const aHasVessel = aSlot?.vesselPresent === true && !aWaitVessel;
      if (aHasVessel) {
        _log(`⏸️  [WATCHDOG] ${slotName} skipping — ctrl_inactive + rack manually paused`);
        continue;
      }
    }

    // rackGroupPaused is set when the HMI shows "reset rack" for this column.
    // The HMI also sets this automatically when the A position is empty — that is
    // NOT a manual pause, and B/C slots should continue to be monitored.
    // We treat it as an intentional pause only when the A slot also has a vessel,
    // which means an operator explicitly paused a running rack group.
    // A slot showing wait_vessel (even combined with a faulted status) is physically
    // empty; the HMI activates "reset rack" automatically in that state, so it is
    // NOT a manual pause and B/C slots still need watchdog care.
    if (v.rackGroupPaused === true) {
      const aSlotName = slotName.replace(/[A-Z]$/, "A");
      const aSlot = dashboardState[aSlotName];
      const aWaitVessel = (aSlot?.mechanicalStatus || "").toLowerCase() === "wait_vessel";
      const aHasVessel = aSlot?.vesselPresent === true && !aWaitVessel;
      if (aHasVessel) {
        _log(`⏸️  [WATCHDOG] ${slotName} skipping — rack manually paused (A position occupied)`);
        continue;
      }
      // No vessel in A (or A shows wait_vessel) → HMI auto-pause; B/C slots still need watchdog care — fall through
    }

    const vesselLabel = v.vesselName ? `${slotName} (${v.vesselName})` : slotName;
    const vesselId    = v.vesselId;

    // Derived state
    const valveFault   = v.valveModuleStatus === "VALVE_FAULT";

    // Detect valve fault clearing: was active last tick, now resolved → log it
    if (valveFault) {
      _watchdogValveFaultActive.set(slotName, true);
    } else if (_watchdogValveFaultActive.has(slotName)) {
      _watchdogValveFaultActive.delete(slotName);
      _log(`✅ [WATCHDOG] ${slotName} valve fault cleared`);
      _spLogRows.push({ date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", spType: "valve-fault", value: "", note: "valve fault cleared", envReading: "" });
    }

    const mixerStatus  = (v.mixerModuleStatus || "").toUpperCase();
    const mixerFaulted = mixerStatus === "MIXER_FAULTED";
    const motorStopped = mixerStatus === "MIXER_STOPPED";
    const inSpanMitg   = (v.tempModuleStatus || "").toLowerCase() === "temp_span_mitg";
    const declogActive = v.intake_declog_req === 1 || v.exhaust_declog_req === 1;
    const airflow      = typeof t.airflow === "number" ? t.airflow : null;
    const pressure     = typeof t.pressure === "number" ? t.pressure : null;
    const pressureHigh = pressure !== null && pressure > 9;
    // valveModuleStatus "ON" = blower commanded on by HMI (API, refreshed every 2 min).
    // airflow > 0 = live WS telemetry confirms flow.
    // lastAirflowPositiveAt within 3 min = WS confirmed flow recently; guards against
    // stale valve status + gap between WS frames causing a false "blower off" read.
    const AIRFLOW_RECENCY_MS = 3 * 60_000;
    const blowerOn     = (v.valveModuleStatus || "").toUpperCase() === "ON" ||
                         (airflow ?? 0) > 0 ||
                         (v.lastAirflowPositiveAt ?? 0) > Date.now() - AIRFLOW_RECENCY_MS;

    // Motor is confirmed running when mixerModuleStatus reports an active state.
    // "ON" is included to match dashboard.js isMotorRunning() — some HMI versions
    // report this value instead of MIXER_RUNNING when the motor is commanded on.
    // Temp ctrl and blower are never sent until this is true — they depend on
    // the motor being operational.
    const motorRunning = mixerStatus === "MIXER_RUNNING" || mixerStatus === "MIXER_MIXING" || mixerStatus === "ON";

    // Probe delta alarm — mirrors dashboard.js logic exactly.
    // Probes are highlighted red when ALL THREE are present, span mitigation is
    // active, AND the spread between the highest and lowest is >= 8°F.
    // When this is true the HMI blocks temp ctrl commands; skip in that case.
    // When false (probes converged or not in span mitg) temp ctrl is safe to send.
    const _toF     = (c) => (typeof c === "number" && !isNaN(c)) ? (c * 9 / 5 + 32) : null;
    const _p       = [_toF(t.temp0), _toF(t.temp1), _toF(t.temp2)].filter((x) => x !== null);
    const _pDelta  = _p.length === 3 ? Math.max(..._p) - Math.min(..._p) : 0;
    const probeDeltaAlarm = inSpanMitg && _p.length === 3 && _pDelta >= 8;
    const avgTempF = _p.length > 0 ? _p.reduce((a, b) => a + b, 0) / _p.length : null;

    // Use the last collected motor setpoint so an unexpected stop restarts at the
    // configured speed (supports experimenting with non-default speeds).
    // Fault-reset does NOT clear the motor speed field, so the HMI rejects a value
    // equal to what is already in the field — send 1 R/hr offset to force acceptance.
    let desiredMotorSp = v.setpoints?.motorSp ?? 60;
    let faultMotorSp   = desiredMotorSp > 1 ? desiredMotorSp - 1 : desiredMotorSp + 1;
    const tempSp       = v.setpoints?.tempSp ?? 120;
    const airSp        = (v.setpoints?.airflowSp > 0 ? v.setpoints.airflowSp : null) ?? 65;

    const tempNearSetpoint = avgTempF !== null && avgTempF >= tempSp - 5;

    // ── PRE-ACTION MOTOR CHECK ────────────────────────────────────────────
    // Before sending any motor setpoint, pull the live HMI value and confirm
    // rotation state so we act on fresh data, not a potentially stale cache.
    const motorActionNeeded = (valveFault || mixerFaulted || motorStopped) && vesselId != null;
    if (motorActionNeeded) {
      const cachedSp = v.setpoints?.motorSp ?? null;
      const liveSp   = await fetchSetpoint(vesselId, "motor", "set_rotations_hr");
      if (liveSp !== null) {
        if (liveSp !== cachedSp) {
          _log(`🔄 [WATCHDOG] ${slotName} motor SP changed since last poll: ${cachedSp} → ${liveSp} R/hr — updating`);
          if (dashboardState[slotName]?.setpoints) dashboardState[slotName].setpoints.motorSp = liveSp;
          desiredMotorSp = liveSp;
          faultMotorSp   = desiredMotorSp > 1 ? desiredMotorSp - 1 : desiredMotorSp + 1;
        } else {
          _log(`✅ [WATCHDOG] ${slotName} motor SP unchanged at ${liveSp} R/hr`);
        }
      } else {
        _log(`⚠️ [WATCHDOG] ${slotName} live motor SP fetch failed — using cached ${cachedSp} R/hr`);
      }
      _log(`🔄 [WATCHDOG] ${slotName} rotation: ${mixerStatus} | SP: ${desiredMotorSp} R/hr (unlock: ${faultMotorSp})`);
    }

    // ── 1. VALVE FAULT / MIXER FAULTED ───────────────────────────────────
    // A background off-screen popup clicks the HMI reset button to clear the
    // fault (invisible on kiosk display), then WS motor setpoints restart the
    // motor. If the motor is already confirmed running the fault flag is
    // residual — skip and fall through to temp ctrl / blower checks instead.
    if ((valveFault || mixerFaulted) && !motorRunning) {
      _watchdogMotorRetry.delete(slotName); // fault path takes over — clear any pending retry
      const faultLabel = mixerFaulted ? "MIXER FAULTED" : "VALVE FAULT";
      _log(`🔴 [WATCHDOG] ${slotName} ${faultLabel} — ${vesselLabel}`);
      _log(`🔴 [WATCHDOG] ${slotName} → reset click + motor ${faultMotorSp}→${desiredMotorSp} R/hr (temp ctrl on next tick)`);
      actionsFound++;
      if (vesselId != null) {
        try {
          if (mixerFaulted) {
            // Try the HMI reset button first. If it is not present, fall back
            // to the vessel reset link (which surfaces the button on next load).
            _log(`🔴 [WATCHDOG] ${slotName} MIXER FAULTED — trying HMI reset button`);
            const resetClicked = await _clickMotorResetButton(slotName, vesselId);
            if (!resetClicked) {
              _log(`🔴 [WATCHDOG] ${slotName} HMI reset button unavailable — using vessel reset link`);
              await _clickVesselResetLink(slotName, vesselId);
              await new Promise((r) => setTimeout(r, 1000));
            }
          } else {
            await _clickMotorResetButton(slotName, vesselId);
          }
          await new Promise((r) => setTimeout(r, 500));
          // Send sp-1 first — HMI rejects a value equal to the stored setpoint, so this
          // unlocks acceptance. Then immediately restore to the intended setpoint so the
          // API reflects the correct value and desiredMotorSp never drifts across ticks.
          await sendWsSetpoint(hmiTab.id, vesselId, "motor", faultMotorSp);
          _log(`✅ [WATCHDOG] ${slotName} motor speed sent: ${faultMotorSp} R/hr (unlock)`);
          await new Promise((r) => setTimeout(r, 500));
          await sendWsSetpoint(hmiTab.id, vesselId, "motor", desiredMotorSp);
          _log(`✅ [WATCHDOG] ${slotName} motor speed sent: ${desiredMotorSp} R/hr`);
          _pendingMotorLog.set(slotName, { date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", value: desiredMotorSp, note: faultLabel, envReading: avgTempF != null ? +avgTempF.toFixed(1) : "" });
        } catch (err) {
          _log(`❌ [WATCHDOG] ${slotName} fault recovery error: ${err.message}`);
        }
      }
      continue; // motor not yet running — temp ctrl deferred to next tick
    }
    if ((valveFault || mixerFaulted) && motorRunning) {
      const faultLabel = mixerFaulted ? "MIXER FAULTED" : "VALVE FAULT";
      _log(`🟠 [WATCHDOG] ${slotName} ${faultLabel} but motor confirmed running — skipping reset, checking temp/blower`);

      // Valve fault + motor running + blower commanded on but airflow is low:
      // The fault is blocking actual air movement — setpoints sent while the fault
      // is active are ignored by the HMI. Clear the fault now and defer all setpoints
      // to the next tick. The fault clear resets the blower SP to 0; the low-airflow
      // check in section 4b on the following tick will detect the zero SP and re-send.
      // Note: the reset briefly causes the API to show no vessel for the slot — this
      // resolves on the next refreshRackState poll (~30 s) and is an accepted tradeoff.
      const airflowLow = airflow !== null && airflow < 30;
      if (valveFault && blowerOn && airflowLow && !declogActive && vesselId != null) {
        _log(`🔴 [WATCHDOG] ${slotName} VALVE FAULT — blower on but airflow ${airflow?.toFixed(1)} l/min — clearing fault, deferring setpoints to next tick`);
        actionsFound++;
        try {
          const v2Result = await _checkV2SlotCardReset(slotName, vesselId);
          if (v2Result === "clicked") {
            _log(`✅ [WATCHDOG] ${slotName} valve fault cleared via v2 reset — airflow monitored next tick`);
          } else {
            // v2 button is park-stop (motor running) or not found — use WS fault-reset
            _log(`⚠️ [WATCHDOG] ${slotName} v2 reset ${v2Result} — sending WS fault-reset`);
            await sendWsSetpoint(hmiTab.id, vesselId, "fault-reset", 1);
            _log(`✅ [WATCHDOG] ${slotName} WS fault-reset sent`);
          }
          _spLogRows.push({ date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", spType: "valve-fault", value: "", note: "fault clear attempted — blower on, low airflow", envReading: airflow != null ? +airflow.toFixed(1) : "" });
        } catch (err) {
          _log(`❌ [WATCHDOG] ${slotName} fault clear error: ${err.message}`);
        }
        continue; // defer all setpoints — let next tick handle airflow after fault clears
      }
    }

    // ── 2. MOTOR STOPPED unexpectedly (no fault) ─────────────────────────
    // Check HMI v2 reset button first (primary path):
    //   "clicked"    → v2 button was active, clicked it → send motor SP and done.
    //   "park-stop"  → motor is parked in v2; trigger HMI v1 rack reset → send motor SP.
    //   "not-active" → button found but disabled; send motor SP as step 1, escalate next tick.
    //   "not-found"  → fall through to WS setpoint retry sequence.
    if (motorStopped && vesselId != null) {
      actionsFound++;

      const v2Result = await _checkV2SlotCardReset(slotName, vesselId);

      if (v2Result === "clicked") {
        _log(`🟡 [WATCHDOG] ${slotName} MOTOR STOPPED — v2 reset clicked, sending motor SP`);
        _watchdogMotorRetry.delete(slotName);
        _watchdogMotorFailCount.delete(slotName);
        try {
          await sendWsSetpoint(hmiTab.id, vesselId, "motor", desiredMotorSp);
          _log(`✅ [WATCHDOG] ${slotName} motor speed sent: ${desiredMotorSp} R/hr`);
          _pendingMotorLog.set(slotName, { date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", value: desiredMotorSp, note: "v2 reset", envReading: avgTempF != null ? +avgTempF.toFixed(1) : "" });
        } catch (err) {
          _log(`❌ [WATCHDOG] ${slotName} motor restart error: ${err.message}`);
        }
        continue;
      }

      if (v2Result === "park-stop") {
        _log(`🟡 [WATCHDOG] ${slotName} MOTOR STOPPED — v2 btn park-stop, triggering HMI v1 rack reset`);
        _watchdogMotorRetry.delete(slotName);
        _watchdogMotorFailCount.delete(slotName);
        const lastReset = _watchdogRackResetAt.get(slotName) ?? 0;
        if (Date.now() - lastReset > RACK_RESET_COOLDOWN_MS) {
          _watchdogRackResetAt.set(slotName, Date.now());
          await _resetRackForSlot(slotName, vesselId);
          try {
            await sendWsSetpoint(hmiTab.id, vesselId, "motor", desiredMotorSp);
            _log(`✅ [WATCHDOG] ${slotName} motor speed sent: ${desiredMotorSp} R/hr`);
            _pendingMotorLog.set(slotName, { date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", value: desiredMotorSp, note: "v1 rack reset", envReading: avgTempF != null ? +avgTempF.toFixed(1) : "" });
          } catch (err) {
            _log(`❌ [WATCHDOG] ${slotName} motor restart error after rack reset: ${err.message}`);
          }
        } else {
          const secsAgo = Math.round((Date.now() - lastReset) / 1000);
          _log(`⏳ [WATCHDOG] ${slotName} rack reset on cooldown (last: ${secsAgo}s ago)`);
        }
        continue;
      }

      // v2 reset button found but not active — send setpoint as step 1.
      // On the next tick, if motor is still stopped, fall through to the WS
      // escalation sequence (fault-reset + dual setpoint).
      if (v2Result === "not-active" && !_watchdogMotorRetry.has(slotName)) {
        _watchdogMotorRetry.set(slotName, Date.now());
        _log(`🟡 [WATCHDOG] ${slotName} MOTOR STOPPED — reset btn not active, sending motor SP ${desiredMotorSp} R/hr`);
        try {
          await sendWsSetpoint(hmiTab.id, vesselId, "motor", desiredMotorSp);
          _log(`✅ [WATCHDOG] ${slotName} motor speed sent: ${desiredMotorSp} R/hr`);
          _pendingMotorLog.set(slotName, { date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", value: desiredMotorSp, note: "v2 not-active", envReading: avgTempF != null ? +avgTempF.toFixed(1) : "" });
        } catch (err) {
          _log(`❌ [WATCHDOG] ${slotName} motor restart error: ${err.message}`);
        }
        continue;
      }

      // v2 button not found (or not-active on a subsequent tick) — fall through to WS setpoint retry sequence
      if (_watchdogMotorRetry.has(slotName)) {
        // Second attempt — first try didn't get it running
        _watchdogMotorRetry.delete(slotName);
        const failCount = (_watchdogMotorFailCount.get(slotName) ?? 0) + 1;
        _watchdogMotorFailCount.set(slotName, failCount);
        _log(`🟡 [WATCHDOG] ${slotName} MOTOR STILL STOPPED — fault-reset + speed ${faultMotorSp}→${desiredMotorSp} R/hr (fail cycle ${failCount}/${RACK_RESET_THRESHOLD})`);
        try {
          await sendWsSetpoint(hmiTab.id, vesselId, "fault-reset", 1);
          _log(`✅ [WATCHDOG] ${slotName} fault-reset sent`);
          await new Promise((r) => setTimeout(r, 1500));
          await sendWsSetpoint(hmiTab.id, vesselId, "motor", faultMotorSp);
          _log(`✅ [WATCHDOG] ${slotName} motor speed sent: ${faultMotorSp} R/hr (unlock)`);
          await new Promise((r) => setTimeout(r, 500));
          await sendWsSetpoint(hmiTab.id, vesselId, "motor", desiredMotorSp);
          _log(`✅ [WATCHDOG] ${slotName} motor speed sent: ${desiredMotorSp} R/hr (retry)`);
          _pendingMotorLog.set(slotName, { date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", value: desiredMotorSp, envReading: avgTempF != null ? +avgTempF.toFixed(1) : "" });
        } catch (err) {
          _log(`❌ [WATCHDOG] ${slotName} motor retry error: ${err.message}`);
        }
        if (failCount >= RACK_RESET_THRESHOLD) {
          const lastReset = _watchdogRackResetAt.get(slotName) ?? 0;
          if (Date.now() - lastReset > RACK_RESET_COOLDOWN_MS) {
            _watchdogRackResetAt.set(slotName, Date.now());
            _watchdogMotorFailCount.delete(slotName);
            await _resetRackForSlot(slotName, vesselId);
          } else {
            const secsAgo = Math.round((Date.now() - lastReset) / 1000);
            _log(`⏳ [WATCHDOG] ${slotName} rack reset on cooldown (last: ${secsAgo}s ago)`);
          }
        }
      } else {
        // First attempt
        _watchdogMotorRetry.set(slotName, Date.now());
        _log(`🟡 [WATCHDOG] ${slotName} MOTOR STOPPED — sending speed ${desiredMotorSp} R/hr`);
        try {
          await sendWsSetpoint(hmiTab.id, vesselId, "motor", desiredMotorSp);
          _log(`✅ [WATCHDOG] ${slotName} motor speed sent: ${desiredMotorSp} R/hr`);
          _pendingMotorLog.set(slotName, { date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", value: desiredMotorSp, envReading: avgTempF != null ? +avgTempF.toFixed(1) : "" });
        } catch (err) {
          _log(`❌ [WATCHDOG] ${slotName} motor restart error: ${err.message}`);
        }
      }
      continue; // temp ctrl and blower deferred — motor must confirm running first
    }

    const DECLOG_COOLDOWN_MS        = 60_000;
    const BLOWER_COOLDOWN_MS        = 3 * 60_000;
    const declogRecentlyCleared     = (v.lastDeclogClearedAt      ?? 0) > Date.now() - DECLOG_COOLDOWN_MS;
    const blowerSetpointRecentlySent = (v.lastBlowerSetpointSentAt ?? 0) > Date.now() - BLOWER_COOLDOWN_MS;
    const rawAirflowSp              = v.setpoints?.airflowSp;
    const LOW_AIRFLOW_THRESHOLD     = 30;

    // ── 4b. BLOWER ON but LOW AIRFLOW with zero/missing setpoint ────────────
    // Runs before the motorRunning gate — the blower operates independently of
    // the motor, so a stale/zero setpoint must be corrected regardless of mixer state.
    if (
      blowerOn &&
      airflow !== null && airflow < LOW_AIRFLOW_THRESHOLD &&
      !(rawAirflowSp > 0) &&
      !declogActive &&
      !blowerSetpointRecentlySent &&
      vesselId != null
    ) {
      _log(`💨 [WATCHDOG] ${slotName} BLOWER ON but LOW AIRFLOW (${airflow?.toFixed(1)} l/min), setpoint is ${rawAirflowSp ?? "null"} — re-sending ${airSp} l/min`);
      actionsFound++;
      try {
        await sendWsSetpoint(hmiTab.id, vesselId, "blower", airSp);
        v.lastBlowerSetpointSentAt = Date.now();
        _log(`✅ [WATCHDOG] ${slotName} airflow setpoint re-sent: ${airSp} l/min`);
        _spLogRows.push({ date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", spType: "blower", value: airSp, note: "low airflow SP=0", envReading: pressure != null ? +pressure.toFixed(1) : "" });
        setTimeout(collectAllSetpoints, 2000);
      } catch (err) {
        _log(`❌ [WATCHDOG] ${slotName} blower re-send error: ${err.message}`);
      }
    }

    // ── Motor not confirmed running (transitioning / unknown state) ───────
    // Do not send temp ctrl or blower-off until mixerModuleStatus confirms active.
    if (!motorRunning) {
      _log(`⏳ [WATCHDOG] ${slotName} motor not confirmed running (${mixerStatus || "unknown"}) — skipping temp/blower`);
      continue;
    }

    // Motor is confirmed running — clear any stale retry/fail state
    _watchdogMotorRetry.delete(slotName);
    _watchdogMotorFailCount.delete(slotName);
    _watchdogRackResetAt.delete(slotName);

    // ── 3. TEMP CONTROL OFF (motor confirmed running) ─────────────────────
    // Act when tempControlOn is anything other than true:
    //   false = HMI scrape confirmed off
    //   null  = scrape has not run for this vessel yet — treat as needing enable
    // Guard: skip only when probe delta alarm is active (inSpanMitg AND delta
    // >= 10°F). If span mitigation is active but probes have converged (delta
    // < 10°F, not highlighted red), the HMI will accept the command — send it.
    if (v.tempControlOn !== true && motorRunning && !probeDeltaAlarm && !tempNearSetpoint && vesselId != null) {
      const spanNote = inSpanMitg ? ` [span mitg, delta ${_pDelta.toFixed(1)}°F — probes OK]` : "";
      _log(`🌡️  [WATCHDOG] ${slotName} TEMP CTRL OFF (state: ${v.tempControlOn})${spanNote} — enabling @ ${tempSp}°F`);
      actionsFound++;
      try {
        await sendWsSetpoint(hmiTab.id, vesselId, "temp", tempSp);
        _log(`✅ [WATCHDOG] ${slotName} temp ctrl enabled @ ${tempSp}°F`);
        _spLogRows.push({ date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", spType: "temp", value: tempSp, envReading: avgTempF != null ? +avgTempF.toFixed(1) : "", note: "temp ctrl off" });
      } catch (err) {
        _log(`❌ [WATCHDOG] ${slotName} temp ctrl error: ${err.message}`);
      }
    } else if (v.tempControlOn !== true && tempNearSetpoint) {
      _log(`⏸️  [WATCHDOG] ${slotName} temp ctrl not on — avg temp ${avgTempF.toFixed(1)}°F within 5°F of setpoint ${tempSp}°F, skipping`);
    } else if (v.tempControlOn !== true && probeDeltaAlarm) {
      _log(`⏸️  [WATCHDOG] ${slotName} temp ctrl not on — probe delta ${_pDelta.toFixed(1)}°F >= 10°F during span mitigation, skipping`);
    }

    // ── 4. BLOWER OFF (motor running, pressure OK, not in declog, no recent declog) ──
    // State sources: valveModuleStatus (API, 2-min refresh), live airflow WS telemetry,
    // and lastAirflowPositiveAt recency window — all combined in blowerOn above.
    // Post-send cooldown prevents re-sending before API/telemetry have had time to
    // reflect the new blower state (API refreshes every 2 min; cooldown is 3 min).
    if (!blowerOn && !declogActive && !declogRecentlyCleared && !blowerSetpointRecentlySent && !pressureHigh && vesselId != null) {
      _log(`💨 [WATCHDOG] ${slotName} BLOWER OFF (valve: ${v.valveModuleStatus || "?"}, airflow: ${airflow ?? "?"}, lastFlow: ${v.lastAirflowPositiveAt ? Math.round((Date.now()-v.lastAirflowPositiveAt)/1000)+"s ago" : "never"}, pressure: ${pressure?.toFixed(1) ?? "?"} kPa) — sending ${airSp} l/min`);
      actionsFound++;
      try {
        if (valveFault) {
          _log(`🔴 [WATCHDOG] ${slotName} VALVE FAULT active — clearing fault before blower setpoint`);
          await _clickMotorResetButton(slotName, vesselId);
          await new Promise((r) => setTimeout(r, 500));
        }
        await sendWsSetpoint(hmiTab.id, vesselId, "blower", airSp);
        v.lastBlowerSetpointSentAt = Date.now();
        _log(`✅ [WATCHDOG] ${slotName} airflow setpoint sent: ${airSp} l/min`);
        _spLogRows.push({ date: _tickDate, time: _tickTime, slotId: slotName, vesselNumber: v.vesselName ?? "", spType: "blower", value: airSp, envReading: pressure != null ? +pressure.toFixed(1) : "", note: valveFault ? "blower off + valve fault" : "blower off" });
      } catch (err) {
        _log(`❌ [WATCHDOG] ${slotName} blower error: ${err.message}`);
      }
    } else if (!blowerOn && blowerSetpointRecentlySent) {
      const secsAgo = Math.round((Date.now() - v.lastBlowerSetpointSentAt) / 1000);
      _log(`⏳ [WATCHDOG] ${slotName} BLOWER OFF — setpoint sent ${secsAgo}s ago, waiting for state to settle (3 min cooldown)`);
    } else if (!blowerOn && declogRecentlyCleared) {
      const secsAgo = Math.round((Date.now() - v.lastDeclogClearedAt) / 1000);
      _log(`⏳ [WATCHDOG] ${slotName} BLOWER OFF — declog cleared ${secsAgo}s ago, skipping (60s cooldown)`);
    }
  }

  if (actionsFound === 0) {
    _log("✅ [WATCHDOG] All nominal — no intervention needed");
  } else {
    _log(`🤖 [WATCHDOG] Tick complete — ${actionsFound} slot(s) actioned`);
  }

  // Flush successful setpoint sends to Drive Sheet log
  if (_spLogRows.length) {
    try {
      await appendSetpointLogRows(_spLogRows);
    } catch (e) {
      _log("⚠️ [WATCHDOG] setpoint log write failed:", e.message);
    }
  }

  // Flush confirmed motor rows to the immutable Motor Audit Log tab
  if (_confirmedMotorRows.length) {
    try {
      await appendMotorAuditRows(_confirmedMotorRows);
    } catch (e) {
      _log("⚠️ [WATCHDOG] motor audit log write failed:", e.message);
    }
  }

  // Write tick summary to storage so the dashboard log panel updates
  chrome.storage.local.get(["watchdog_log"], ({ watchdog_log = [] }) => {
    const entry = { time: ts, type: "tick", actions: actionsFound, ts: Date.now() };
    chrome.storage.local.set({ watchdog_log: [entry, ...watchdog_log].slice(0, 100) });
  });
}

// Stable per-machine identifier — generated once, persisted in local storage.
let _machineId = null;

// Designated watchdog host — only this machine ever runs the watchdog interval.
// Any dashboard machine can enable/disable; ownership always routes to this IP.
const WATCHDOG_HOST_IP = "192.168.50.176";
let _machineIp = null;

function _isWatchdogOwner() {
  return _machineIp === WATCHDOG_HOST_IP;
}

function _startWatchdog() {
  if (_watchdogInterval) return;
  _watchdogInterval = setInterval(_watchdogTick, 2 * 60 * 1000); // every 2 min
  _watchdogTick(); // run immediately on enable
  _log("🤖 Watchdog STARTED (host: " + WATCHDOG_HOST_IP + ")");
}

function _stopWatchdog() {
  if (_watchdogInterval) {
    clearInterval(_watchdogInterval);
    _watchdogInterval = null;
  }
  _log("🤖 Watchdog STOPPED");
}

// Drive poll — reads watchdog_sync.json from Drive and applies state if newer than local
async function _drivePoll() {
  try {
    const remote = await readDriveState();
    if (!remote || typeof remote.changedAt !== "number") {
      _log("⚠️ [DRIVE SYNC] Poll got unexpected response:", JSON.stringify(remote));
      return;
    }
    _log(`🌐 [DRIVE SYNC] Poll — watchdog ${remote.enabled ? `✅ running on ${remote.ownedBy ?? "unknown"}` : "⛔ disabled"}`);
    if (remote.changedAt <= _driveLastKnownAt) return;
    const local = await new Promise(r => chrome.storage.local.get(["watchdog_state"], r));
    const localAt = local.watchdog_state?.changedAt ?? 0;
    if (remote.changedAt > localAt) {
      _driveLastKnownAt = remote.changedAt;
      chrome.storage.local.set({ watchdog_state: remote });
      _log("🌐 [DRIVE SYNC] Applied remote state:", remote.enabled ? "ON" : "OFF", "by", remote.changedBy);
    }
  } catch (e) {
    _log("⚠️ [DRIVE SYNC] Poll error:", e.message);
  }
}
// ═══ UPTIME: Grafana poll (owner) + Drive sync (readers) ════════════════════
//
// Owner (kiosk PC, WATCHDOG_HOST_IP):
//   Queries Grafana /api/ds/query for every active slot using basic auth.
//   Stores grafanaPct per vessel, saves to chrome.storage.local + Drive.
//   Runs on startup and every 2 minutes.
//
// Readers (all other machines):
//   Never contact Grafana. Poll Drive uptime_sync.json every 2 min.
//   On startup: immediate Drive read so badges populate without waiting.
//
function _saveUptimeData() {
  if (!_isWatchdogOwner()) return;
  const snapshot = {};
  for (const [vId, ud] of Object.entries(_uptimeData))
    snapshot[vId] = { ...ud };
  chrome.storage.local.set({ vesselUptime: snapshot });
  writeUptimeState(snapshot).catch(e => _log("⚠️ [UPTIME] Drive write:", e.message));
}

async function _pollDriveUptime() {
  try {
    const remote = await readUptimeState();
    if (remote && typeof remote === "object") _uptimeData = remote;
  } catch (e) {
    _log("⚠️ [UPTIME] Drive read:", e.message);
  }
}

async function _pollGrafanaUptime() {
  if (!_isWatchdogOwner()) return;
  const s = await new Promise(r => chrome.storage.local.get(
    ["GRAFANA_URL", "GRAFANA_USER", "GRAFANA_PASS", "GRAFANA_DS_UID", "GRAFANA_RACK_PFX"], r
  ));
  const url  = s.GRAFANA_URL  || "https://grafana.earthfuneral.tech";
  const user = s.GRAFANA_USER || "";
  const pass = s.GRAFANA_PASS || "";
  const dsUid = s.GRAFANA_DS_UID  || "dstimescale1";
  const pfx   = s.GRAFANA_RACK_PFX || "11";
  if (!user || !pass) {
    _log("⚠️ [UPTIME] Grafana credentials not set — skipping poll");
    return;
  }
  const auth = "Basic " + btoa(`${user}:${pass}`);
  const activeSlots = Object.entries(dashboardState).filter(
    ([, v]) => v.vesselId != null && v.vesselPresent
  );
  const now = Date.now();
  await Promise.all(activeSlots.map(async ([slotName, v]) => {
    const vId        = v.vesselId;
    const rackId     = `${pfx}_${slotName}`;
    const caseStart  = _caseStartTs(slotName);
    if (!_uptimeData[vId])
      _uptimeData[vId] = _uptimeRecord(_hallViewCaseNames[slotName], caseStart);
    try {
      const res = await fetch(`${url}/api/ds/query`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: [{
            datasource: { uid: dsUid },
            rawSql: `SELECT ts, mixer_turning FROM rack_operational($__timeFrom(), $__timeTo(), '${rackId}')`,
            format: "table", rawQuery: true, refId: "A"
          }],
          from: String(caseStart),
          to:   String(now)
        })
      });
      if (!res.ok) return;
      const frames = (await res.json()).results?.A?.frames;
      if (!frames?.[0]) return;
      const vals = frames[0].data.values[1]; // mixer_turning column
      if (!vals?.length) return;
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      _uptimeData[vId].grafanaPct  = Math.round(mean * 1000) / 10;
      _uptimeData[vId].lastFetchAt = now;
    } catch (e) {
      _log(`⚠️ [UPTIME] Grafana fetch failed for ${slotName}:`, e.message);
    }
  }));
  _saveUptimeData();
}

// Startup
chrome.storage.local.get(["vesselUptime"], (res) => {
  if (chrome.runtime.lastError) return;
  _uptimeData = res?.vesselUptime ?? {};
  if (_isWatchdogOwner()) _pollGrafanaUptime();
  else _pollDriveUptime();
});

// 2-min interval
setInterval(() => {
  if (_isWatchdogOwner()) _pollGrafanaUptime();
  else _pollDriveUptime();
}, 120_000);
// ════════════════════════════════════════════════════════════════════════════

// Initialize the stable machine ID, then restore watchdog and kick off Drive sync.
// All ownership checks depend on _machineId so nothing runs until it's loaded.
chrome.storage.local.get(["watchdog_machine_id"], (res) => {
  if (chrome.runtime.lastError) {
    _log("⚠️ [INIT] storage.get error:", chrome.runtime.lastError.message);
    return;
  }
  let { watchdog_machine_id } = res ?? {};
  if (!watchdog_machine_id) {
    watchdog_machine_id = "mach_" + crypto.randomUUID().slice(0, 8);
    chrome.storage.local.set({ watchdog_machine_id });
  }
  _machineId = watchdog_machine_id;

  // Restore IP and watchdog state. IP is written by dashboard.js via WebRTC detection
  // and persisted here so the watchdog survives service worker restarts without a tab open.
  chrome.storage.local.get(["machine_ip", "watchdog_state"], (res2) => {
    _machineIp = (res2 ?? {}).machine_ip ?? null;
    _log(`🖥️ Machine IP: ${_machineIp ?? "unknown"}`);
    const watchdog_state = (res2 ?? {}).watchdog_state;
    if (watchdog_state?.enabled && _isWatchdogOwner()) _startWatchdog();
    _drivePoll(); // immediate check on every SW wake-up
  });
});

// Create alarm only if it doesn't exist — prevents the timer from resetting
// every time the SW wakes up (which would prevent it from ever firing)
chrome.alarms.get("watchdogDriveSync", (existing) => {
  if (!existing) chrome.alarms.create("watchdogDriveSync", { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener(alarm => {
  // _machineId is always set before any alarm fires (alarms fire ≥1 min after SW start)
  if (alarm.name === "watchdogDriveSync") {
    _drivePoll();
    _scheduleMobileSnapshot();
  }
});

// React instantly when any dashboard tab writes a new watchdog state.
// Only the owning machine starts the interval — other machines update UI only.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.watchdog_state) return;
  const newState = changes.watchdog_state.newValue;
  const enabled = !!newState?.enabled;
  if (enabled && _isWatchdogOwner() && !_watchdogInterval) _startWatchdog();
  else if (!enabled && _watchdogInterval) _stopWatchdog();
});

// Inject a browser User-Agent into requests to rss.xcancel.com so the RSS
// endpoint doesn't 400 them. declarativeNetRequest operates at network level
// and can set headers forbidden to the Fetch API (like User-Agent).
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [9001],
  addRules: [{
    id: 9001,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "User-Agent",
          operation: "set",
          value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      ],
    },
    condition: {
      urlFilter: "https://rss.xcancel.com/*",
      resourceTypes: ["xmlhttprequest", "other"],
    },
  }],
});

// AUTO WS RECOVERY
let lastReloadTime = 0;
const RELOAD_COOLDOWN = 300000; // 5 minutes

// Open options page automatically on first install (credentials not yet configured).
chrome.storage.local.get(["SA_EMAIL", "SA_KEY", "SLACK_TOKEN"], (s) => {
  if (!s.SA_EMAIL || !s.SA_KEY || !s.SLACK_TOKEN) {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  }
});

setInterval(() => {
  const now = Date.now();
  const delta = now - lastWsMessage;

  if (delta < 30000) return;

  chrome.tabs.query({}, (tabs) => {
    const hmiTab = tabs.find((t) => t.url && t.url.includes("/internal/hmi/"));
    if (!hmiTab) return;

    if (now - lastReloadTime < RELOAD_COOLDOWN) {
      // Reload on cooldown — try hook re-injection as a lighter-weight attempt.
      // Re-injection only works if the WS dropped and reconnected after the hook;
      // existing connections are not affected, so this is a best-effort fallback.
      console.warn(
        "⚠️ WS stale — reload on cooldown, attempting hook re-injection",
      );
      injectedTabs.delete(hmiTab.id);
      injectWSHook(hmiTab.id);
      return;
    }

    // Not in cooldown — skip injection and reload immediately.
    // Re-injection cannot intercept an already-open WebSocket; a full page reload
    // is the only reliable way to get the hook onto a fresh connection.
    console.warn("🔥 WS stale → silent reload (first attempt)");
    lastReloadTime = now;
    injectedTabs.delete(hmiTab.id);
    chrome.tabs.reload(hmiTab.id, { bypassCache: true });
  });
}, 15000);
