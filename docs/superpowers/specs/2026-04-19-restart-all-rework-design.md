# Restart All Rework — Design Spec
**Date:** 2026-04-19

## Problem

The "Restart All" button sends setpoints in the wrong order (blower before motor), does not await confirmation before moving between slots, has no fault-aware skipping logic, and runs slot sequences as fire-and-forget IIFEs that cannot be tracked or reported on.

---

## Goals

1. Fix setpoint ordering: motor → blower → temp-ctrl → temp setpoint
2. Make `sequenceSetpoints` return a real `Promise` so callers can await it
3. Run all occupied slots in parallel via `Promise.all` (most efficient — motor spin-up happens concurrently)
4. Add per-slot fault detection to skip setpoints the hardware cannot accept
5. Add confirmation polling for motor and blower (mirrors existing temp-ctrl confirmation)
6. Give up after a fixed number of failed confirmation attempts — do not retry indefinitely
7. Report a per-slot summary toast when the full batch completes

---

## Fault Skipping Logic

Evaluated once per slot before any setpoints are sent.

| Fault condition | Motor | Blower | Temp |
|---|---|---|---|
| No faults | ✓ send | ✓ send | ✓ send |
| `tempModuleStatus === "temp_span_mitg"` | ✓ send | ✓ send | ✗ skip |
| `mechanicalStatus` contains `"ctrl_inactive"` (with or without `valve_fault`) | ✗ skip | ✓ send | ✗ skip |

**Field sources:**
- `temp_span_mitg` → `v.tempModuleStatus` (case-insensitive match)
- `ctrl_inactive` → `v.mechanicalStatus` (case-insensitive contains)
- `valve_fault` → `v.valveModuleStatus === "VALVE_FAULT"` (already used in the codebase)

If all three setpoints are skipped for a slot, the slot is recorded as `"skipped (all faults)"` in the summary and no messages are sent.

---

## Setpoint Sequence Per Slot

```
1. Evaluate faults → determine which of motor / blower / temp to send
2. If motor needed:
     send("motor", SP_DEFAULTS.motor)
     waitFor(isMotorRunning, interval=1s, timeout=20s)
     if not confirmed → log warning, mark motor as "timeout", continue
     ensure motor has been running ≥ 10 s (existing stabilization logic)
3. If blower needed:
     send("blower", SP_DEFAULTS.blower)
     waitFor(isBlowerRunning, interval=1s, timeout=10s)
     if not confirmed → log warning, mark blower as "timeout", continue
4. If temp needed AND motor confirmed (or already running):
     retry up to 3×:
       send("temp-ctrl", 1)
       waitFor(isTempControlOn, interval=1s, timeout=6s)
     if still not confirmed → abort temp setpoint, mark as "temp-ctrl failed"
     else:
       wait 300 ms
       send("temp", lastKnownTempSp ?? SP_DEFAULTS.temp)
5. Return { slot, motorOk, blowerOk, tempOk, skipped[], warnings[] }
```

Motor is sent **before** blower so the hardware has maximum spin-up time before the temp control switch is engaged.

---

## `sequenceSetpoints` Refactor

**Current:** Internal `(async () => { ... })()` IIFE — fire-and-forget, no return value.

**New:** The function signature stays the same but the body becomes a top-level `async` function body (remove the IIFE wrapper) and returns `Promise<SlotResult>`. All existing sequencing logic (motor waitFor, 10 s stabilization, temp-ctrl retry loop) is preserved — only the ordering and the blower confirmation step change.

Callers that currently call `sequenceSetpoints(...)` and discard the result continue to work unchanged. `restartAllRacks` is the only caller that awaits the result.

---

## `restartAllRacks` Changes

```
1. Collect occupied slots (existing logic — all slots with a vessel)
2. Show "evaluating N slots…" toast
3. results = await Promise.all(occupied.map(slot => sequenceSetpoints(...)))
4. Build summary string from results:
     "✓ 5 started | ⚠ 2 timeouts (001A motor, 002C blower) | ✗ 1 skipped (003B ctrl_inactive)"
5. Show summary toast
6. Re-enable button, hide stop button
```

The abort flag (`_restartAllAborted`) is checked at the start of each slot's sequence so the stop button still works.

---

## Confirmation Timeouts

| Setpoint | Poll interval | Max wait | Behavior on timeout |
|---|---|---|---|
| Motor | 1 s | 20 s | Log warning, continue to blower |
| Blower | 1 s | 10 s | Log warning, continue |
| Temp-ctrl ON | 1 s | 6 s × 3 retries | Abort temp setpoint for this slot |

These match the existing motor/temp-ctrl values and add blower confirmation on the same pattern.

---

## Files Changed

- **`dashboard.js`** — `sequenceSetpoints` (refactor + ordering fix + blower confirmation), `restartAllRacks` (Promise.all, fault detection, summary toast)
- No changes to `background.js`, `content.js`, or any other file

---

## Out of Scope

- Retry loops that revisit failed slots (user confirmed: move on after max attempts)
- Any changes to the single-slot popup flow
- Changes to pause-all or any other bulk action
