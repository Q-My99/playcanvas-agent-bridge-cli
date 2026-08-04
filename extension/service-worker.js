const FRONTEND_PREFERENCES_KEY = "pcbridgeFrontendPreferences";
const SCENE_PROJECTS_KEY = "pcbridgeSceneProjects";
const TAB_PROJECTS_KEY = "pcbridgeTabProjects";
const tabProjects = new Map();

function normalizeId(value) {
  const id = String(value || "").trim();
  return /^\d+$/.test(id) ? id : null;
}

function parseEditorUrl(value) {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hostname !== "playcanvas.com"
    ) {
      return null;
    }

    const projectMatch = url.pathname.match(/^\/editor\/project\/(\d+)(?:\/|$)/);
    const sceneMatch = url.pathname.match(/^\/editor\/scene\/(\d+)(?:\/|$)/);
    if (!projectMatch && !sceneMatch) return null;
    return {
      url,
      projectId: projectMatch ? projectMatch[1] : null,
      sceneId: sceneMatch ? sceneMatch[1] : null
    };
  } catch {
    return null;
  }
}

async function readObject(area, key) {
  if (!area) return {};
  const data = await area.get(key);
  const value = data && data[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function rememberTabProject(tabId, projectId) {
  if (!Number.isInteger(tabId) || !projectId) return;
  tabProjects.set(tabId, projectId);
  if (!chrome.storage.session) return;
  const stored = await readObject(chrome.storage.session, TAB_PROJECTS_KEY);
  if (stored[String(tabId)] === projectId) return;
  await chrome.storage.session.set({
    [TAB_PROJECTS_KEY]: { ...stored, [String(tabId)]: projectId }
  });
}

async function forgetTabProject(tabId) {
  tabProjects.delete(tabId);
  if (!chrome.storage.session) return;
  const stored = await readObject(chrome.storage.session, TAB_PROJECTS_KEY);
  if (!Object.hasOwn(stored, String(tabId))) return;
  delete stored[String(tabId)];
  await chrome.storage.session.set({ [TAB_PROJECTS_KEY]: stored });
}

async function getTabProject(tabId) {
  if (!Number.isInteger(tabId)) return null;
  if (tabProjects.has(tabId)) return tabProjects.get(tabId);
  const stored = await readObject(chrome.storage.session, TAB_PROJECTS_KEY);
  const projectId = normalizeId(stored[String(tabId)]);
  if (projectId) tabProjects.set(tabId, projectId);
  return projectId;
}

async function rememberSceneProject(sceneId, projectId) {
  if (!sceneId || !projectId) return;
  const stored = await readObject(chrome.storage.local, SCENE_PROJECTS_KEY);
  if (stored[sceneId] === projectId) return;
  await chrome.storage.local.set({
    [SCENE_PROJECTS_KEY]: { ...stored, [sceneId]: projectId }
  });
}

async function getSceneProject(sceneId) {
  if (!sceneId) return null;
  const stored = await readObject(chrome.storage.local, SCENE_PROJECTS_KEY);
  return normalizeId(stored[sceneId]);
}

async function resolveProjectContext({ url, tabId, projectId, sceneId } = {}) {
  const parsed = parseEditorUrl(url);
  const resolvedSceneId = normalizeId(sceneId) || (parsed && parsed.sceneId);
  let resolvedProjectId = normalizeId(projectId) || (parsed && parsed.projectId);

  if (!resolvedProjectId && resolvedSceneId) {
    resolvedProjectId = await getSceneProject(resolvedSceneId);
  }
  if (!resolvedProjectId) {
    resolvedProjectId = await getTabProject(tabId);
  }
  if (resolvedProjectId) {
    await rememberTabProject(tabId, resolvedProjectId);
    await rememberSceneProject(resolvedSceneId, resolvedProjectId);
  }

  return {
    parsed,
    projectId: resolvedProjectId,
    sceneId: resolvedSceneId
  };
}

async function getFrontendPreference(context) {
  const resolved = await resolveProjectContext(context);
  if (!resolved.projectId) return { ok: false, mode: null, projectId: null };
  const preferences = await readObject(chrome.storage.local, FRONTEND_PREFERENCES_KEY);
  const mode = preferences[resolved.projectId];
  return {
    ok: true,
    mode: mode === "custom" || mode === "official" ? mode : null,
    projectId: resolved.projectId
  };
}

async function setFrontendPreference(context, mode) {
  if (mode !== "custom" && mode !== "official") {
    return { ok: false, mode: null, projectId: null };
  }
  const resolved = await resolveProjectContext(context);
  if (!resolved.projectId) return { ok: false, mode: null, projectId: null };
  const preferences = await readObject(chrome.storage.local, FRONTEND_PREFERENCES_KEY);
  await chrome.storage.local.set({
    [FRONTEND_PREFERENCES_KEY]: {
      ...preferences,
      [resolved.projectId]: mode
    }
  });
  return { ok: true, mode, projectId: resolved.projectId };
}

function frontendUrlForMode(value, mode) {
  const parsed = parseEditorUrl(value);
  if (!parsed || (mode !== "custom" && mode !== "official")) return null;
  const hadCustom = parsed.url.searchParams.has("use_local_frontend");
  if (mode === "custom") parsed.url.searchParams.set("use_local_frontend", "");
  else parsed.url.searchParams.delete("use_local_frontend");
  const changed = hadCustom !== parsed.url.searchParams.has("use_local_frontend");
  return { changed, url: parsed.url.toString() };
}

async function applyFrontendPreference(tabId, value, projectId) {
  const preference = await getFrontendPreference({ url: value, tabId, projectId });
  if (!preference.ok || !preference.mode) {
    return { ...preference, redirected: false };
  }
  const next = frontendUrlForMode(value, preference.mode);
  if (!next || !next.changed) return { ...preference, redirected: false };
  await chrome.tabs.update(tabId, { url: next.url });
  return { ...preference, redirected: true, url: next.url };
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

  if (message && message.type === "pcbridge:getFrontendPreference") {
    getFrontendPreference({
      url: message.url || (sender.tab && sender.tab.url),
      tabId: Number.isInteger(message.tabId) ? message.tabId : sender.tab && sender.tab.id,
      projectId: message.projectId,
      sceneId: message.sceneId
    }).then(sendResponse);
    return true;
  }

  if (message && message.type === "pcbridge:setFrontendPreference") {
    setFrontendPreference({
      url: message.url || (sender.tab && sender.tab.url),
      tabId: Number.isInteger(message.tabId) ? message.tabId : sender.tab && sender.tab.id,
      projectId: message.projectId,
      sceneId: message.sceneId
    }, message.mode).then(sendResponse);
    return true;
  }

  if (message && message.type === "pcbridge:rememberProjectContext") {
    resolveProjectContext({
      url: message.url || (sender.tab && sender.tab.url),
      tabId: sender.tab && sender.tab.id,
      projectId: message.projectId,
      sceneId: message.sceneId
    }).then((context) => sendResponse({
      ok: Boolean(context.projectId),
      projectId: context.projectId,
      sceneId: context.sceneId
    }));
    return true;
  }

  if (message && message.type === "pcbridge:applyFrontendPreference") {
    const tabId = sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, redirected: false });
      return false;
    }
    applyFrontendPreference(tabId, message.url || sender.tab.url, message.projectId)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, redirected: false }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (!parseEditorUrl(changeInfo.url)) {
    void forgetTabProject(tabId);
    return;
  }
  void applyFrontendPreference(tabId, changeInfo.url).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetTabProject(tabId);
});
