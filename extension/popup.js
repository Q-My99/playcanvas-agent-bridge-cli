function clampEagerMaxMb(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(10, Math.max(1, Math.round(parsed)));
}

async function updateDaemonWorkspaceSettings(config, eagerMaxMb) {
  if (!config || !config.token) return null;
  try {
    const host = config.host || "127.0.0.1";
    const port = config.port || 17329;
    const response = await fetch(`http://${host}:${port}/workspace/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PCBridge-Token": config.token
      },
      body: JSON.stringify({ eagerMaxMb })
    });
    if (!response.ok) return null;
    const envelope = await response.json();
    return envelope.ok ? envelope.data : null;
  } catch {
    return null;
  }
}

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

async function pluginRequest(config, path, body) {
  if (!config || !config.token) {
    return { ok: false, error: { message: "pcbridge daemon configuration is unavailable." } };
  }
  try {
    const response = await fetch(`http://${config.host || "127.0.0.1"}:${config.port || 17329}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-PCBridge-Token": config.token
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return await response.json();
  } catch {
    return { ok: false, error: { message: "pcbridge daemon is offline. Run pcbridge daemon start." } };
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setupPlugins(config) {
  const view = document.getElementById("view-plugins");
  const list = document.getElementById("plugin-list");
  const available = document.getElementById("plugin-available");
  const note = document.getElementById("plugin-note");
  const source = document.getElementById("plugin-source");
  const defaultNote = note.textContent;
  const states = {
    active: ["Active", "success"],
    stopped: ["Stopped", "warning"],
    disabled: ["Disabled", "neutral"],
    error: ["Error", "danger"]
  };

  function showNote(message, isError) {
    note.textContent = message || defaultNote;
    note.classList.toggle("error", Boolean(isError));
  }

  async function run(path, body, pending) {
    showNote(pending, false);
    view.inert = true;
    const result = await pluginRequest(config, path, body);
    view.inert = false;
    await refresh();
    if (!result.ok) showNote(result.error.message, true);
    return result.ok;
  }

  function action(label, handler, primary) {
    const button = element("button", primary ? "primary" : "", label);
    button.type = "button";
    button.addEventListener("click", handler);
    return button;
  }

  function installedRow(plugin) {
    const row = element("div", "plugin");
    const head = element("div", "plugin-head");
    head.append(element("strong", "", plugin.name), element("span", "mono", plugin.version ? `v${plugin.version}` : ""));
    const status = element("span", "status");
    setStatus(status, ...states[plugin.state]);
    head.append(status);
    row.append(head);
    if (plugin.description) row.append(element("p", "", plugin.description));
    const runtimes = Object.keys(plugin.runtimes).filter((name) => plugin.runtimes[name]);
    row.append(element("p", "mono", [plugin.id, ...runtimes, plugin.source.type].join(" · ")));
    if (plugin.error) row.append(element("p", "error", plugin.error));
    for (const page of plugin.pages || []) {
      if (!page.ok) row.append(element("p", "error", `${page.target}: ${page.error}`));
    }
    const actions = element("div", "plugin-actions");
    actions.append(
      plugin.enabled
        ? action("Disable", () => run(`/plugins/${plugin.id}/disable`, {}, `Disabling ${plugin.name}…`))
        : action("Enable", () => run(`/plugins/${plugin.id}/enable`, {}, `Enabling ${plugin.name}…`), true),
      action("Remove", () => run(`/plugins/${plugin.id}/remove`, {}, `Removing ${plugin.name}…`))
    );
    row.append(actions);
    return row;
  }

  function availableRow(plugin) {
    const row = element("div", "plugin");
    const head = element("div", "plugin-head");
    head.append(element("strong", "", plugin.name), element("span", "mono", `v${plugin.version}`));
    row.append(head);
    if (plugin.description) row.append(element("p", "", plugin.description));
    const actions = element("div", "plugin-actions");
    actions.append(action("Install", () => run("/plugins/add", { source: plugin.source }, `Installing ${plugin.name}…`), true));
    row.append(actions);
    return row;
  }

  async function refresh() {
    const result = await pluginRequest(config, "/plugins");
    const count = document.getElementById("plugin-count");
    const plugins = result.ok ? result.data.plugins : [];
    const offered = result.ok ? result.data.available : [];
    list.replaceChildren(...plugins.map(installedRow));
    available.replaceChildren(...offered.map(availableRow));
    document.getElementById("plugin-empty").hidden = !result.ok || plugins.length > 0;
    document.getElementById("plugin-available-section").hidden = offered.length === 0;
    document.getElementById("plugin-add").disabled = !result.ok;
    if (result.ok) {
      const enabled = plugins.filter((plugin) => plugin.enabled).length;
      setStatus(count, `${enabled} enabled`, plugins.some((plugin) => plugin.state === "error") ? "danger" : enabled ? "success" : "neutral");
      showNote("", false);
    } else {
      setStatus(count, "Unavailable", "danger");
      showNote(result.error.message, true);
    }
  }

  document.getElementById("plugin-add").addEventListener("click", async () => {
    const value = source.value.trim();
    if (value && await run("/plugins/add", { source: value }, "Installing plugin…")) source.value = "";
  });

  const tabs = { bridge: document.getElementById("tab-bridge"), plugins: document.getElementById("tab-plugins") };
  for (const [name, tab] of Object.entries(tabs)) {
    tab.addEventListener("click", () => {
      for (const [other, button] of Object.entries(tabs)) {
        button.setAttribute("aria-selected", String(other === name));
        document.getElementById(`view-${other}`).hidden = other !== name;
      }
      if (name === "plugins") void refresh();
    });
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
  const { isEditor, isSelfhostEditor, isLaunch, customMode, rememberedMode, sliderActive, fallbackEagerMaxMb } = context;
  const target = status && status.target;
  const workspace = status && status.workspace;
  const frontend = status && status.frontend;

  const overallStatus = document.getElementById("overall-status");
  const daemonStatus = document.getElementById("daemon-status");
  const workspaceStatus = document.getElementById("workspace-status");
  const frontendStatus = document.getElementById("frontend-status");
  const workspacePath = document.getElementById("workspace-path");
  const workspaceNote = document.getElementById("workspace-note");
  const frontendNote = document.getElementById("frontend-note");
  const copyPath = document.getElementById("copy-path");
  const useCustom = document.getElementById("use-custom");
  const useOfficial = document.getElementById("use-official");
  const eagerLimit = document.getElementById("eager-limit");
  const eagerLimitValue = document.getElementById("eager-limit-value");

  if (!sliderActive) {
    const effectiveMb = clampEagerMaxMb(
      (workspace && workspace.eagerMaxMb) ??
      (status && status.daemon && status.daemon.eagerMaxMb) ??
      fallbackEagerMaxMb ??
      2
    );
    eagerLimit.value = String(effectiveMb);
    eagerLimitValue.textContent = `${effectiveMb} MB`;
  }

  const extensionVersion = chrome.runtime.getManifest().version;
  document.getElementById("version").textContent = status && status.daemon
    ? `Extension v${extensionVersion} · Daemon v${status.daemon.version} · ${status.daemon.targetCount} target${status.daemon.targetCount === 1 ? "" : "s"}`
    : `Extension v${extensionVersion} · Daemon unavailable`;

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
    : isEditor || isSelfhostEditor || isLaunch
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

  const customExpected = Boolean(isEditor && (customMode || rememberedMode === "custom"));
  const frontendInstalled = Boolean(frontend && frontend.ready);
  const serverReady = Boolean(frontendInstalled && frontend.server && frontend.server.listening);
  setStatus(
    frontendStatus,
    serverReady
      ? "Available"
      : !status
        ? "Daemon offline"
        : frontend && frontend.ready
          ? "Server stopped"
          : "Not installed",
    serverReady ? "success" : customExpected ? "danger" : status && frontendInstalled ? "warning" : "neutral"
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

  const note = !customExpected || serverReady
    ? ""
    : !status
      ? "Custom frontend unavailable: pcbridge daemon is offline."
      : !frontendInstalled
        ? "Custom frontend unavailable: no active frontend release is installed."
        : `Custom frontend unavailable: port ${frontend.server.port} is not listening.`;
  frontendNote.textContent = note;
  frontendNote.hidden = !note;
  frontendNote.classList.toggle("error", Boolean(note));

  useCustom.disabled = !isEditor || !serverReady || customMode;
  useOfficial.disabled = !isEditor || !customMode;
}

async function main() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = active && active.url ? new URL(active.url) : null;
  const isEditor = isEditorUrl(url);
  const isSelfhostEditor = Boolean(
    url &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      /^\/editor(?:\/|$)/.test(url.pathname)
  );
  const isLaunch = Boolean(
    url &&
      (url.hostname === "launch.playcanvas.com" ||
        url.hostname === "pc-launch.sightp.com" ||
        /^\/launch\//.test(url.pathname))
  );
  const customMode = Boolean(isEditor && url.searchParams.has("use_local_frontend"));
  const site = await sendRuntimeMessage({ type: "pcbridge:siteStatus", url: url?.href });
  const siteToggle = document.getElementById("site-toggle");
  const siteStatus = document.getElementById("site-status");
  siteStatus.textContent = site?.enabled ? "Enabled" : "Not enabled";
  siteToggle.disabled = !site?.origin || site.builtin;
  siteToggle.textContent = site?.enabled ? "Disable on this site" : "Enable on this site";
  siteToggle.addEventListener("click", async () => {
    const enabled = !site.enabled;
    if (enabled && !(await chrome.permissions.request({ origins: [site.origin] }))) return;
    const result = await sendRuntimeMessage({ type: "pcbridge:setSite", url: url.href, enabled });
    if (!result || result.error) { siteStatus.textContent = result?.error || "Could not update site"; return; }
    site.enabled = result.enabled;
    siteToggle.textContent = site.enabled ? "Disable on this site" : "Enable on this site";
    siteStatus.textContent = site.enabled ? "Enabled. Refresh Editor / Launch to connect." : "Disabled. Existing connections closed.";
  });
  const config = await loadConfig();
  setupPlugins(config);
  const storedWorkspaceSettings = await sendRuntimeMessage({ type: "pcbridge:getWorkspaceSettings" });
  let fallbackEagerMaxMb = clampEagerMaxMb(storedWorkspaceSettings && storedWorkspaceSettings.eagerMaxMb);
  let status = await loadStatus(config, active && active.id);
  if (status && storedWorkspaceSettings && storedWorkspaceSettings.pendingDaemonSync) {
    const synced = await updateDaemonWorkspaceSettings(config, fallbackEagerMaxMb);
    if (synced) {
      await sendRuntimeMessage({
        type: "pcbridge:setWorkspaceSettings",
        eagerMaxMb: fallbackEagerMaxMb,
        pendingDaemonSync: false
      });
      status = await loadStatus(config, active && active.id);
    }
  }
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
    isSelfhostEditor,
    isLaunch,
    customMode,
    rememberedMode: frontendPreference && frontendPreference.mode,
    sliderActive: false,
    fallbackEagerMaxMb
  };
  renderStatus(status, context);

  const eagerLimit = document.getElementById("eager-limit");
  const eagerLimitValue = document.getElementById("eager-limit-value");
  eagerLimit.addEventListener("input", () => {
    context.sliderActive = true;
    const mb = clampEagerMaxMb(eagerLimit.value);
    context.fallbackEagerMaxMb = mb;
    eagerLimitValue.textContent = `${mb} MB`;
  });
  eagerLimit.addEventListener("change", async () => {
    const mb = clampEagerMaxMb(eagerLimit.value);
    context.fallbackEagerMaxMb = mb;
    eagerLimit.value = String(mb);
    eagerLimitValue.textContent = `${mb} MB`;
    try {
      const updated = await updateDaemonWorkspaceSettings(config, mb);
      await sendRuntimeMessage({
        type: "pcbridge:setWorkspaceSettings",
        eagerMaxMb: mb,
        pendingDaemonSync: !updated
      });
      if (updated) {
        status = await loadStatus(config, active && active.id);
      }
    } finally {
      context.sliderActive = false;
      renderStatus(status, context);
    }
  });

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
