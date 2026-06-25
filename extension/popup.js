async function loadConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL("config.json"));
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function main() {
  const config = await loadConfig();
  const daemon = document.getElementById("daemon");
  const tab = document.getElementById("tab");

  daemon.textContent = config
    ? `${config.host || "127.0.0.1"}:${config.port || 17329}`
    : "Run pcbridge install-extension";

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab.textContent = active && active.url && active.url.includes("playcanvas.com/editor")
    ? "PlayCanvas Editor"
    : "Open a PlayCanvas Editor tab";
}

main();
