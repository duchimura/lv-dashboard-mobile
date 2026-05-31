# Pause All / Restart All — Empty Slot A Support

**Date:** 2026-05-31

## Background

The existing `pause-all-racks` handler clicks the rack group footer toggle button in the HMI hall view. That button only renders when slot A is occupied. When slot A is empty, the footer button is absent and the current logic silently does nothing for that rack group, leaving occupied B and C slots running.

`restartAllRacks()` sends WS setpoints for all occupied slots. It does not handle slots that were park-stopped (vs rack-paused), so park-stopped motors remain parked after restart all fires.

## Goals

1. Pause All: park-stop occupied B/C slots when slot A is empty.
2. Restart All: resume park-stopped slots via WS setpoints + v2 reset button fallback.
3. All DOM automation runs via silent background tabs (`active: false`) — no focus steal, no tab switch.
4. Watchdog is disabled before any pause-all work begins (already implemented).
5. Any PC running the extension can trigger pause/restart all — no kiosk routing needed.

## Design

### Pause All — Enhanced Flow

`pause-all-racks` handler in `background.js`:

1. Disable watchdog (unchanged).
2. Query HMI tab (unchanged).
3. Group `dashboardState` slots by rack number (first 3 chars of slot name).
4. For each rack group:
   - If the A slot (`<rack>A`) has a vessel → click the existing hall-view footer button via `executeScript` on the HMI tab (unchanged path).
   - If the A slot is empty → for each occupied non-A slot in that rack (B, C, etc.):
     - Call new helper `_parkStopSlotV2(slotName, vesselId)`.
5. Await all per-rack operations, then call `syncRackPauseState` (unchanged).

#### New helper: `_parkStopSlotV2(slotName, vesselId)`

Located in `background.js`. Mirrors the structure of `_checkV2SlotCardReset` with inverted click condition:

- Opens `chrome.tabs.create({ url: /v2/vessels/<vesselId>/details, active: false })`.
- Polls up to 30 × 500 ms for the button selector to appear.
- If button label includes "park" → **click it** (motor is running; park it).
- If button is absent or already stopped → log and skip.
- Closes tab in `finally`.
- Returns `"parked"` | `"already-stopped"` | `"not-found"`.

Button selector (same as `_checkV2SlotCardReset`):
```
div.vessel-details__content > div:nth-child(3) >
div:nth-child(10) > div:nth-child(3) > div > button
```

### Restart All — Enhanced Flow (Option C)

`restartAllRacks()` in `dashboard.js`:

**Phase 1 (immediate — unchanged):** Send WS setpoints (motor, blower, temp) for all occupied slots. `wasUserPaused` logic and skipping rules are unchanged.

**Phase 2 (fallback, fires ~7 s after Phase 1):** For each occupied slot where:
- Slot A of that rack is still empty in live `state`, AND
- The slot is still `ctrl_inactive` (motor has not recovered from Phase 1 setpoints),

Send a `reset-slot-v2` message to `background.js` with `{ slotName, vesselId }`.

#### New message handler: `reset-slot-v2`

In `background.js`:

- Opens silent tab to `/v2/vessels/<vesselId>/details`.
- Polls for the button.
- If button label does **not** include "park" and button is not disabled → click it (reset state — motor is stopped/parked, ready to reset).
- Closes tab.
- Responds `{ ok: true | false }`.

This reuses the existing `_checkV2SlotCardReset` logic (which already clicks in this condition) — the handler can call it directly.

## Files Changed

| File | Change |
|------|--------|
| `background.js` | Add `_parkStopSlotV2()` helper; enhance `pause-all-racks` handler to branch on slot A occupancy; add `reset-slot-v2` message handler |
| `dashboard.js` | Add Phase 2 fallback in `restartAllRacks()` — detect park-stopped slots and send `reset-slot-v2` messages after a delay |

## Non-Goals

- No Drive sync / kiosk routing (any PC handles it directly via silent tabs).
- No persistent state tracking of which slots were park-stopped (live `dashboardState` is sufficient).
- No changes to the watchdog disable/enable flow.
- No changes to the existing hall-view footer button path for slot-A-occupied racks.
