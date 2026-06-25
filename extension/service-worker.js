chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "pcbridge:getTabInfo") {
    sendResponse({
      tabId: sender.tab && sender.tab.id,
      windowId: sender.tab && sender.tab.windowId
    });
    return true;
  }

  if (message && message.type === "pcbridge:getConfig") {
    fetch(chrome.runtime.getURL("config.json"))
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => {
        sendResponse(
          config || {
            host: "127.0.0.1",
            port: 17329,
            token: ""
          }
        );
      })
      .catch(() => {
        sendResponse({
          host: "127.0.0.1",
          port: 17329,
          token: ""
        });
      });
    return true;
  }

  return false;
});
