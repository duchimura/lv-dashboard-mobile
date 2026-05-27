console.log("ws-bridge content loaded");

// SAFE HEARTBEAT (only run if chrome.runtime exists)
if (chrome?.runtime?.sendMessage) {
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: "heartbeat" }).catch(() => {});
    } catch (e) {}
  }, 5000);
} else {
  console.warn(
    "Heartbeat disabled: chrome.runtime not available in this frame",
  );
}

// ============================================================
// PATCH 3 — Forward WS/SSE messages from MAIN world to background.js
//
// NOTE: WebSocket and EventSource wrapping is intentionally NOT done
// here. That work is handled exclusively by the MAIN world injection
// in background.js (injectWSHook). Having two wrappers on the same
// socket caused duplicate messages, noisy heartbeat signals, and
// made the stale-detection logic unreliable.
//
// This file's only job is to relay __rack-tagged postMessages that
// the MAIN world hook places on the window, up to the background
// service worker via chrome.runtime.sendMessage.
// ============================================================

window.addEventListener("message", (event) => {
  if (window !== window.top) return;
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;

  const msg = event.data;
  if (!msg || msg.__rack !== true) return;

  // Only forward recognised message types — ignore unrelated traffic
  if (
    msg.type !== "WS_DATA" &&
    msg.type !== "SSE_DATA" &&
    msg.type !== "WS_CTRL"
  )
    return;

  if (!chrome?.runtime?.sendMessage) {
    console.warn("Cannot forward WS/SSE: chrome.runtime not available");
    return;
  }

  try {
    chrome.runtime.sendMessage({
      type: msg.type, // WS_DATA or SSE_DATA
      data: msg.data,
    }).catch(() => {});
  } catch (e) {}
});
