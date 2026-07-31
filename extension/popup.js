async function loadConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL("config.json"));
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function loadFrontendStatus(config) {
  if (!config || !config.token) return null;
  try {
    const host = config.host || "127.0.0.1";
    const port = config.port || 17329;
    const response = await fetch(`http://${host}:${port}/frontend/status`, {
      headers: {
        "X-PCBridge-Token": config.token,
      },
    });
    if (!response.ok) return null;
    const envelope = await response.json();
    return envelope.ok ? envelope.data : null;
  } catch {
    return null;
  }
}

function isEditorUrl(url) {
  return Boolean(
    url &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname === "playcanvas.com" &&
      url.pathname.startsWith("/editor"),
  );
}

async function switchFrontend(active, url, custom) {
  if (!active || !url) return;
  if (custom) {
    url.searchParams.set("use_local_frontend", "");
  } else {
    url.searchParams.delete("use_local_frontend");
  }
  await chrome.tabs.update(active.id, { url: url.toString() });
  window.close();
}

async function main() {
  const config = await loadConfig();
  const daemon = document.getElementById("daemon");
  const tab = document.getElementById("tab");
  const frontend = document.getElementById("frontend");
  const mode = document.getElementById("mode");
  const message = document.getElementById("message");
  const useCustom = document.getElementById("use-custom");
  const useOfficial = document.getElementById("use-official");

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = active && active.url ? new URL(active.url) : null;
  const isEditor = isEditorUrl(url);
  const isLaunch = Boolean(url && url.hostname === "launch.playcanvas.com");
  const customMode = Boolean(isEditor && url.searchParams.has("use_local_frontend"));
  const frontendStatus = await loadFrontendStatus(config);
  const serverReady = Boolean(
    frontendStatus &&
      frontendStatus.ready &&
      frontendStatus.server &&
      frontendStatus.server.listening,
  );

  daemon.textContent = frontendStatus
    ? `${config.host || "127.0.0.1"}:${config.port || 17329} connected`
    : "Not reachable";

  tab.textContent = isEditor
    ? "PlayCanvas Editor"
    : isLaunch
      ? "PlayCanvas Launch"
      : "Open a PlayCanvas Editor or Launch tab";

  frontend.textContent = frontendStatus && frontendStatus.activeRelease
    ? frontendStatus.activeRelease
    : "Not installed";
  mode.textContent = isEditor
    ? customMode
      ? "Custom"
      : "Official"
    : "Unavailable";

  useCustom.disabled = !isEditor || !serverReady;
  useOfficial.disabled = !isEditor || !customMode;

  if (!isEditor) {
    message.textContent = "Open a playcanvas.com Editor tab to switch frontend versions.";
  } else if (!frontendStatus) {
    message.textContent = "Start the daemon. Official mode remains available.";
  } else if (!frontendStatus.ready) {
    message.textContent = "Run: pcbridge frontend install latest";
  } else if (!frontendStatus.server.listening) {
    message.textContent = "Port 3487 is unavailable. Check pcbridge frontend status.";
  } else {
    message.textContent = "Switching reloads this Editor tab and preserves its other URL parameters.";
  }

  useCustom.addEventListener("click", () => switchFrontend(active, url, true));
  useOfficial.addEventListener("click", () => switchFrontend(active, url, false));
}

main().catch((error) => {
  document.getElementById("message").textContent = String(error);
});
