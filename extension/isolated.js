(() => {
  "use strict";

  const CHANNEL = "playcanvas-agent-bridge";
  const DEFAULT_CONFIG = {
    host: "127.0.0.1",
    port: 17329,
    token: ""
  };
  const clientId =
    "pcbridge-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2);

  let ws = null;
  let reconnectTimer = null;
  let config = DEFAULT_CONFIG;
  let tabInfo = {};
  const pending = new Map();

  function requestId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function serializeError(error) {
    if (error && typeof error === "object" && error.message) {
      return {
        code: error.code || "EXTENSION_ERROR",
        message: String(error.message)
      };
    }
    return { code: "EXTENSION_ERROR", message: String(error) };
  }

  function requestRuntime(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function callMain(method, params, timeoutMs) {
    const id = requestId();
    const timeout = Number(timeoutMs || 15000);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`No response from PlayCanvas page after ${timeout}ms.`));
      }, timeout + 250);

      pending.set(id, { resolve, reject, timer });
      window.postMessage(
        {
          channel: CHANNEL,
          side: "isolated",
          type: "request",
          id,
          method,
          params: params || {}
        },
        "*"
      );
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.side !== "main") return;

    if (message.type === "response" && message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) {
        waiter.resolve(message);
      } else {
        waiter.reject(message.error || new Error("Page request failed."));
      }
    }
  });

  async function loadConfig() {
    const loaded = await requestRuntime({ type: "pcbridge:getConfig" });
    const next = { ...DEFAULT_CONFIG, ...(loaded || {}) };
    if (!next.token) {
      console.warn(
        "[pcbridge] Missing local token. Run pcbridge install-extension and load the generated extension directory."
      );
    }
    return next;
  }

  function getTabInfo() {
    return requestRuntime({ type: "pcbridge:getTabInfo" });
  }

  async function describeTarget() {
    try {
      const response = await callMain("bridge:describeTarget", {}, 3000);
      return {
        clientId,
        tabId: tabInfo.tabId,
        windowId: tabInfo.windowId,
        ...(response.data || {}),
        url: (response.data && response.data.url) || location.href,
        title: (response.data && response.data.title) || document.title || "",
        ready: Boolean(response.data && response.data.ready)
      };
    } catch {
      return {
        clientId,
        tabId: tabInfo.tabId,
        windowId: tabInfo.windowId,
        url: location.href,
        title: document.title || "",
        ready: false
      };
    }
  }

  async function sendTargetUpdate() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "target:update",
        target: await describeTarget()
      })
    );
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1000);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url =
      `ws://${config.host}:${config.port}/extension?` +
      `token=${encodeURIComponent(config.token || "")}&clientId=${encodeURIComponent(clientId)}`;

    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      console.info("[pcbridge] connected to local daemon");
      sendTargetUpdate();
    });

    ws.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (!message || message.type !== "request" || !message.id) return;

      try {
        const response = await callMain(message.method, message.params || {}, message.timeoutMs);
        ws.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: true,
            data: response.data,
            meta: response.meta || {}
          })
        );
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: false,
            error: serializeError(error)
          })
        );
      }
    });

    ws.addEventListener("close", () => {
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        scheduleReconnect();
      }
    });
  }

  async function start() {
    config = await loadConfig();
    tabInfo = await getTabInfo();
    connect();
    setInterval(sendTargetUpdate, 2000);
  }

  start();
})();
