// ws-tap.js
// Lightweight WebSocket tap for environments where only telemetry forwarding
// is needed and the full injectWSHook from background.js is not in play.
//
// NOT registered in manifest.json by default — load manually for debugging
// or add to manifest content_scripts if you need it in a specific context.

(function () {
  const OriginalWebSocket = window.WebSocket;
  if (!OriginalWebSocket) return;

  // Guard against double-installation
  if (window.__WS_TAP_INSTALLED__) return;
  window.__WS_TAP_INSTALLED__ = true;

  function safeParse(json) {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  class WrappedWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);

      this.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;

        const parsed = safeParse(event.data);
        if (!parsed) return;

        // Only forward recognised telemetry frames
        if (parsed.type !== "data" || !parsed.vessel_id) return;

        // Post to window so ws-bridge.js can pick it up and relay to background
        window.postMessage(
          { __rack: true, type: "WS_DATA", data: parsed },
          "*",
        );
      });
    }
  }

  window.WebSocket = WrappedWebSocket;
  console.log("✅ ws-tap.js installed");
})();
