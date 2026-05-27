# Restart All Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `restartAllRacks` to send setpoints in the correct order (motor → blower → temp), run slots in parallel with fault-aware skipping, and return a per-slot summary toast.

**Architecture:** `sequenceSetpoints` is converted from a fire-and-forget IIFE to a true `async` function returning `{ slot, warnings }`. `restartAllRacks` adds fault detection per slot and replaces the sequential `for` loop with `Promise.all`.

**Tech Stack:** Vanilla JS, Chrome Extension MV3, `dashboard.js` only.

---

### Task 1: Refactor `sequenceSetpoints` into a true async function

**Files:**
- Modify: `dashboard.js:1685–1815`

- [ ] **Step 1: Replace the function signature and remove the IIFE wrapper**

Find and replace the entire `sequenceSetpoints` function (lines 1685–1815) with the following. The `send`, `wait`, and `waitFor` helpers are unchanged. Key changes: function is now `async`, returns `{ slot, warnings }`, motor is sent **before** blower in the `needsCtrlOn` path, blower gets a `waitFor` confirmation, the non-sequenced else path also sends motor before blower.

```js
async function sequenceSetpoints(slot, sels, enableTempCtrl) {
  const warnings = [];
  const tempOn = isTempControlOn(slot);
  const motorRunning = isMotorRunning(slot);
  const needsCtrlOn = sels.temp !== null && tempOn !== true && enableTempCtrl;

  function send(spType, value) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "setpoint:set", slotName: slot, spType, value },
        (resp) => {
          if (chrome.runtime.lastError || !resp?.ok) {
            showSetpointToast(
              `Failed ${spType}: ${resp?.error || chrome.runtime.lastError?.message || "error"}`,
              true,
            );
          } else {
            showSetpointToast(`\u2713 ${slot} ${spType} \u2192 ${value}`);
          }
          resolve();
        },
      );
    });
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitFor(condFn, intervalMs, timeoutMs) {
    return new Promise((resolve) => {
      if (condFn()) {
        resolve(true);
        return;
      }
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (condFn()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          resolve(false);
        }
      }, intervalMs);
    });
  }

  _log(
    `[sequenceSetpoints] ${slot} tempOn:${tempOn} motorRunning:${motorRunning} needsCtrlOn:${needsCtrlOn} enableTempCtrl:${enableTempCtrl} sels:${JSON.stringify(sels)}`,
  );

  if (needsCtrlOn) {
    // Sequenced path: motor → wait → stabilize → blower → wait → temp-ctrl → temp

    const alreadyRunning = motorRunning && sels.motor === null;
    const motorStartedAt = alreadyRunning ? null : Date.now();

    if (!alreadyRunning) {
      const motorVal = sels.motor !== null ? sels.motor : SP_DEFAULTS.motor;
      await send("motor", motorVal);
    }

    showSetpointToast(`\u23f3 ${slot}: waiting for motor to spin up\u2026`);
    const motorConfirmed = await waitFor(
      () => isMotorRunning(slot),
      1000,
      20000,
    );
    if (!motorConfirmed) {
      showSetpointToast(
        `\u26a0\ufe0f ${slot}: motor spin-up not confirmed \u2014 continuing`,
        true,
      );
      warnings.push("motor timeout");
    }

    if (!alreadyRunning && motorConfirmed && motorStartedAt !== null) {
      const elapsed = Date.now() - motorStartedAt;
      const remaining = Math.max(0, 10000 - elapsed);
      if (remaining > 0) {
        showSetpointToast(
          `\u23f3 ${slot}: stabilizing motor (${Math.ceil(remaining / 1000)} s)\u2026`,
        );
        await wait(remaining);
      }
    }

    if (sels.blower !== null) {
      await send("blower", sels.blower);
      const blowerConfirmed = await waitFor(
        () => isBlowerRunning(slot),
        1000,
        10000,
      );
      if (!blowerConfirmed) {
        showSetpointToast(
          `\u26a0\ufe0f ${slot}: blower confirmation timed out`,
          true,
        );
        warnings.push("blower timeout");
      }
    }

    let ctrlAccepted = false;
    for (let attempt = 1; attempt <= 3 && !ctrlAccepted; attempt++) {
      if (attempt > 1) {
        showSetpointToast(
          `\u23f3 ${slot}: temp ctrl not yet on \u2014 retry ${attempt}/3\u2026`,
        );
      }
      await send("temp-ctrl", 1);
      ctrlAccepted = await waitFor(
        () => isTempControlOn(slot) === true,
        1000,
        6000,
      );
    }

    if (!ctrlAccepted) {
      showSetpointToast(
        `\u274c ${slot}: temp ctrl did not enable after 3 attempts \u2014 temp setpoint NOT sent`,
        true,
      );
      warnings.push("temp-ctrl failed");
      return { slot, warnings };
    }

    await wait(300);
    await send("temp", sels.temp);
  } else {
    // Non-sequenced path: send in order, no long waits (used by popup)
    if (sels.motor !== null) await send("motor", sels.motor);
    if (sels.blower !== null) await send("blower", sels.blower);
    if (sels.temp !== null) await send("temp", sels.temp);
  }

  return { slot, warnings };
}
```

---

### Task 2: Rewrite `restartAllRacks` with fault detection and `Promise.all`

**Files:**
- Modify: `dashboard.js:1263–1346`

- [ ] **Step 1: Replace `restartAllRacks` with the following**

Key changes: fault detection per slot, `Promise.all` replaces the sequential `for` loop, abort flag checked per slot, per-slot summary toast at completion.

```js
async function restartAllRacks() {
  const btn = document.getElementById("restart-all-racks");
  if (btn) btn.disabled = true;

  _restartAllAborted = false;
  _showStopBtn(true);

  showSetpointToast("⟳ Restart All: collecting current state\u2026");
  chrome.runtime.sendMessage({ type: "dashboard:refresh-setpoints" });

  await new Promise((r) => setTimeout(r, 5000));

  if (_restartAllAborted) {
    showSetpointToast("\u26d4 Restart All: stopped.");
    if (btn) btn.disabled = false;
    _showStopBtn(false);
    return;
  }

  const occupied = Object.keys(state).filter((slot) => {
    const v = state[slot];
    return v && v.vesselPresent !== false && v.vesselId != null;
  });

  showSetpointToast(`\u27f3 Restart All: evaluating ${occupied.length} slot(s)\u2026`);

  const slotTasks = occupied.map((slot) => {
    if (_restartAllAborted) return Promise.resolve({ slot, aborted: true });

    const v = state[slot];
    const motorRunning = isMotorRunning(slot);
    const blowerRunning = isBlowerRunning(slot);
    const tempOn = isTempControlOn(slot);

    const needsMotor = !motorRunning;
    const needsBlower = !blowerRunning;
    const needsTemp = tempOn !== true;

    if (!needsMotor && !needsBlower && !needsTemp) {
      return Promise.resolve({ slot, skipped: [], warnings: [], alreadyRunning: true });
    }

    // Fault detection
    const ctrlInactive = (v.mechanicalStatus || "").toLowerCase().includes("ctrl_inactive");
    const tempSpanMitg = (v.tempModuleStatus || "").toLowerCase() === "temp_span_mitg";

    const sendMotor = needsMotor && !ctrlInactive;
    const sendBlower = needsBlower;
    const sendTemp = needsTemp && !ctrlInactive && !tempSpanMitg;

    const skipped = [];
    if (needsMotor && ctrlInactive) skipped.push("motor (ctrl_inactive)");
    if (needsTemp && ctrlInactive) skipped.push("temp (ctrl_inactive)");
    if (needsTemp && tempSpanMitg && !ctrlInactive) skipped.push("temp (temp_span_mitg)");

    const tempSp = v.setpoints?.tempSp ?? SP_DEFAULTS.temp;

    _log(
      `[restartAllRacks] ${slot} \u2014 motor:${motorRunning} blower:${blowerRunning} tempOn:${tempOn} \u2192 sendMotor:${sendMotor} sendBlower:${sendBlower} sendTemp:${sendTemp} ctrlInactive:${ctrlInactive} tempSpanMitg:${tempSpanMitg}`,
    );

    return sequenceSetpoints(
      slot,
      {
        motor: sendMotor ? SP_DEFAULTS.motor : null,
        blower: sendBlower ? SP_DEFAULTS.blower : null,
        temp: sendTemp ? tempSp : null,
      },
      sendTemp,
    ).then((result) => ({ ...result, skipped }));
  });

  const results = await Promise.all(slotTasks);

  if (!_restartAllAborted) {
    const started = results.filter(
      (r) => !r.aborted && !r.alreadyRunning && (r.warnings || []).length === 0,
    );
    const allWarnings = results.flatMap((r) =>
      (r.warnings || []).map((w) => `${r.slot} ${w}`),
    );
    const faultSkips = results.filter((r) => (r.skipped || []).length > 0);

    const parts = [];
    if (started.length > 0) parts.push(`\u2713 ${started.length} started`);
    if (allWarnings.length > 0)
      parts.push(`\u26a0 ${allWarnings.length} timeout(s): ${allWarnings.join(", ")}`);
    if (faultSkips.length > 0)
      parts.push(`\u2014 ${faultSkips.length} slot(s) with fault skip(s)`);

    showSetpointToast(
      parts.length > 0
        ? `Restart All: ${parts.join(" | ")}`
        : "\u2713 Restart All: all slots already running",
    );
  }

  if (btn) btn.disabled = false;
  _showStopBtn(false);
}
```
