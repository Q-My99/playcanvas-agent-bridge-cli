async function loadConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL("config.json"));
    if (response.ok) return response.json();
  } catch {
    // Use the generated-extension defaults below.
  }
  return {
    host: "127.0.0.1",
    port: 17329,
    token: ""
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "pcbridge:getTabInfo") {
    sendResponse({
      tabId: sender.tab && sender.tab.id,
      windowId: sender.tab && sender.tab.windowId
    });
    return true;
  }

  if (message && message.type === "pcbridge:getConfig") {
    loadConfig().then(sendResponse);
    return true;
  }

  if (message && message.type === "pcbridge:probeDaemon") {
    loadConfig()
      .then(async (config) => {
        if (!config.token) return { reachable: false };
        const host = config.host || "127.0.0.1";
        const port = config.port || 17329;
        try {
          const response = await fetch(`http://${host}:${port}/health`, {
            headers: { "X-PCBridge-Token": config.token }
          });
          return { reachable: response.ok };
        } catch {
          return { reachable: false };
        }
      })
      .then(sendResponse);
    return true;
  }

  return false;
});
