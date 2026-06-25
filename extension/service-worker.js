chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "pcbridge:getTabInfo") {
    sendResponse({
      tabId: sender.tab && sender.tab.id,
      windowId: sender.tab && sender.tab.windowId
    });
    return true;
  }

  return false;
});
