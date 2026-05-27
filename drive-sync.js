// Cross-machine watchdog state sync via Google Drive (service account JWT auth).
// All extension instances read/write watchdog_sync.json in the shared Drive folder.
// Setpoint log writes to a Google Sheet with auto-filter; rows older than 72 h are purged.

let _saEmail = null;
let _saKey = null;

async function _loadCreds() {
  if (_saEmail && _saKey) return;
  const s = await new Promise(r => chrome.storage.local.get(["SA_EMAIL", "SA_KEY"], r));
  _saEmail = s.SA_EMAIL || null;
  _saKey   = s.SA_KEY   || null;
}
const FOLDER_ID = "1s5zwq7MIZ5AaqmNQzkx66jIbMcVuEvax";
const FILE_NAME = "watchdog_sync.json";
const SHEET_FILE_NAME = "Watchdog Setpoint Log";
const SHEET_HEADERS = ["Date", "Time", "Slot ID", "Vessel Number", "Setpoint Type", "Value", "Avg Temp / kPa", "Notes"];
const LOG_72H_MS = 72 * 60 * 60 * 1000;
const MOTOR_TAB_NAME = "Motor Audit Log";
const MOTOR_AUDIT_HEADERS = ["Date", "Time", "Slot ID", "Vessel Number", "Setpoint (R/hr)", "Step"];
const _STEP_LABELS = {
  "VALVE FAULT":   "Valve fault detected — motor setpoint sent after HMI fault clear",
  "MIXER FAULTED": "Mixer fault detected — motor setpoint sent after HMI fault clear",
  "v2 reset":      "HMI v2 fault reset performed — motor speed restored",
  "v1 rack reset": "HMI v1 rack reset — motor speed restored after repeated stall",
};
function _expandStepNote(note) {
  return _STEP_LABELS[note] ?? "Motor stopped — setpoint re-sent to resume rotation";
}

let _token = null;
let _tokenExpiry = 0;
let _fileId = null;
let _sheetFileId = null;
let _sheetTabId = null; // numeric tab ID used by batchUpdate
let _motorTabId = null; // numeric tab ID for the Motor Audit Log tab

function _b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function _b64urlBuf(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function _pemToBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

async function _getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  await _loadCreds();
  if (!_saEmail || !_saKey) throw new Error("Drive credentials not configured — open Extension Options to set up.");
  const now = Math.floor(Date.now() / 1000);
  const hdr = _b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const clm = _b64url(JSON.stringify({
    iss: _saEmail,
    scope: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));
  const unsigned = `${hdr}.${clm}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", _pemToBuffer(_saKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${_b64urlBuf(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  const j = await res.json();
  _token = j.access_token;
  _tokenExpiry = Date.now() + (j.expires_in - 60) * 1000;
  return _token;
}

async function _getFileId() {
  if (_fileId) return _fileId;
  const tok = await _getToken();
  const q = encodeURIComponent(`name='${FILE_NAME}' and '${FOLDER_ID}' in parents and trashed=false`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!res.ok) throw new Error(`files.list ${res.status}`);
  const j = await res.json();
  if (j.files?.length) {
    _fileId = j.files[0].id;
    return _fileId;
  }
  // File doesn't exist yet — create it with default state
  const boundary = "wdog_mp_boundary";
  const meta = JSON.stringify({ name: FILE_NAME, parents: [FOLDER_ID] });
  const body = JSON.stringify({ enabled: false, changedBy: "init", changedAt: 0 });
  const mp = [
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}`,
    `--${boundary}--`,
  ].join("\r\n");
  const cr = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: mp,
    }
  );
  if (!cr.ok) throw new Error(`files.create ${cr.status}`);
  const cj = await cr.json();
  _fileId = cj.id;
  return _fileId;
}

async function _getSheetFileId() {
  if (_sheetFileId) return _sheetFileId;
  const tok = await _getToken();
  const q = encodeURIComponent(
    `name='${SHEET_FILE_NAME}' and '${FOLDER_ID}' in parents and trashed=false`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!res.ok) throw new Error(`sheet files.list ${res.status}`);
  const j = await res.json();
  if (j.files?.length) {
    _sheetFileId = j.files[0].id;
    await _ensureSheetTabId(_sheetFileId, tok);
    await _ensureMotorAuditTab(_sheetFileId, tok);
    return _sheetFileId;
  }
  // Create a new Google Sheet in the shared folder
  const cr = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: SHEET_FILE_NAME,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [FOLDER_ID],
      }),
    }
  );
  if (!cr.ok) throw new Error(`sheet create ${cr.status}`);
  const cj = await cr.json();
  _sheetFileId = cj.id;
  await _initSheet(_sheetFileId, tok);
  await _ensureMotorAuditTab(_sheetFileId, tok);
  return _sheetFileId;
}

async function _ensureSheetTabId(fileId, tok) {
  if (_sheetTabId != null) return;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!res.ok) throw new Error(`sheet meta ${res.status}`);
  const j = await res.json();
  _sheetTabId = j.sheets[0].properties.sheetId;
}

async function _initSheet(fileId, tok) {
  await _ensureSheetTabId(fileId, tok);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            updateCells: {
              rows: [{ values: SHEET_HEADERS.map(h => ({ userEnteredValue: { stringValue: h } })) }],
              fields: "userEnteredValue",
              start: { sheetId: _sheetTabId, rowIndex: 0, columnIndex: 0 },
            },
          },
          {
            setBasicFilter: {
              filter: {
                range: {
                  sheetId: _sheetTabId,
                  startRowIndex: 0,
                  startColumnIndex: 0,
                  endColumnIndex: SHEET_HEADERS.length,
                },
              },
            },
          },
        ],
      }),
    }
  );
  if (!res.ok) throw new Error(`sheet init ${res.status}`);
}

async function _ensureMotorAuditTab(fileId, tok) {
  if (_motorTabId != null) return;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!res.ok) throw new Error(`motor tab meta ${res.status}`);
  const j = await res.json();
  const existing = j.sheets.find(s => s.properties.title === MOTOR_TAB_NAME);
  if (existing) {
    _motorTabId = existing.properties.sheetId;
    return;
  }
  // Tab doesn't exist — create it
  const cr = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: MOTOR_TAB_NAME } } }] }),
    }
  );
  if (!cr.ok) throw new Error(`motor tab create ${cr.status}`);
  const cj = await cr.json();
  _motorTabId = cj.replies[0].addSheet.properties.sheetId;
  await _initMotorAuditTab(fileId, tok);
}

async function _initMotorAuditTab(fileId, tok) {
  await _loadCreds();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            updateCells: {
              rows: [{ values: MOTOR_AUDIT_HEADERS.map(h => ({ userEnteredValue: { stringValue: h } })) }],
              fields: "userEnteredValue",
              start: { sheetId: _motorTabId, rowIndex: 0, columnIndex: 0 },
            },
          },
          {
            setBasicFilter: {
              filter: {
                range: {
                  sheetId: _motorTabId,
                  startRowIndex: 0,
                  startColumnIndex: 0,
                  endColumnIndex: MOTOR_AUDIT_HEADERS.length,
                },
              },
            },
          },
        ],
      }),
    }
  );
  if (!res.ok) throw new Error(`motor tab init ${res.status}`);
}

async function _purgeOldRows(fileId, tok) {
  const cutoff = Date.now() - LOG_72H_MS;
  const readRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/A2:B?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!readRes.ok) return;
  const data = await readRes.json();
  const rows = data.values ?? [];

  // Collect 0-based data-row indices (excluding header) that are too old
  const oldIndices = [];
  for (let i = 0; i < rows.length; i++) {
    const [dateStr, timeStr] = rows[i];
    if (!dateStr || !timeStr) continue;
    const [m, d, y] = dateStr.split("/");
    const ts = new Date(`${y}-${m}-${d}T${timeStr}`).getTime();
    if (!isNaN(ts) && ts < cutoff) oldIndices.push(i);
  }
  if (!oldIndices.length) return;

  await _ensureSheetTabId(fileId, tok);

  // Group consecutive indices into ranges, then reverse so deletions don't shift remaining indices
  const ranges = [];
  let start = oldIndices[0], end = oldIndices[0];
  for (let i = 1; i < oldIndices.length; i++) {
    if (oldIndices[i] === end + 1) { end = oldIndices[i]; }
    else { ranges.push([start, end]); start = end = oldIndices[i]; }
  }
  ranges.push([start, end]);

  const requests = ranges.reverse().map(([s, e]) => ({
    deleteDimension: {
      range: {
        sheetId: _sheetTabId,
        dimension: "ROWS",
        startIndex: s + 1, // +1 to skip header row
        endIndex: e + 2,   // +1 for header, +1 for exclusive end
      },
    },
  }));

  const delRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    }
  );
  if (!delRes.ok) throw new Error(`sheet purge ${delRes.status}`);
}

// rows: array of { date, time, slotId, vesselNumber, value, note } — motor confirmed running only, no purge
export async function appendMotorAuditRows(rows) {
  if (!rows.length) return;
  const tok = await _getToken();
  const fileId = await _getSheetFileId();
  await _ensureMotorAuditTab(fileId, tok);

  const values = rows.map(r => [
    r.date,
    r.time,
    r.slotId,
    r.vesselNumber ?? "",
    r.value,
    _expandStepNote(r.note),
  ]);
  const appendRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(MOTOR_TAB_NAME)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  if (!appendRes.ok) throw new Error(`motor audit append ${appendRes.status}`);
}

// rows: array of { date, time, slotId, vesselNumber, spType, value }
export async function appendSetpointLogRows(rows) {
  if (!rows.length) return;
  const tok = await _getToken();
  const fileId = await _getSheetFileId();

  const values = rows.map(r => [r.date, r.time, r.slotId, r.vesselNumber ?? "", r.spType, r.value, r.envReading ?? "", r.note ?? ""]);
  const appendRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );
  if (!appendRes.ok) throw new Error(`sheet append ${appendRes.status}`);

  await _purgeOldRows(fileId, tok).catch(e => console.warn("⚠️ sheet purge failed:", e));
}

export async function readDriveState() {
  const tok = await _getToken();
  const id = await _getFileId();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!res.ok) throw new Error(`read ${res.status}`);
  return res.json();
}

export async function writeDriveState(state) {
  const tok = await _getToken();
  const id = await _getFileId();
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(state),
    }
  );
  if (!res.ok) throw new Error(`write ${res.status}`);
}

/* ── Vessel uptime sync (uptime_sync.json) ──────────────────────────────── */
const UPTIME_FILE_NAME = "uptime_sync.json";
let _uptimeFileId = null;

async function _getUptimeFileId() {
  if (_uptimeFileId) return _uptimeFileId;
  const tok = await _getToken();
  const q = encodeURIComponent(
    `name='${UPTIME_FILE_NAME}' and '${FOLDER_ID}' in parents and trashed=false`
  );
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!res.ok) throw new Error(`uptime list ${res.status}`);
  const j = await res.json();
  if (j.files?.length) { _uptimeFileId = j.files[0].id; return _uptimeFileId; }
  // File doesn't exist — create it with an empty object
  const boundary = "uptime_mp";
  const mp = [
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify({ name: UPTIME_FILE_NAME, parents: [FOLDER_ID] }),
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
  if (!cr.ok) throw new Error(`uptime create ${cr.status}`);
  _uptimeFileId = (await cr.json()).id;
  return _uptimeFileId;
}

export async function readUptimeState() {
  const tok = await _getToken();
  const id  = await _getUptimeFileId();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${tok}` } }
  );
  if (!res.ok) throw new Error(`uptime read ${res.status}`);
  return res.json();
}

export async function writeUptimeState(state) {
  const tok = await _getToken();
  const id  = await _getUptimeFileId();
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`,
    { method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(state) }
  );
  if (!res.ok) throw new Error(`uptime write ${res.status}`);
}
