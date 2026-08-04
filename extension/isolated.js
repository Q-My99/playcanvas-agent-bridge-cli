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
  let heartbeatTimer = null;
  let stopped = false;
  let connecting = false;
  let reconnectAttempt = 0;
  let connectionState = "unknown";
  let lastTargetSignature = null;
  let config = DEFAULT_CONFIG;
  let tabInfo = {};
  let extensionVersion = null;
  const pending = new Map();

  function isExtensionContextInvalidated(error) {
    return String((error && error.message) || error)
      .toLowerCase()
      .includes("extension context invalidated");
  }

  function stopBridge() {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Extension context invalidated."));
    }
    pending.clear();
    if (ws) {
      try {
        ws.close();
      } catch {
        // The extension context is already gone.
      }
      ws = null;
    }
  }

  function getExtensionVersion() {
    if (extensionVersion) return extensionVersion;
    try {
      extensionVersion = chrome.runtime.getManifest().version;
      return extensionVersion;
    } catch (error) {
      if (isExtensionContextInvalidated(error)) stopBridge();
      return null;
    }
  }

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
      if (stopped) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              if (isExtensionContextInvalidated(lastError)) stopBridge();
              resolve(null);
              return;
            }
          } catch (error) {
            if (isExtensionContextInvalidated(error)) stopBridge();
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch (error) {
        if (isExtensionContextInvalidated(error)) stopBridge();
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

    if (message.type === "ready") {
      sendTargetUpdate().catch((error) => {
        if (isExtensionContextInvalidated(error)) stopBridge();
      });
      return;
    }

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
        extensionVersion: getExtensionVersion(),
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
        extensionVersion: getExtensionVersion(),
        url: location.href,
        title: document.title || "",
        ready: false
      };
    }
  }

  async function sendTargetUpdate(force = false) {
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const target = await describeTarget();
      const signature = JSON.stringify(target);
      if (!force && signature === lastTargetSignature) return;
      lastTargetSignature = signature;
      ws.send(
        JSON.stringify({
          type: "target:update",
          target
        })
      );
    } catch (error) {
      if (isExtensionContextInvalidated(error)) stopBridge();
    }
  }

  function setConnectionState(next) {
    if (connectionState === next) return;
    connectionState = next;
    if (next === "connected") {
      console.info("[pcbridge] connected to local daemon");
    } else if (next === "disconnected") {
      console.info("[pcbridge] disconnected from local daemon; waiting to reconnect");
    }
  }

  async function probeDaemon() {
    const response = await requestRuntime({ type: "pcbridge:probeDaemon" });
    return Boolean(response && response.reachable);
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) return;
    const delays = [1000, 2000, 5000, 10000, 30000];
    const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function connect() {
    if (stopped) return;
    if (connecting) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    connecting = true;
    const reachable = await probeDaemon();
    if (stopped) {
      connecting = false;
      return;
    }
    if (!reachable) {
      connecting = false;
      setConnectionState("disconnected");
      scheduleReconnect();
      return;
    }

    const url =
      `ws://${config.host}:${config.port}/extension?` +
      `token=${encodeURIComponent(config.token || "")}&clientId=${encodeURIComponent(clientId)}`;

    try {
      ws = new WebSocket(url);
    } catch {
      connecting = false;
      scheduleReconnect();
      return;
    }
    const socket = ws;
    connecting = false;

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      setConnectionState("connected");
      sendTargetUpdate(true).catch((error) => {
        if (isExtensionContextInvalidated(error)) stopBridge();
      });
    });

    socket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (!message || message.type !== "request" || !message.id) return;

      try {
        const response = await callMain(message.method, message.params || {}, message.timeoutMs);
        if (!stopped && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "response",
              id: message.id,
              ok: true,
              data: response.data,
              meta: response.meta || {}
            })
          );
        }
      } catch (error) {
        if (isExtensionContextInvalidated(error)) {
          stopBridge();
          return;
        }
        if (!stopped && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "response",
              id: message.id,
              ok: false,
              error: serializeError(error)
            })
          );
        }
      }
    });

    socket.addEventListener("close", () => {
      if (ws === socket) ws = null;
      lastTargetSignature = null;
      setConnectionState("disconnected");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        scheduleReconnect();
      }
    });
  }

  async function start() {
    config = await loadConfig();
    if (stopped) return;
    extensionVersion = getExtensionVersion();
    if (stopped) return;
    tabInfo = await getTabInfo();
    if (stopped) return;
    void connect();
    heartbeatTimer = setInterval(() => {
      sendTargetUpdate().catch((error) => {
        if (isExtensionContextInvalidated(error)) stopBridge();
      });
    }, 2000);
  }

  start().catch((error) => {
    if (isExtensionContextInvalidated(error)) stopBridge();
  });
})();
