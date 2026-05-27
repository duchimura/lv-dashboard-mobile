// ws-hook.js
// Standalone MAIN world WebSocket hook — used for debugging / manual injection.
// In normal operation this is superseded by the hook in background.js (injectWSHook).

(function () {
  const OriginalWebSocket = window.WebSocket;

  function WrappedWebSocket(url, protocols) {
    const ws = new OriginalWebSocket(url, protocols);

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);

        // DECLOG LOGGER
        if (
          data &&
          (data.intake_declog_req === 1 || data.exhaust_declog_req === 1)
        ) {
          console.log("🟡 DECLOG EVENT DETECTED", {
            vessel_id: data.vessel_id,
            intake_declog_req: data.intake_declog_req,
            exhaust_declog_req: data.exhaust_declog_req,
            raw: data,
          });
        }

        if (data && data.type === "data" && data.vessel_id) {
          window.postMessage(
            {
              __rack: true,
              type: "WS_DATA",
              data,
            },
            "*",
          );
        }
      } catch (e) {}
    });

    return ws;
  }

  WrappedWebSocket.prototype = OriginalWebSocket.prototype;
  Object.setPrototypeOf(WrappedWebSocket, OriginalWebSocket);

  window.WebSocket = WrappedWebSocket;

  console.log("✅ WebSocket hook installed (ws-hook.js)");
  // FIX: removed `console.log("WS MESSAGE:", event.data)` that was
  // outside any function/listener — `event` is not defined there and
  // caused a ReferenceError that crashed the script on every injection.
})();
