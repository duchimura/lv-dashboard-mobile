/**
 * Rack Remote Control — Google Apps Script Web App
 *
 * Deploy once in Google Workspace:
 *   Extensions → Apps Script → Deploy → New deployment
 *   Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone in [your organization]
 *
 * ── Bookmarklet (dialog, no popup window) ───────────────────────────────────
 * After deploying, replace https://script.google.com/a/macros/earthfuneral.com/s/AKfycbwkXELO2BnjdiMyMxVTm6rI3gnu66QMZjvazlgOBS0YX2uA3FxWFS8dA4RYYjUacHc_/exec with your /exec URL and save as a
 * browser bookmark. One click injects a floating dialog into the current page.
 * Click the × or outside the box to dismiss. Click again to toggle it closed.
 *
 *   javascript:(function(){var id='_wdDlg';var ex=document.getElementById(id);if(ex){ex.remove();return;}var ov=document.createElement('div');ov.id=id;ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';var box=document.createElement('div');box.style.cssText='background:#0f172a;border-radius:12px;overflow:hidden;box-shadow:0 25px 50px rgba(0,0,0,.6);width:420px;max-width:95vw;';var bar=document.createElement('div');bar.style.cssText='background:#1e293b;padding:8px 14px;display:flex;justify-content:space-between;align-items:center;';var ttl=document.createElement('span');ttl.style.cssText='color:#f1f5f9;font-size:13px;font-weight:600;';ttl.textContent='🏭 Rack Remote Control';var cls=document.createElement('button');cls.style.cssText='background:none;border:none;color:#94a3b8;font-size:20px;line-height:1;cursor:pointer;padding:0 2px;';cls.textContent='×';cls.onclick=function(){ov.remove();};bar.appendChild(ttl);bar.appendChild(cls);var frm=document.createElement('iframe');frm.src='https://script.google.com/a/macros/earthfuneral.com/s/AKfycbwkXELO2BnjdiMyMxVTm6rI3gnu66QMZjvazlgOBS0YX2uA3FxWFS8dA4RYYjUacHc_/exec';frm.style.cssText='border:none;width:100%;height:300px;display:block;';box.appendChild(bar);box.appendChild(frm);ov.appendChild(box);ov.addEventListener('click',function(e){if(e.target===ov)ov.remove();});document.body.appendChild(ov);})();
 *
 * ── Also paste the URL into REMOTE_CONTROL_URL in mobile-app/config.js ──────
 *
 * How it works:
 *   Pause All  → WATCHDOG OFF + writes pendingCommand:"pause_all" to Drive.
 *                Kiosk reads this on its 1-min Drive alarm, disables watchdog,
 *                and park-stops all occupied racks.
 *   Restart All → WATCHDOG ON + writes pendingCommand:"restart_all" to Drive.
 *                Kiosk re-enables the watchdog; it restarts stopped motors
 *                automatically on its next tick (within 2 minutes).
 *
 * Commands older than 10 minutes are silently ignored (stale protection).
 */

// ID of the shared Drive folder containing watchdog_sync.json
var FOLDER_ID = "1s5zwq7MIZ5AaqmNQzkx66jIbMcVuEvax";
var SYNC_FILE  = "watchdog_sync.json";

// ─── Helpers ────────────────────────────────────────────────────────────────

function _getFile() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files  = folder.getFilesByName(SYNC_FILE);
  if (!files.hasNext()) throw new Error(SYNC_FILE + " not found in folder");
  return files.next();
}

function _readState() {
  return JSON.parse(_getFile().getBlob().getDataAsString());
}

function _writeState(state) {
  _getFile().setContent(JSON.stringify(state));
}

// ─── Web App Handlers ────────────────────────────────────────────────────────

function doGet(e) {
  // Mobile app sends GET ?action=pause_all|restart_all to avoid the CORS/redirect
  // issue that Apps Script POST triggers when called cross-origin from a PWA.
  var action = e && e.parameter && e.parameter.action;
  if (action === "pause_all" || action === "restart_all") {
    return _handleAction(action);
  }

  var state;
  var error = null;
  try {
    state = _readState();
  } catch (err) {
    error = err.message;
  }

  var watchdogOn      = state && state.enabled;
  var pending         = state && state.pendingCommand;
  var pendingAge      = pending ? Math.round((Date.now() - (state.commandIssuedAt || 0)) / 1000) : 0;
  var changedBy       = state ? (state.changedBy || "—") : "—";

  // Badge: bright bg needs dark text; dark/red bg keeps white text.
  var statusBg        = watchdogOn ? "#22c55e" : "#ef4444";
  var statusFg        = watchdogOn ? "#052e16"  : "#fff";
  var statusLabel     = watchdogOn ? "ENABLED"  : "DISABLED";

  var pendingHtml = "";
  if (pending) {
    var cmdLabel = pending === "pause_all" ? "Pause All" : "Restart All";
    pendingHtml = '<p class="pending">⏳ "' + cmdLabel + '" sent — kiosk executing within 1 min (age: ' + pendingAge + 's)</p>';
  }

  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Rack Control</title>' +
    '<style>' +
    'body{font-family:system-ui,sans-serif;margin:0;padding:20px;background:#0f172a;color:#f1f5f9;max-width:420px;}' +
    'h1{font-size:1.1rem;margin:0 0 16px;}' +
    '.status{font-size:.85rem;color:#94a3b8;margin-bottom:20px;}' +
    '.badge{display:inline-block;padding:3px 10px;border-radius:9999px;font-weight:700;font-size:.85rem;' +
      'background:' + statusBg + ';color:' + statusFg + ';}' +
    '.btns{display:flex;gap:10px;margin-top:4px;}' +
    'button{flex:1;padding:12px;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;transition:opacity .15s;}' +
    'button:active{opacity:.75;}' +
    '#btnPause{background:#f59e0b;color:#000;}' +
    '#btnRestart{background:#22c55e;color:#052e16;}' +
    '#msg{margin-top:14px;font-size:.85rem;min-height:18px;color:#94a3b8;}' +
    '.pending{background:#1e293b;border-left:3px solid #f59e0b;padding:8px 12px;font-size:.8rem;border-radius:4px;margin-top:12px;}' +
    'p{margin:0;}' +
    '</style></head><body>' +
    '<h1>🏭 Rack Remote Control</h1>' +
    '<p class="status">Watchdog: <span class="badge">' + statusLabel + '</span>' +
    (state ? '&nbsp;&nbsp;last change by <em>' + changedBy + '</em>' : '') + '</p>' +
    pendingHtml +
    '<div class="btns">' +
    '<button id="btnPause" onclick="send(\'pause_all\')">⏸ Pause All</button>' +
    '<button id="btnRestart" onclick="send(\'restart_all\')">▶ Restart All</button>' +
    '</div>' +
    '<p id="msg"></p>' +
    (error ? '<p style="color:#f87171;font-size:.8rem;margin-top:12px;">⚠ ' + error + '</p>' : '') +
    '<script>' +
    'function send(action){' +
    '  document.getElementById("msg").textContent="Sending…";' +
    '  var f=new FormData();f.append("action",action);' +
    '  fetch(location.href,{method:"POST",body:f})' +
    '  .then(function(r){return r.json();})' +
    '  .then(function(d){' +
    '    document.getElementById("msg").textContent=d.ok' +
    '      ?"✅ "+d.message' +
    '      :"❌ "+(d.error||"Unknown error");' +
    '    if(d.ok)setTimeout(function(){location.reload();},2500);' +
    '  })' +
    '  .catch(function(e){document.getElementById("msg").textContent="❌ Network error: "+e.message;});' +
    '}' +
    '<\/script>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle("Rack Remote Control")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action !== "pause_all" && action !== "restart_all") {
    return _json({ ok: false, error: "Unknown action: " + action });
  }
  return _handleAction(action);
}

// Shared handler — called by both doGet (mobile app) and doPost (bookmarklet iframe).
function _handleAction(action) {
  try {
    var state = _readState();
    var now   = Date.now();
    state.pendingCommand    = action;
    state.commandIssuedAt   = now;
    state.changedAt         = now;  // must bump so kiosk's early-exit guard doesn't skip it
    state.changedBy         = "remote-control";
    _writeState(state);

    var label = action === "pause_all" ? "Pause All" : "Restart All";
    return _json({ ok: true, message: '"' + label + '" sent — kiosk will execute within ~1 minute.' });
  } catch (err) {
    return _json({ ok: false, error: err.message });
  }
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
