async function loadConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL("config.json"));
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function loadStatus(config, tabId) {
  if (!config || !config.token) return null;
  try {
    const host = config.host || "127.0.0.1";
    const port = config.port || 17329;
    const response = await fetch(`http://${host}:${port}/status?tabId=${encodeURIComponent(tabId || "")}`, {
      headers: { "X-PCBridge-Token": config.token }
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
      url.pathname.startsWith("/editor")
  );
}

function projectIdFromUrl(url) {
  if (!isEditorUrl(url)) return null;
  const match = url.pathname.match(/^\/editor\/project\/(\d+)(?:\/|$)/);
  return match ? match[1] : null;
}

async function sendRuntimeMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

function setStatus(element, label, state) {
  element.textContent = label;
  element.dataset.state = state;
}

function identity(name, id) {
  if (!name && !id) return "Unavailable";
  if (!name) return String(id);
  return id ? `${name} · ${id}` : String(name);
}

function relativeTime(value) {
  if (!value) return "Never synced";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "Synced just now";
  if (seconds < 60) return `Synced ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Synced ${minutes}m ago`;
  return `Synced ${Math.round(minutes / 60)}h ago`;
}

async function switchFrontend(active, url, custom, projectId) {
  if (!active || !url) return;
  await sendRuntimeMessage({
    type: "pcbridge:setFrontendPreference",
    tabId: active.id,
    url: url.toString(),
    projectId,
    mode: custom ? "custom" : "official"
  });
  if (custom) url.searchParams.set("use_local_frontend", "");
  else url.searchParams.delete("use_local_frontend");
  await chrome.tabs.update(active.id, { url: url.toString() });
  window.close();
}

function renderStatus(status, context) {
  const { isEditor, isLaunch, customMode, rememberedMode } = context;
  const target = status && status.target;
  const workspace = status && status.workspace;
  const frontend = status && status.frontend;

  const overallStatus = document.getElementById("overall-status");
  const daemonStatus = document.getElementById("daemon-status");
  const workspaceStatus = document.getElementById("workspace-status");
  const frontendStatus = document.getElementById("frontend-status");
  const workspacePath = document.getElementById("workspace-path");
  const workspaceNote = document.getElementById("workspace-note");
  const copyPath = document.getElementById("copy-path");
  const useCustom = document.getElementById("use-custom");
  const useOfficial = document.getElementById("use-official");

  document.getElementById("version").textContent = status && status.daemon
    ? `v${status.daemon.version} · ${status.daemon.targetCount} target${status.daemon.targetCount === 1 ? "" : "s"}`
    : "Daemon unavailable";

  if (!status) {
    setStatus(overallStatus, "Offline", "danger");
    setStatus(daemonStatus, "Disconnected", "danger");
  } else {
    setStatus(daemonStatus, "Connected", "success");
    if (target && target.connected && target.ready) setStatus(overallStatus, "Ready", "success");
    else if (target && target.connected) setStatus(overallStatus, "Initializing", "warning");
    else setStatus(overallStatus, "No target", "warning");
  }

  document.getElementById("target").textContent = target
    ? `${target.kind === "launch" ? "Launch" : "Editor"} · ${target.ready ? "Ready" : "Initializing"}`
    : isEditor || isLaunch
      ? "Not connected"
      : "Not a PlayCanvas tab";
  document.getElementById("project").textContent = target
    ? identity(target.projectName, target.projectId)
    : "Unavailable";
  document.getElementById("scene").textContent = target
    ? identity(target.sceneName, target.sceneId)
    : "Unavailable";
  document.getElementById("branch").textContent = target
    ? identity(target.branchName, target.branchId)
    : "Unavailable";

  const workspaceStates = {
    initializing: ["Initializing", "warning"],
    syncing: ["Syncing", "warning"],
    synced: ["Synced", "success"],
    "local-change": ["Local changes", "warning"],
    "remote-change": ["Remote changes", "warning"],
    conflict: ["Conflict", "danger"],
    error: ["Sync error", "danger"],
    unavailable: ["Unavailable", "neutral"]
  };
  const workspaceState = workspaceStates[(workspace && workspace.state) || "unavailable"] || workspaceStates.unavailable;
  setStatus(workspaceStatus, workspaceState[0], workspaceState[1]);

  if (workspace && workspace.available) {
    const path = workspace.projectDirectory || workspace.rootDirectory || "";
    workspacePath.textContent = path;
    workspacePath.title = path;
    copyPath.disabled = !path;
    copyPath.dataset.path = path;
    const counts = workspace.counts || {};
    document.getElementById("metric-scripts").textContent = `${counts.scriptsSynced || 0}/${counts.scripts || 0}`;
    document.getElementById("metric-assets").textContent = String(counts.assets || 0);
    document.getElementById("metric-lazy").textContent = String(counts.lazyAssets || 0);
    document.getElementById("metric-conflicts").textContent = String(counts.conflicts || 0);
    const phaseLabels = {
      snapshot: "Reading asset snapshot",
      reconciling: "Comparing workspace files",
      persisting: "Saving project catalog"
    };
    const progress = workspace.progress;
    const actionLabels = {
      comparing: "checking",
      downloading: "downloading",
      uploading: "uploading",
      conflict: "saving conflict"
    };
    const progressText = progress && progress.phase === "reconciling" && Number.isFinite(progress.total)
      ? `${phaseLabels.reconciling} ${progress.completed || 0}/${progress.total || 0}` +
        (progress.assetId ? ` · ${actionLabels[progress.action] || "checking"} #${progress.assetId}` : "")
      : progress && phaseLabels[progress.phase];
    workspaceNote.textContent = workspace.lastError || workspace.lastWarning ||
      progressText ||
      relativeTime(workspace.lastSyncedAt);
    workspaceNote.classList.toggle("error", Boolean(workspace.lastError));
  } else {
    workspacePath.textContent = workspace && workspace.rootDirectory
      ? `Root: ${workspace.rootDirectory}`
      : "No project workspace";
    workspacePath.title = workspacePath.textContent;
    workspaceNote.textContent = target && target.kind === "launch"
      ? "Workspace synchronization is managed by an Editor target."
      : "Waiting for a ready Editor target.";
  }

  const serverReady = Boolean(frontend && frontend.ready && frontend.server && frontend.server.listening);
  setStatus(
    frontendStatus,
    serverReady ? "Available" : frontend && frontend.ready ? "Server stopped" : "Not installed",
    serverReady ? "success" : frontend && frontend.ready ? "warning" : "neutral"
  );
  document.getElementById("frontend").textContent = frontend && frontend.activeRelease
    ? frontend.activeRelease
    : "Not installed";
  document.getElementById("mode").textContent = isEditor
    ? customMode ? "Custom" : "Official"
    : "Unavailable";
  document.getElementById("frontend-preference").textContent = rememberedMode
    ? rememberedMode === "custom" ? "Custom · remembered" : "Official · remembered"
    : isEditor ? "Follow current URL" : "Unavailable";

  useCustom.disabled = !isEditor || !serverReady || rememberedMode === "custom" || (!rememberedMode && customMode);
  useOfficial.disabled = !isEditor || rememberedMode === "official" || (!rememberedMode && !customMode);
}

async function main() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = active && active.url ? new URL(active.url) : null;
  const isEditor = isEditorUrl(url);
  const isLaunch = Boolean(url && url.hostname === "launch.playcanvas.com");
  const customMode = Boolean(isEditor && url.searchParams.has("use_local_frontend"));
  const config = await loadConfig();
  let status = await loadStatus(config, active && active.id);
  let projectId = (status && status.target && status.target.projectId) || projectIdFromUrl(url);
  const frontendPreference = isEditor
    ? await sendRuntimeMessage({
        type: "pcbridge:getFrontendPreference",
        tabId: active && active.id,
        url: url && url.toString(),
        projectId
      })
    : null;
  const context = {
    isEditor,
    isLaunch,
    customMode,
    rememberedMode: frontendPreference && frontendPreference.mode
  };
  renderStatus(status, context);

  const copyPath = document.getElementById("copy-path");
  const useCustom = document.getElementById("use-custom");
  const useOfficial = document.getElementById("use-official");
  useCustom.addEventListener("click", () => switchFrontend(active, url, true, projectId));
  useOfficial.addEventListener("click", () => switchFrontend(active, url, false, projectId));
  copyPath.addEventListener("click", async () => {
    const path = copyPath.dataset.path;
    if (!path || !navigator.clipboard) return;
    await navigator.clipboard.writeText(path);
    copyPath.textContent = "Copied";
    setTimeout(() => { copyPath.textContent = "Copy"; }, 1000);
  });

  setInterval(async () => {
    status = await loadStatus(config, active && active.id);
    projectId = (status && status.target && status.target.projectId) || projectIdFromUrl(url);
    renderStatus(status, context);
  }, 1000);
}

main().catch((error) => {
  setStatus(document.getElementById("overall-status"), "Error", "danger");
  document.getElementById("workspace-note").textContent = String(error);
  document.getElementById("workspace-note").classList.add("error");
});
