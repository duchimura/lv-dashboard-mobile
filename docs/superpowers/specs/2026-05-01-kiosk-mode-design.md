# Kiosk Mode Design

**Date:** 2026-05-01  
**Status:** Approved

## Overview

Add a display-only kiosk mode to the Operations Status Board. The kiosk auto-cycles between the normal vessel grid and the issues-only grid every 10 seconds, using a randomly chosen transition animation each cycle. All interactive controls are hidden. Kiosk mode is delivered as a separate Chrome extension (a thin launcher) that opens a `kiosk.html` page hosted inside the existing extension.

## Files

### Existing extension (same directory — single source of truth for dashboard logic)

| File | Change |
|---|---|
| `kiosk.html` | New — copy of `dashboard.html` with `<script>window.KIOSK_MODE = true;</script>` added to `<head>` before `dashboard.js` loads |
| `dashboard.js` | Append a self-contained kiosk block at the bottom; runs only when `window.KIOSK_MODE === true` |
| `dashboard.css` | Append `.kiosk-mode` CSS rules that hide all buttons, inputs, search fields, drag handles, dialogs, and the debug overlay |
| `manifest.json` | Add `kiosk.html` to `web_accessible_resources` so the launcher extension can open it |

### Kiosk launcher extension (`kiosk/` subfolder — separate Chrome extension)

| File | Description |
|---|---|
| `kiosk/manifest.json` | MV3 manifest; name "Kiosk Display"; action points to `popup.html` |
| `kiosk/popup.html` | Single button: "Open Kiosk Display" |
| `kiosk/popup.js` | Reads `MAIN_EXTENSION_ID` from `config.js`, opens `chrome-extension://[ID]/kiosk.html` in a maximized window, then closes the popup |
| `kiosk/config.js` | `const MAIN_EXTENSION_ID = "…";` — the only place to update when the main extension ID changes |

## Kiosk block in `dashboard.js`

The kiosk block is appended at the bottom of `dashboard.js` and is entirely guarded by `if (window.KIOSK_MODE !== true) { /* skip */ }` so it has zero effect on the normal dashboard.

```
const KIOSK_CYCLE_MS = 10_000;  // ← adjust view duration here
```

### View cycling

- Alternates between normal grid view and issues-only view by toggling `issuesModeActive` and calling the existing `applyIssuesFilter()` — no new state, no new render path.
- A `setInterval` fires every `KIOSK_CYCLE_MS`.

### Transition animations

Before each view switch the kiosk block:
1. Picks a random animation name from a fixed pool: `fade`, `slide-left`, `slide-right`, `slide-up`, `slide-down`, `zoom`
2. Applies an "out" CSS animation to `#grid-wrapper` (opacity/transform to hide)
3. After the animation completes (~400 ms), switches the view
4. Applies an "in" CSS animation to `#grid-wrapper` (opacity/transform to reveal)

Animation keyframes are defined in `dashboard.css` under `.kiosk-mode` scope so they never affect the normal dashboard.

## Kiosk CSS in `dashboard.css`

`.kiosk-mode` hides:
- `#top-bar` (all show/hide buttons, vessel search, rack controls, issues toggle, zoom/theme toggles)
- `#header-drag-handle`
- `#issues-filter-bar`
- `#debug-toggle`, `#debug-overlay`
- `#pause-rack-dialog`
- `.column-pause-btn`

The fixed header title row (logo, title, heartbeat, last-updated) and the bottom legend/sparkline strip remain visible — they provide useful at-a-glance context on a display screen.

## Setup steps (one-time)

1. Load the existing extension from its root directory in `chrome://extensions` (already done).
2. Copy the extension ID shown on its card.
3. Paste it into `kiosk/config.js`.
4. Load the `kiosk/` subfolder as a second unpacked extension.
5. Click the kiosk extension icon → "Open Kiosk Display" to launch.
