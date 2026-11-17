const WORKSPACE_SETTINGS_KEY = "pcbridgeWorkspaceSettings";
const PENDING_RELOAD_KEY = "pcbridgePendingReload";

function syncUpdateBadge(updates) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  const hasUpdates = Boolean(updates && updates.hasUpdates);
  void chrome.action.setBadgeText({ text: hasUpdates ? "↑" : "" });
  if (hasUpdates && chrome.action.setBadgeBackgroundColor) {
    void chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  }
}

function isPlayCanvasTabUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.hostname === "launch.playcanvas.com" || url.hostname === "pc-launch.sightp.com") {
      return true;
    }
    return /^\/(?:editor|launch)(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

async function reloadPlayCanvasTabs() {
  if (!chrome.tabs || !chrome.tabs.query) return 0;
  const tabs = await chrome.tabs.query({});
  let count = 0;
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || !tab.url || !isPlayCanvasTabUrl(tab.url)) continue;
    const status = await siteStatus(tab.url);
    if (!status.enabled) continue;
    try {
      if (typeof chrome.tabs.reload === "function") {
        await chrome.tabs.reload(tab.id);
      } else if (typeof chrome.tabs.update === "function") {
        await chrome.tabs.update(tab.id, { url: tab.url });
      }
      count += 1;
    } catch {
      // Ignore tabs that closed while reloading.
    }
  }
  return count;
}

async function consumePendingReload() {
  if (!chrome.storage || !chrome.storage.local) return;
  const pending = await readObject(chrome.storage.local, PENDING_RELOAD_KEY);
  if (!pending || !pending.requestedAt) return;
  await chrome.storage.local.set({ [PENDING_RELOAD_KEY]: {} });
  if (pending.reloadTabs !== false && Date.now() - Number(pending.requestedAt) < 60000) {
    await reloadPlayCanvasTabs();
  }
}

function clampEagerMaxMb(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(10, Math.max(1, Math.round(parsed)));
}

async function readObject(area, key) {
  if (!area) return {};
  const data = await area.get(key);
  const value = data && data[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

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

async function requestDaemon(message, sender) {
  const path = String(message.path || "");
  const method = String(message.method || "GET").toUpperCase();
  const allowed =
    (/^\/plugins\/[a-z0-9-]+\/actions\/[\w.-]+$/.test(path) && method === "POST") ||
    (path === "/workspace/sync" && method === "POST") ||
    (path === "/workspace/settings" && (method === "GET" || method === "POST")) ||
      (/^\/processing\/(capabilities|begin|chunk|run|status|read|cancel|finish)$/.test(path) && method === "POST");
  if (!allowed) {
    return {
      ok: false,
      error: { code: "UNSUPPORTED_DAEMON_REQUEST", message: "Unsupported pcbridge browser request." }
    };
  }

  if (!sender.tab || !(await siteStatus(sender.tab.url)).enabled) {
    return { ok: false, error: { code: "SITE_DISABLED", message: "Site is not enabled." } };
  }
  const config = await loadConfig();
  if (!config.token) {
    return {
      ok: false,
      error: { code: "DAEMON_CONFIG_UNAVAILABLE", message: "pcbridge daemon configuration is unavailable." }
    };
  }
  const payload = message.body && typeof message.body === "object" ? { ...message.body } : {};
  const tabId = sender.tab && sender.tab.id;
  if (method === "POST" && Number.isInteger(tabId)) {
    payload.target = "tab:" + tabId;
  }
  const host = config.host || "127.0.0.1";
  const port = config.port || 17329;
  try {
    const response = await fetch(`http://${host}:${port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-PCBridge-Token": config.token
      },
      body: method === "POST" ? JSON.stringify(payload) : undefined
    });
    const envelope = await response.json().catch(() => null);
    if (!response.ok || !envelope || !envelope.ok) {
      return {
        ok: false,
        error: (envelope && envelope.error) || {
          code: "DAEMON_HTTP_ERROR",
          message: `pcbridge daemon request failed with HTTP ${response.status}.`
        }
      };
    }
    return { ok: true, data: envelope.data };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "DAEMON_UNREACHABLE",
        message: String((error && error.message) || error)
      }
    };
  }
}

async function focusSenderTab(sender) {
  const tabId = sender.tab && sender.tab.id;
  const windowId = sender.tab && sender.tab.windowId;
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: "The requesting PlayCanvas tab is unavailable." };
  }
  if (Number.isInteger(windowId) && chrome.windows && chrome.windows.update) {
    await chrome.windows.update(windowId, { focused: true });
  }
  await chrome.tabs.update(tabId, { active: true });
  return { ok: true, tabId, windowId: Number.isInteger(windowId) ? windowId : null };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "pcbridge:siteStatus") {
    siteStatus(sender.tab?.url || message.url).then(sendResponse);
    return true;
  }
  if (message && message.type === "pcbridge:setSite" && !sender.tab) {
    (async () => {
      const origin = siteOrigin(message.url);
      if (!origin || builtinSite(message.url)) throw new Error("This site cannot be changed.");
      if (message.enabled && !(await chrome.permissions.contains({ origins: [origin] }))) throw new Error("Site permission is required.");
      const sites = await readObject(chrome.storage.local, SITES_KEY);
      if (message.enabled) sites[origin] = true;
      else delete sites[origin];
      await chrome.storage.local.set({ [SITES_KEY]: sites });
      await reconcileSites();
      return siteStatus(message.url);
    })().then(sendResponse).catch(error => sendResponse({ error: String(error) }));
    return true;
  }

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

  if (message && message.type === "pcbridge:focusCurrentTab") {
    focusSenderTab(sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message && message.type === "pcbridge:reloadExtension") {
    const reloadTabs = message.reloadTabs !== false;
    (async () => {
      if (chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({
          [PENDING_RELOAD_KEY]: { reloadTabs, requestedAt: Date.now() }
        });
      }
      setTimeout(() => {
        if (chrome.runtime && typeof chrome.runtime.reload === "function") {
          chrome.runtime.reload();
        }
      }, 50);
      return { ok: true, reloading: true, reloadTabs };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message && message.type === "pcbridge:syncUpdateBadge") {
    syncUpdateBadge(message.updates || null);
    sendResponse({ ok: true });
    return true;
  }

  if (message && message.type === "pcbridge:probeDaemon") {
    loadConfig()
      .then(async (config) => {
        if (!config.token) return { reachable: false };
        const host = config.host || "127.0.0.1";
        const port = config.port || 17329;
        try {
          const response = await fetch(`http://${host}:${port}/status`, {
            headers: { "X-PCBridge-Token": config.token }
          });
          if (response.ok) {
            const envelope = await response.json().catch(() => null);
            if (envelope && envelope.ok && envelope.data && envelope.data.updates) {
              syncUpdateBadge(envelope.data.updates);
            }
          }
          return { reachable: response.ok };
        } catch {
          return { reachable: false };
        }
      })
      .then(sendResponse);
    return true;
  }

  if (message && message.type === "pcbridge:daemonRequest") {
    requestDaemon(message, sender).then(sendResponse);
    return true;
  }

  if (message && message.type === "pcbridge:getWorkspaceSettings") {
    readObject(chrome.storage && chrome.storage.local, WORKSPACE_SETTINGS_KEY)
      .then((stored) => sendResponse({
        ok: true,
        eagerMaxMb: clampEagerMaxMb(stored.eagerMaxMb),
        pendingDaemonSync: Boolean(stored.pendingDaemonSync)
      }))
      .catch(() => sendResponse({ ok: false, eagerMaxMb: 2, pendingDaemonSync: false }));
    return true;
  }

  if (message && message.type === "pcbridge:setWorkspaceSettings") {
    const eagerMaxMb = clampEagerMaxMb(message.eagerMaxMb);
    const pendingDaemonSync = Boolean(message.pendingDaemonSync);
    (async () => {
      if (chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({
          [WORKSPACE_SETTINGS_KEY]: { eagerMaxMb, pendingDaemonSync }
        });
      }
      return { ok: true, eagerMaxMb, pendingDaemonSync };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, eagerMaxMb, pendingDaemonSync }));
    return true;
  }

  return false;
});

// Registered scripts are reconciled with permissions on startup and revocation.
const SITES_KEY = "pcbridgeSites";
function siteOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch { return null; }
}
function builtinSite(value) {
  try {
    return [
      "playcanvas.com",
      "launch.playcanvas.com",
      "pc-editor.sightp.com",
      "pc-launch.sightp.com",
      "localhost",
      "127.0.0.1"
    ].includes(new URL(value).hostname);
  }
  catch { return false; }
}
async function siteStatus(value) {
  const origin = siteOrigin(value);
  if (!origin) return { enabled: false, builtin: false, origin: null };
  const builtin = builtinSite(value);
  if (builtin) return { enabled: true, builtin, origin };
  const sites = await readObject(chrome.storage.local, SITES_KEY);
  const permitted = await chrome.permissions.contains({ origins: [origin] });
  return { enabled: sites[origin] === true && permitted, builtin, origin };
}
let reconcileQueue = Promise.resolve();
function reconcileSites() {
  reconcileQueue = reconcileQueue.catch(() => {}).then(async () => {
    const sites = await readObject(chrome.storage.local, SITES_KEY);
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const obsolete = registered.filter(s => s.id.startsWith("pcbridge-site-"));
    if (obsolete.length) await chrome.scripting.unregisterContentScripts({ ids: obsolete.map(s => s.id) });
    const scripts = [];
    for (const [origin, enabled] of Object.entries(sites)) {
      if (!enabled || !(await chrome.permissions.contains({ origins: [origin] }))) continue;
      const prefix = `pcbridge-site-${scripts.length}`;
      for (const world of ["MAIN", "ISOLATED"]) scripts.push({
        id: `${prefix}-${world.toLowerCase()}`, matches: [origin],
        js: [world === "MAIN" ? "main.js" : "isolated.js"], world,
        runAt: "document_start", persistAcrossSessions: true
      });
    }
    if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
    for (const tab of await chrome.tabs.query({})) {
      if (!tab.url || (await siteStatus(tab.url)).enabled) continue;
      await chrome.tabs.sendMessage(tab.id, { type: "pcbridge:siteDisabled" }).catch(() => {});
    }
  });
  return reconcileQueue;
}
if (chrome.permissions && chrome.scripting) {
  chrome.permissions.onRemoved.addListener(() => { void reconcileSites(); });
  chrome.runtime.onStartup.addListener(() => { void reconcileSites(); });
  chrome.runtime.onInstalled.addListener(() => {
    void reconcileSites();
  });
  void reconcileSites();
}
if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void consumePendingReload();
  });
}
void consumePendingReload();
