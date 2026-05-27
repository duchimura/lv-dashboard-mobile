# Mobile Operations Status App — Design

**Date:** 2026-05-27
**Status:** Approved

## Overview

A read-only mobile web app that displays a condensed version of the Operations Status Board. The Chrome extension writes a live JSON snapshot to a publicly shared Google Drive file every 15 seconds. The mobile app fetches that file from any phone browser — no login, no app store, no cost.

---

## Architecture

```
background.js (running on dedicated PC)
  └─ every 15s: drive-sync.js writeVesselState()
       └─ writes vessel_state.json → Google Drive (shared folder)
                                             │
                                 public "anyone with link" URL
                                             │
                              phone browser fetches every 15s
                              (cache-busted with ?ts= timestamp)
                                             │
                                   mobile-app/index.html
                                   (hosted free on GitHub Pages)
```

**Key constraint:** M-bubble state depends on real-time angle-delta tracking and timers that only the running extension can compute. All three bubble states (`mBubble`, `tBubble`, `bBubble`) are pre-computed by `background.js` and written directly into the JSON — the mobile app renders them without any logic duplication.

---

## Data Schema — `vessel_state.json`

Written to Google Drive every 15 seconds by `background.js`.

```json
{
  "updated": "2026-05-27T10:30:00Z",
  "fleet": {
    "running": 35,
    "off": 2,
    "stopped": 1,
    "fault": 1,
    "issues": 3
  },
  "vessels": [
    {
      "id": "001A",
      "rack": 1,
      "slot": "A",
      "status": "running",
      "mBubble": "on",
      "tBubble": "on",
      "bBubble": "on",
      "temp": 145.2,
      "airflow": 12.5,
      "pressure": 0.18,
      "issues": ["motor"],
      "paused": false
    }
  ],
  "watchdog": { "enabled": true }
}
```

**Units:** `temp` is the average of the three probe readings, in °F · `airflow` in l/m · `pressure` in kPa

**Bubble states** (identical to dashboard CSS classes):
- `mBubble`: `"on"` | `"off"` | `"stopped"` | `"fault"`
- `tBubble`: `"on"` | `"off"` | `"error"`
- `bBubble`: `"on"` | `"off"` | `"stopped"`

**Status values:** `"running"` | `"off"` | `"stopped"` | `"fault"`

**Issues values** (array of zero or more): `"motor"` | `"temp"` | `"airflow"` | `"pressure"` | `"probe"`

---

## Phone UI

### Main Grid View

- **Header:** "Operations" title + live indicator (green dot + "Xs ago" staleness clock)
- **Fleet summary bar:** Running / Issues / Fault / Off counts
- **Scrollable rack sections:** rack label ("Rack 1", "Rack 2"…) above a 3-column vessel card grid
- **Each vessel card:**
  - Vessel ID (e.g., `001A`)
  - Three 18px bubbles: **M** / **T** / **B** — exact dashboard colors (`#0f0` on, `#777` off, `#c00` stopped/error, `#ff8800` fault)
  - Telemetry values: temp (°F) · airflow (l/m) · pressure (kPa)
  - Card border and background tint to red (`#c00`) or orange (`#ff8800`) reflecting the worst active bubble state
  - Off vessels dimmed (reduced opacity, all bubbles gray, dashes for values)
- **Stale data banner:** if `updated` is > 2 minutes old, a yellow full-width banner: "Data may be stale — last update X min ago"

### Detail View (tap any card)

- Back button + vessel ID header + overall status badge (RUNNING / OFF / STOPPED / FAULT)
- Three bubbles with text labels below: Motor · Temp Ctrl · Blower
- Telemetry rows: Avg Temp · Airflow · Pressure
- Active issues list (empty if none)
- Footer: watchdog enabled/disabled · rack paused/active

### States

| Condition | UI |
|---|---|
| File not yet written | "Waiting for data…" centered message |
| Fetch fails (network error) | "Unable to reach data source" with last-known data preserved |
| `updated` > 2 min old | Yellow stale banner, data still shown |
| All vessels OK | All bubbles green, no card highlighting |

---

## Files Changed / Created

### Existing extension

| File | Change |
|---|---|
| `drive-sync.js` | Add `writeVesselState(payload)` — writes `vessel_state.json` to the same Drive folder as `watchdog_sync.json` using the existing service account JWT |
| `background.js` | On each render cycle, pre-compute bubble states for all vessels and call `writeVesselState()`, debounced to max once every 15 seconds |

### New: `mobile-app/` folder

| File | Description |
|---|---|
| `index.html` | App shell — loads `config.js`, `app.css`, `app.js` |
| `app.css` | Dark theme styles matching dashboard palette |
| `app.js` | Fetch loop (every 15s), grid render, detail view, stale detection |
| `config.js` | `const VESSEL_STATE_FILE_ID = "…"` — set once after Drive setup |

The `mobile-app/` folder is deployed as a GitHub Pages site (or any free static host).

---

## Fetch Strategy

The mobile app fetches the public Drive file using the direct download URL:

```
https://drive.google.com/uc?export=download&id=FILE_ID&ts=TIMESTAMP
```

`ts` is the current Unix timestamp appended as a cache-buster so the browser does not serve a stale cached copy. No API key or authentication required — file must be shared "Anyone with the link can view."

---

## One-Time Setup

1. Deploy the updated extension — `background.js` begins writing `vessel_state.json` to Drive automatically.
2. In Google Drive, find `vessel_state.json` in the shared folder.
3. Share it: **Anyone with the link → Viewer**.
4. Copy the file ID from the share URL (the long alphanumeric string between `/d/` and `/view`).
5. Paste the file ID into `mobile-app/config.js`.
6. Push `mobile-app/` to a GitHub repo and enable GitHub Pages.
7. Share the Pages URL with users — open in any phone browser, optionally "Add to Home Screen."

> **Note:** Google Workspace may restrict public sharing on Shared Drives by default. A Workspace admin may need to allow "Anyone with the link" sharing for this specific file or folder before step 3 will work.

---

## Constraints & Edge Cases

- **Extension PC offline:** `updated` timestamp goes stale → yellow banner after 2 min. Previously fetched data stays on screen.
- **Drive CORS:** Google Drive's `uc?export=download` URL supports CORS for public files. Verified approach — no proxy needed.
- **First load before first write:** `vessel_state.json` does not exist yet → fetch 404 → "Waiting for data…" state shown.
- **No controls:** The app is strictly read-only. No setpoint controls, no rack pause — those remain desktop-only.
