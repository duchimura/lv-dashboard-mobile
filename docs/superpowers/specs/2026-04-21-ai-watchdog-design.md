# AI Watchdog — Design Spec
**Date:** 2026-04-21
**Status:** Approved for implementation

---

## Context

The dashboard currently requires a human to notice equipment faults and manually trigger recovery (via the popup setpoint editor or Restart All). The goal of this feature is to make fault recovery proactive — the system continuously watches telemetry and acts automatically, so 39 vessels can run through their full process with little to no human intervention. The only exception is when a rack or column is deliberately paused for service, maintenance, or testing.

This is purely rules-based automation — no LLM involved. It extends the proven sequenced-setpoint logic already used by `restartAllRacks` and `sequenceSetpoints`.

---

## Scope

The watchdog handles exactly three fault conditions:

| Fault | Detection | Recovery action |
|-------|-----------|-----------------|
| Motor stalled | `mixerModuleStatus` shows stopped + `setpoints.motorSp > 0` | Send motor setpoint (existing `sendWsSetpoint` sequence) |
| Blower stopped | `telemetry.airflow < 30` l/min + `setpoints.airflowSp > 0` (same threshold as attention list) | Send airflow setpoint |
| Temp control OFF | `telemetry.heater_control_active === false` + `setpoints.tempSp > 0` | Re-enable temp control + resend temp setpoint |

High pressure, low airflow, and probe delta alarms are **out of scope** — those remain manual attention-list items.

---

## Architecture

### Watchdog Loop (`background.js`)

A new `startWatchdog()` function runs on a configurable interval (default: 30 seconds) using `setInterval`. It lives entirely in `background.js` alongside the existing control logic.

**Per-tick logic:**
1. Iterate all slots in `dashboardState`
2. **Skip** if: `rackGroupPaused === true`, no vessel present, `mechanicalStatus === "ctrl_inactive"`
3. For each eligible slot, check the three fault conditions
4. If a fault is detected and the slot is not in cooldown: fire recovery using existing `sendWsSetpoint` sequence
5. If recovery succeeds: write to audit log, stamp card with AI action timestamp
6. If recovery fails after retries: write to audit log (failed), broadcast toast to dashboard, POST webhook

**Per-slot cooldown:** After any recovery attempt (successful or not), the slot is locked out for a configurable window (default: 5 minutes) to prevent hammering. Tracked in a `watchdogCooldowns` map keyed by `slotName`.

**Keep-alive:** The existing `chrome.runtime.connect` port mechanism already prevents service worker suspension. No additional changes needed.

### Configuration (`chrome.storage.local`)

```json
{
  "watchdog": {
    "enabled": true,
    "intervalSeconds": 30,
    "cooldownMinutes": 5,
    "webhook": {
      "enabled": true,
      "url": "https://hooks.slack.com/services/..."
    }
  }
}
```

### Audit Log (in-memory)

Capped array of 200 entries in `background.js`. Each entry:

```json
{
  "timestamp": "2026-04-21T15:14:51.000Z",
  "slotName": "007B",
  "vesselName": "Slot 007B",
  "fault": "temp_ctrl_off",
  "action": "re-enabled temp ctrl + sent 650°F",
  "outcome": "recovered",
  "webhookFired": false
}
```

`outcome` is either `"recovered"` or `"failed"`. On `"failed"`, `webhookFired` is `true` if the webhook call succeeded.

### Webhook Payload

POST to configured URL on unrecovered fault:

```json
{
  "event": "watchdog_recovery_failed",
  "timestamp": "2026-04-21T15:28:04.000Z",
  "facility": 2,
  "slot": "011C",
  "vessel": "Slot 011C",
  "fault": "blower_stopped",
  "attempts": 3,
  "message": "Slot 011C: blower recovery failed after 3 attempts — manual intervention required"
}
```

---

## Interface

### Header — AI Watchdog Section (inline, far right)

Added to the right end of the existing fixed header. Four states:

| State | Appearance |
|-------|-----------|
| Active, no faults | Green toggle ON · "● Active" · "0 faults" · Log (n) · ⚙ |
| Active, log has entries | Same, Log button highlighted blue with count |
| Unrecovered fault present | Red left border on AI section · "⚠ 1 unrecovered" · Log button red with `!` |
| Disabled | Toggle OFF · greyed out · "monitoring paused" |

Toggling the switch updates `watchdog.enabled` in `chrome.storage.local` and starts/stops the interval immediately.

### Audit Log Panel

Opens below the header when "Log (n)" is clicked. Closes on click-outside or ✕.

Columns: **Time · Slot · Vessel · Fault · Action · Result**

- Recovered rows: normal background, green "✓ recovered" result
- Failed rows: red background, red "⚠ FAILED · webhook sent" result
- Capped at 200 rows, newest first
- Clears on extension reload (in-memory only)

### Config Modal

Opens on ⚙ click. Fields:
- **Scan interval** — number input, seconds (default 30)
- **Recovery cooldown per slot** — number input, minutes (default 5)
- **Webhook enabled** — toggle
- **Webhook URL** — text input (visible only when webhook enabled)
- Save / Cancel buttons — Save writes to `chrome.storage.local` and restarts the interval

### Slot Card Indicator

When the watchdog acts on a slot, a small `⚡ AI Xm ago` label appears in the top-right of the card header. Behavior:
- Displays elapsed time since last AI action (e.g. "⚡ AI 4m ago"), updates each render tick
- Hover tooltip shows: fault type + action taken + outcome
- Fades/disappears after 30 minutes
- Failed recoveries show the label in red; successful recoveries in blue

---

## Interaction Summary

| Scenario | What happens |
|----------|-------------|
| Motor stalls on slot 007B | Watchdog detects on next tick, sends motor setpoint silently, logs "recovered", stamps "⚡ AI Xm ago" on card |
| Blower stops, recovery fails after retries | Logs "failed", dashboard toast fires (if open), webhook POSTs, card label turns red |
| Slot's rack is paused | Watchdog skips it entirely every tick |
| Operator disables watchdog | Flips toggle in header, interval clears immediately, header greys out |
| Operator checks history | Clicks "Log (n)" in header, audit log panel drops down |
| Operator changes webhook URL | Clicks ⚙, updates URL, saves — takes effect on next failure |

---

## Files to Modify

| File | Change |
|------|--------|
| `background.js` | Add `startWatchdog()`, `stopWatchdog()`, `watchdogCooldowns` map, `auditLog` array, webhook POST helper, config load/save helpers |
| `dashboard.js` | Add AI header section render, Log panel render, Config modal render, card indicator render in `updateCard()`, message handler for `watchdog:log` and `watchdog:status` |
| `dashboard.html` | Add audit log panel container, config modal container |
| `dashboard.css` | Styles for AI header section, log panel table, config modal, card `⚡` label |

---

## Verification

1. Load extension, open dashboard — AI Watchdog section appears at far right of header, toggle is ON
2. Disable watchdog via toggle — header greys out, interval stops (verify via background console log)
3. Re-enable — interval restarts
4. Simulate motor fault (set motor setpoint > 0, force `mixerModuleStatus` to stopped in test state) — watchdog fires recovery on next tick, card shows `⚡ AI Xm ago`, log entry appears
5. Simulate unrecovered fault (block `sendWsSetpoint` response) — toast appears on dashboard, webhook POSTs to configured URL, log shows red failed row, card label red
6. Pause a rack column — watchdog skips all three slots in that column on every tick
7. Open Config modal — change interval to 10s, save — next tick fires in ~10s
8. Open Log panel — rows display correctly, newest first, close on ✕
