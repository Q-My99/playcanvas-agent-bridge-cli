(() => {
  "use strict";

  const CHANNEL = "playcanvas-agent-bridge";
  if (window.__pcbridgeMainWorld) return;
  window.__pcbridgeMainWorld = true;

  const MAX_LOGS = 500;
  const capturedLogs = [];
  const daemonWaiters = new Map();
  let nextLogSeq = 1;
  let builderPanel = null;
  let builderRefreshTimer = null;
  let selectedTemplateId = null;
  let selectedTemplateAsset = null;
  let workspaceEventsInstalled = false;
  let sceneEventsInstalled = false;
  let observedAssets = new WeakSet();
  let observedEntities = new WeakSet();
  let workspaceSyncTimer = null;
  let sceneSyncTimer = null;
  let sceneInteractionHoldStartedAt = 0;
  let pointerDownActive = false;
  let workspaceMutationDepth = 0;
  const dirtyAssetIds = new Set();
  const removedAssetIds = new Set();
  const dirtyEntityIds = new Set();
  const removedEntityIds = new Set();
  let sceneSettingsDirty = false;
  let fullSceneDirty = false;

  const TEXT_ASSET_TYPES = new Set(["script", "text", "json", "html", "css", "shader"]);
  const DATA_JSON_ASSET_TYPES = new Set(["material", "template", "cubemap", "sprite", "animstategraph", "bundle"]);
  const META_SUMMARY_KEYS = ["width", "height", "format", "alpha", "depth", "srgb", "meshes", "vertices", "triangles", "nodes", "materials", "textures", "animations", "duration", "channels", "sampleRate"];

  function formatLogArg(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
      return JSON.stringify(serialize(value, {
        maxDepth: 3,
        maxArray: 20,
        maxKeys: 30,
        maxString: 1000
      }));
    } catch {
      return String(value);
    }
  }

  function pushLog(level, args, source) {
    const list = Array.from(args || []);
    const entry = {
      seq: nextLogSeq,
      time: new Date().toISOString(),
      level,
      source,
      text: list.map(formatLogArg).join(" "),
      args: list.map((item) => serialize(item, {
        maxDepth: 3,
        maxArray: 20,
        maxKeys: 30,
        maxString: 1000
      }))
    };
    nextLogSeq += 1;
    capturedLogs.push(entry);
    while (capturedLogs.length > MAX_LOGS) capturedLogs.shift();
  }

  function patchConsoleCapture() {
    if (window.__pcbridgeConsoleCapture) return;
    window.__pcbridgeConsoleCapture = true;

    const methods = ["debug", "log", "info", "warn", "error"];
    for (const method of methods) {
      const original = window.console && window.console[method];
      if (typeof original !== "function") continue;
      window.console[method] = function pcbridgeConsoleProxy(...args) {
        try {
          pushLog(method === "log" ? "info" : method, args, "console");
        } catch {
          // Preserve page console behavior even if log serialization fails.
        }
        return original.apply(this, args);
      };
    }

    window.addEventListener("error", (event) => {
      pushLog("error", [
        event.message || "Uncaught error",
        event.filename || "",
        event.lineno || 0,
        event.colno || 0,
        event.error || null
      ], "window.error");
    });

    window.addEventListener("unhandledrejection", (event) => {
      pushLog("error", ["Unhandled promise rejection", event.reason || null], "unhandledrejection");
    });
  }

  patchConsoleCapture();

  function installPointerTracking() {
    if (typeof window.addEventListener !== "function") return;
    const onDown = () => { pointerDownActive = true; };
    const onUp = () => { pointerDownActive = false; };
    for (const ev of ["pointerdown", "mousedown"]) window.addEventListener(ev, onDown, true);
    for (const ev of ["pointerup", "pointercancel", "mouseup", "blur"]) window.addEventListener(ev, onUp, true);
  }
  installPointerTracking();

  function safeGetEditorValue(value, path) {
    try {
      return value && typeof value.get === "function" ? value.get(path) : undefined;
    } catch {
      return undefined;
    }
  }

  function summarizeEditorObject(value) {
    const name = safeGetEditorValue(value, "name");
    const resourceId = safeGetEditorValue(value, "resource_id");
    const id = safeGetEditorValue(value, "id");
    const type = safeGetEditorValue(value, "type");

    if (name === undefined && resourceId === undefined && id === undefined && type === undefined) {
      return null;
    }

    const components = safeGetEditorValue(value, "components") || {};
    const summary = {
      __type: (value && value.constructor && value.constructor.name) || "EditorObject",
      name,
      resource_id: resourceId,
      id,
      type
    };

    const parent = safeGetEditorValue(value, "parent");
    if (parent !== undefined) summary.parent = parent;
    if (components && typeof components === "object") {
      summary.components = Object.keys(components);
    }

    return summary;
  }

  function serialize(value, options) {
    const settings = {
      maxDepth: 6,
      maxArray: 100,
      maxKeys: 80,
      maxString: 4000,
      ...(options || {})
    };
    const seen = new WeakSet();

    function normalize(current, depth) {
      if (current === undefined) return "[undefined]";
      if (current === null) return null;

      const type = typeof current;
      if (type === "string") {
        return current.length > settings.maxString
          ? current.slice(0, settings.maxString) + "...[truncated]"
          : current;
      }
      if (type === "number" || type === "boolean") return current;
      if (type === "bigint") return current.toString();
      if (type === "symbol") return String(current);
      if (type === "function") return `[Function ${current.name || "anonymous"}]`;
      if (seen.has(current)) return "[Circular]";

      const editorSummary = summarizeEditorObject(current);
      if (editorSummary) return editorSummary;

      if (current instanceof Error) {
        const normalized = {
          name: current.name,
          message: current.message,
          stack: current.stack
        };
        if (typeof current.code === "string") normalized.code = current.code;
        if (current.details !== undefined) normalized.details = normalize(current.details, depth + 1);
        return normalized;
      }

      if (depth >= settings.maxDepth) {
        return `[MaxDepth ${(current.constructor && current.constructor.name) || "Object"}]`;
      }

      seen.add(current);

      if (Array.isArray(current)) {
        const result = current
          .slice(0, settings.maxArray)
          .map((item) => normalize(item, depth + 1));
        if (current.length > settings.maxArray) {
          result.push(`[${current.length - settings.maxArray} more items]`);
        }
        return result;
      }

      const result = {};
      const keys = Object.keys(current);
      for (const key of keys.slice(0, settings.maxKeys)) {
        result[key] = normalize(current[key], depth + 1);
      }
      if (keys.length > settings.maxKeys) {
        result.__truncatedKeys = keys.length - settings.maxKeys;
      }
      return result;
    }

    return normalize(value, 0);
  }

  function getTargetKind() {
    if (location.hostname === "launch.playcanvas.com") return "launch";
    const selfhost = Boolean(window.config && window.config.selfhost);
    if (selfhost && /^\/launch\//.test(location.pathname)) return "launch";
    if ((location.hostname === "playcanvas.com" || selfhost) &&
        /^\/editor(?:\/|$)/.test(location.pathname)) return "editor";
    return "playcanvas";
  }

  function getAppCanvas(app) {
    return (
      (app && app.graphicsDevice && app.graphicsDevice.canvas) ||
      (app && app.canvas) ||
      null
    );
  }

  function getPrimaryCanvas(app) {
    return getAppCanvas(app) || document.querySelector("canvas");
  }

  function isVisibleElement(element) {
    if (!element) return false;
    const style = typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(element)
      : null;
    if (
      style &&
      (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
    ) {
      return false;
    }
    if (typeof element.getBoundingClientRect !== "function") return true;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function runtimeRegistryEntries(registry) {
    if (!registry) return [];
    if (typeof registry.entries === "function") {
      try {
        return Array.from(registry.entries());
      } catch {
        // Fall through to object entries.
      }
    }
    if (Array.isArray(registry)) return registry.map((app, index) => [String(index), app]);
    if (typeof registry === "object") return Object.entries(registry);
    return [];
  }

  function isLiveRuntimeApp(app) {
    return Boolean(app && app.root);
  }

  function resolveRuntimeApp() {
    const explicitCandidates = [];
    const fallbackCandidates = [];
    const seen = new Set();
    const add = (list, app, source) => {
      if (!isLiveRuntimeApp(app) || seen.has(app)) return;
      seen.add(app);
      list.push({ app, source, order: list.length });
    };
    const callGetter = (list, owner, id, source) => {
      try {
        if (owner && typeof owner.getApplication === "function") {
          add(list, owner.getApplication(id), source);
        }
      } catch {
        // Continue through the compatibility fallbacks.
      }
    };

    const pc = window.pc;
    try {
      if (window.editor && typeof window.editor.call === "function") {
        add(explicitCandidates, window.editor.call("viewport:app"), "editor.call(viewport:app)");
      }
    } catch {
      // Launch can expose only a partial Editor event bus during startup.
    }
    const canvasIds = [
      "application-canvas",
      ...Array.from(document.querySelectorAll("canvas"))
        .map((canvas) => canvas && canvas.id)
        .filter((id) => id && id !== "application-canvas")
    ];
    for (const id of canvasIds) {
      callGetter(
        explicitCandidates,
        pc && pc.AppBase,
        id,
        "pc.AppBase.getApplication(" + id + ")"
      );
    }
    for (const [owner, label] of [
      [pc && pc.AppBase, "pc.AppBase._applications"],
      [pc && pc.Application, "pc.Application._applications"]
    ]) {
      for (const id of canvasIds) {
        const match = runtimeRegistryEntries(owner && owner._applications)
          .find(([key]) => String(key) === String(id));
        if (match) add(explicitCandidates, match[1], label + "[" + id + "]");
      }
    }
    for (const id of canvasIds) {
      callGetter(
        explicitCandidates,
        pc && pc.Application,
        id,
        "pc.Application.getApplication(" + id + ")"
      );
    }

    if (explicitCandidates.length) {
      const selected = explicitCandidates[0];
      return {
        ...selected,
        canvas: getAppCanvas(selected.app),
        rootChildCount: selected.app.root && Array.isArray(selected.app.root.children)
          ? selected.app.root.children.length
          : 0,
        score: null
      };
    }

    callGetter(fallbackCandidates, pc && pc.AppBase, undefined, "pc.AppBase.getApplication()");
    callGetter(fallbackCandidates, pc && pc.Application, undefined, "pc.Application.getApplication()");

    for (const [owner, label] of [
      [pc && pc.AppBase, "pc.AppBase._applications"],
      [pc && pc.Application, "pc.Application._applications"]
    ]) {
      for (const [key, app] of runtimeRegistryEntries(owner && owner._applications)) {
        add(fallbackCandidates, app, label + "[" + key + "]");
      }
    }

    add(fallbackCandidates, window.app, "window.app");
    add(fallbackCandidates, pc && pc.app, "pc.app");

    const ownedMatches = fallbackCandidates.filter((candidate) => {
      const canvas = getAppCanvas(candidate.app);
      return Boolean(canvas && canvas.id && canvasIds.includes(canvas.id));
    });
    const mainCanvasMatches = ownedMatches.filter(
      (candidate) => getAppCanvas(candidate.app).id === "application-canvas"
    );
    const selected = mainCanvasMatches.length === 1
      ? mainCanvasMatches[0]
      : ownedMatches.length === 1
        ? ownedMatches[0]
        : fallbackCandidates.length === 1
          ? fallbackCandidates[0]
          : null;
    if (selected) {
      return {
        ...selected,
        canvas: getAppCanvas(selected.app),
        rootChildCount: Array.isArray(selected.app.root.children)
          ? selected.app.root.children.length
          : 0,
        ambiguous: false,
        candidateSources: fallbackCandidates.map((candidate) => candidate.source)
      };
    }

    return {
      app: null,
      source: null,
      canvas: null,
      rootChildCount: 0,
      ambiguous: fallbackCandidates.length > 1,
      candidateSources: fallbackCandidates.map((candidate) => candidate.source)
    };
  }

  function getScriptTypeCount(app) {
    try {
      return app && app.scripts && typeof app.scripts.list === "function"
        ? app.scripts.list().length
        : null;
    } catch {
      return null;
    }
  }

  function getRuntimeApp() {
    return resolveRuntimeApp().app;
  }

  function isLaunchSplashVisible() {
    const selectors = [
      "#application-splash-wrapper",
      "#application-splash",
      ".application-splash-wrapper",
      ".application-splash"
    ];
    return selectors.some((selector) => isVisibleElement(document.querySelector(selector)));
  }

  function getSceneIdFromUrl() {
    const editorMatch = location.href.match(/\/editor\/scene\/([^/?#]+)/);
    if (editorMatch) return editorMatch[1];

    if (location.hostname === "launch.playcanvas.com") {
      const launchMatch = location.pathname.match(/^\/([^/?#]+)/);
      if (launchMatch) return launchMatch[1];
    }

    return undefined;
  }

  function describeTarget() {
    const config = window.config || {};
    const kind = getTargetKind();
    const editorReady = Boolean(window.editor && window.editor.api && window.editor.api.globals);
    const runtime = resolveRuntimeApp();
    const app = runtime.app;
    const canvasCount = document.querySelectorAll("canvas").length;
    const pageReady = document.readyState !== "loading";
    const visibilityState = document.visibilityState || "unknown";
    const runtimeCreated = Boolean(app && app.root);
    const ownedCanvas = getAppCanvas(app);
    const graphicsContextLost = Boolean(app && app.graphicsDevice && app.graphicsDevice.contextLost);
    const graphicsReady = Boolean(
      runtimeCreated && app.graphicsDevice && ownedCanvas && !graphicsContextLost
    );
    const rootChildren = app && app.root && Array.isArray(app.root.children)
      ? app.root.children
      : [];
    const sceneRoot = app && app.scene ? app.scene.root : null;
    const sceneLoaded = Boolean(
      graphicsReady && rootChildren.length > 0 && (!sceneRoot || rootChildren.includes(sceneRoot))
    );
    const runtimeFrame = app && Number.isFinite(Number(app.frame)) ? Number(app.frame) : null;
    const runtimeStarted = Boolean(sceneLoaded && runtimeFrame !== null && runtimeFrame > 0);
    const scriptsReady = runtimeStarted;
    const scriptTypeCount = getScriptTypeCount(app);
    const splashVisible = kind === "launch" && isLaunchSplashVisible();
    const lifecycleReady = Boolean(
      pageReady && runtimeCreated && graphicsReady && sceneLoaded && runtimeStarted && !splashVisible
    );
    const readinessBlockers = [];
    if (kind === "launch") {
      if (!pageReady) readinessBlockers.push("page-loading");
      if (visibilityState !== "visible") readinessBlockers.push("tab-hidden");
      if (!runtimeCreated) readinessBlockers.push("runtime-not-created");
      if (runtimeCreated && graphicsContextLost) readinessBlockers.push("graphics-context-lost");
      if (runtimeCreated && !graphicsReady && !graphicsContextLost) {
        readinessBlockers.push("graphics-not-ready");
      }
      if (runtimeCreated && !sceneLoaded) readinessBlockers.push("scene-not-loaded");
      if (sceneLoaded && !runtimeStarted) readinessBlockers.push("runtime-not-started");
      if (splashVisible) readinessBlockers.push("splash-visible");
    }
    const launchReady = kind === "launch" && lifecycleReady && visibilityState === "visible";
    const ready = kind === "launch" ? launchReady : editorReady;
    return {
      kind,
      platform: config.selfhost ? "selfhost" : "official",
      bridgeProtocolVersion: 1,
      processingProtocolVersion: config.selfhost && kind === "editor" && window.editor?.methods?.has("assets:import:request") ? 1 : null,
      url: location.href,
      title: document.title || "",
      ready,
      hasEditor: Boolean(window.editor),
      hasPc: Boolean(window.pc),
      hasRuntimeApp: Boolean(app),
      runtimeAppSource: runtime.source || undefined,
      runtimeAppAmbiguous: kind === "launch" ? Boolean(runtime.ambiguous) : undefined,
      runtimeAppCandidateSources: kind === "launch" ? runtime.candidateSources || [] : undefined,
      runtimeCanvasId: app && runtime.canvas && runtime.canvas.id
        ? String(runtime.canvas.id)
        : undefined,
      engineVersion: kind === "launch" && window.pc && window.pc.version
        ? String(window.pc.version)
        : undefined,
      readinessMode: kind === "launch" ? "heuristic" : undefined,
      pageReady: kind === "launch" ? pageReady : undefined,
      visibilityState: kind === "launch" ? visibilityState : undefined,
      lifecycleReady: kind === "launch" ? lifecycleReady : undefined,
      runtimeCreated: kind === "launch" ? runtimeCreated : undefined,
      graphicsReady: kind === "launch" ? graphicsReady : undefined,
      graphicsContextLost: kind === "launch" ? graphicsContextLost : undefined,
      runtimeStarted: kind === "launch" ? runtimeStarted : undefined,
      runtimeFrame: kind === "launch" ? runtimeFrame : undefined,
      sceneLoaded: kind === "launch" ? sceneLoaded : undefined,
      scriptsReady: kind === "launch" ? scriptsReady : undefined,
      scriptTypeCount: kind === "launch" ? scriptTypeCount : undefined,
      splashVisible: kind === "launch" ? splashVisible : undefined,
      rootChildCount: kind === "launch" ? runtime.rootChildCount : undefined,
      readinessBlockers: kind === "launch" ? readinessBlockers : undefined,
      canvasCount,
      projectId: config.project && config.project.id ? String(config.project.id) : undefined,
      projectName: config.project && config.project.name ? String(config.project.name) : undefined,
      sceneId:
        (config.scene && config.scene.id ? String(config.scene.id) : undefined) ||
        getSceneIdFromUrl(),
      sceneName: config.scene && config.scene.name ? String(config.scene.name) : undefined,
      branchId:
        (config.self && config.self.branch && config.self.branch.id
          ? String(config.self.branch.id)
          : undefined) ||
        (config.branch && config.branch.id ? String(config.branch.id) : undefined),
      branchName:
        (config.self && config.self.branch && config.self.branch.name
          ? String(config.self.branch.name)
          : undefined) ||
        (config.branch && config.branch.name ? String(config.branch.name) : undefined)
    };
  }

  function readAsset(asset) {
    const get = (path) => {
      try {
        return asset.get(path);
      } catch {
        return undefined;
      }
    };
    const path = get("path") || [];
    const type = get("type");
    const result = {
      id: get("id"),
      name: get("name"),
      type,
      source: get("source") || false,
      source_asset_id: get("source_asset_id") || null,
      path,
      folder: Array.isArray(path) && path.length ? path[path.length - 1] : null,
      tags: get("tags") || [],
      preload: get("preload") !== false,
      file: get("file") || null
    };
    if (DATA_JSON_ASSET_TYPES.has(type)) {
      const plain = plainAssetJson(asset);
      const rawData = plain && plain.data !== undefined ? plain.data : get("data");
      result.data = clonePlainJson(rawData) || {};
    }
    const metaSummary = summarizeAssetMeta(get("meta"));
    if (metaSummary) result.meta = metaSummary;
    return result;
  }

  function summarizeAssetMeta(rawMeta) {
    if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) return null;
    const summary = {};
    for (const key of META_SUMMARY_KEYS) {
      const val = rawMeta[key];
      if (typeof val === "number" || typeof val === "boolean" || typeof val === "string") {
        summary[key] = val;
      }
    }
    return Object.keys(summary).length ? summary : null;
  }

  function clonePlainJson(value) {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  function splitAssetPath(path) {
    if (Array.isArray(path)) return path.map(String).map((part) => part.trim()).filter(Boolean);
    return String(path || "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function isChildFolder(asset, name, parent) {
    if (!asset || asset.get("type") !== "folder" || asset.get("name") !== name) return false;
    const path = asset.get("path") || [];
    if (!parent) return path.length === 0;
    return path[path.length - 1] === parent.get("id");
  }

  async function ensureFolderPath(assets, path) {
    const created = [];
    let parent = null;
    for (const name of splitAssetPath(path)) {
      let folder = assets.list().find((asset) => isChildFolder(asset, name, parent));
      if (!folder) {
        folder = await assets.createFolder({ name, folder: parent || undefined });
        created.push(folder);
      }
      parent = folder;
    }
    return { folder: parent, created };
  }

  async function resolveFolder(assets, params) {
    if (params.folderId !== undefined && params.folderId !== null && params.folderId !== "") {
      const folder = assets.get(Number(params.folderId));
      if (!folder || folder.get("type") !== "folder") {
        throw new Error("Folder asset not found: " + params.folderId);
      }
      return { folder, created: [] };
    }
    if (params.folder) {
      return ensureFolderPath(assets, params.folder);
    }
    return { folder: null, created: [] };
  }

  function bytesFromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function base64FromBytes(bytes) {
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function requireEditorAsset(assetId) {
    if (!window.editor || !window.editor.api || !window.editor.api.globals) {
      throw new Error("Workspace operations require a ready PlayCanvas Editor target.");
    }
    const asset = window.editor.api.globals.assets.get(Number(assetId));
    if (!asset) throw new Error("Asset not found: " + assetId);
    return asset;
  }

  async function fetchAssetFile(asset) {
    const filename = asset.get("file.filename") || asset.get("name");
    if (!filename) throw new Error("Asset has no downloadable file: " + asset.get("id"));
    const branchId =
      (window.config && window.config.self && window.config.self.branch && window.config.self.branch.id) ||
      (window.config && window.config.branch && window.config.branch.id);
    const query = branchId ? "?branchId=" + encodeURIComponent(String(branchId)) : "";
    const headers = {};
    const accessToken = window.editor.api.globals.accessToken;
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    const response = await fetch(
      "/api/assets/" + encodeURIComponent(String(asset.get("id"))) +
        "/file/" + encodeURIComponent(String(filename)) + query,
      { headers }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(body || "Failed to download asset " + asset.get("id") + ".");
    }
    return { response, filename };
  }

  function getActiveSceneId() {
    const config = window.config || {};
    const id = (config.scene && config.scene.id ? String(config.scene.id) : "") || getSceneIdFromUrl() || "";
    return id || null;
  }

  function getActiveSceneName() {
    const liveName = window.editor?.api?.globals?.realtime?.scenes?.current?.data?.name;
    if (liveName) return String(liveName);
    const config = window.config || {};
    return (config.scene && config.scene.name ? String(config.scene.name) : "") || null;
  }

  function readEntityPlain(entity) {
    if (!entity) return null;
    if (typeof entity.json === "function") return clonePlainJson(entity.json());
    if (entity.observer && typeof entity.observer.json === "function") return clonePlainJson(entity.observer.json());
    return null;
  }

  function readActiveScene() {
    const globals = window.editor && window.editor.api && window.editor.api.globals;
    const entitiesApi = globals && globals.entities;
    if (!entitiesApi || !entitiesApi.root || typeof entitiesApi.list !== "function") return null;
    const id = getActiveSceneId();
    if (!id) return null;
    const entities = {};
    for (const entity of entitiesApi.list()) {
      const data = readEntityPlain(entity);
      if (data && data.resource_id) {
        entities[String(data.resource_id)] = data;
      }
    }
    const settingsApi = globals.settings && globals.settings.scene;
    const settings = settingsApi && typeof settingsApi.json === "function"
      ? clonePlainJson(settingsApi.json()) || {}
      : {};
    return {
      id,
      name: getActiveSceneName() || "Scene",
      active: true,
      settings,
      entities
    };
  }

  function listProjectScenesIfSupported() {
    if (!window.editor || typeof window.editor.call !== "function") return Promise.resolve(null);
    if (!window.editor.methods || typeof window.editor.methods.has !== "function" || !window.editor.methods.has("scenes:list")) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 5000);
      try {
        window.editor.call(
          "scenes:list",
          (list) => {
            clearTimeout(timer);
            if (!Array.isArray(list)) { resolve(null); return; }
            resolve(list.map((item) => ({
              id: String(item.id),
              uniqueId: item.uniqueId !== undefined ? String(item.uniqueId) : undefined,
              name: String(item.name || "Scene"),
              modified: item.modified ? String(item.modified) : null
            })));
          },
          () => {
            clearTimeout(timer);
            resolve(null);
          }
        );
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  async function workspaceSnapshot() {
    if (!window.editor || !window.editor.api || !window.editor.api.globals) {
      throw new Error("Workspace operations require a ready PlayCanvas Editor target.");
    }
    const result = {
      assets: window.editor.api.globals.assets.list().map(readAsset)
    };
    const activeScene = readActiveScene();
    if (activeScene) result.activeScene = activeScene;
    const scenes = await listProjectScenesIfSupported();
    if (scenes) result.scenes = scenes;
    return result;
  }

  async function withWorkspaceMutationSuppression(fn) {
    workspaceMutationDepth += 1;
    try {
      return await fn();
    } finally {
      workspaceMutationDepth = Math.max(0, workspaceMutationDepth - 1);
    }
  }

  function emitWorkspaceDelta(delta) {
    window.postMessage({
      channel: CHANNEL,
      side: "main",
      type: "workspace-delta",
      delta
    }, "*");
  }

  function flushAssetDelta() {
    workspaceSyncTimer = null;
    if (!window.editor?.api?.globals?.assets) return;
    const assetsApi = window.editor.api.globals.assets;
    const upsertedAssets = [];
    for (const id of dirtyAssetIds) {
      if (removedAssetIds.has(id)) continue;
      const asset = assetsApi.get(Number(id));
      if (asset) upsertedAssets.push(readAsset(asset));
    }
    const removed = [...removedAssetIds];
    dirtyAssetIds.clear();
    removedAssetIds.clear();
    if (!upsertedAssets.length && !removed.length) return;
    emitWorkspaceDelta({
      upsertedAssets,
      removedAssetIds: removed
    });
  }

  function scheduleAssetDelta(assetId, removed = false) {
    if (workspaceMutationDepth > 0) return;
    if (assetId !== undefined && assetId !== null) {
      const id = String(assetId);
      if (removed) {
        dirtyAssetIds.delete(id);
        removedAssetIds.add(id);
      } else {
        removedAssetIds.delete(id);
        dirtyAssetIds.add(id);
      }
    }
    if (workspaceSyncTimer) clearTimeout(workspaceSyncTimer);
    workspaceSyncTimer = setTimeout(flushAssetDelta, 300);
  }

  function flushSceneDelta() {
    sceneSyncTimer = null;
    if (pointerDownActive && Date.now() - sceneInteractionHoldStartedAt < 5000) {
      sceneSyncTimer = setTimeout(flushSceneDelta, 400);
      return;
    }
    sceneInteractionHoldStartedAt = 0;
    const sceneId = getActiveSceneId();
    const globals = window.editor?.api?.globals;
    if (!sceneId || !globals?.entities?.root) {
      dirtyEntityIds.clear();
      removedEntityIds.clear();
      sceneSettingsDirty = false;
      fullSceneDirty = false;
      return;
    }
    if (fullSceneDirty) {
      dirtyEntityIds.clear();
      removedEntityIds.clear();
      sceneSettingsDirty = false;
      fullSceneDirty = false;
      const activeScene = readActiveScene();
      if (activeScene) emitWorkspaceDelta({ activeScene });
      return;
    }
    const upsertedEntities = {};
    for (const id of dirtyEntityIds) {
      if (removedEntityIds.has(id)) continue;
      const entity = globals.entities.get(id);
      const plain = readEntityPlain(entity);
      if (plain && plain.resource_id) upsertedEntities[String(plain.resource_id)] = plain;
    }
    const removed = [...removedEntityIds];
    const includeSettings = sceneSettingsDirty;
    dirtyEntityIds.clear();
    removedEntityIds.clear();
    sceneSettingsDirty = false;
    if (!Object.keys(upsertedEntities).length && !removed.length && !includeSettings) return;
    const sceneDelta = {
      sceneId,
      sceneName: getActiveSceneName() || "Scene",
      upsertedEntities,
      removedEntityIds: removed
    };
    if (includeSettings && globals.settings?.scene?.json) {
      sceneDelta.settings = clonePlainJson(globals.settings.scene.json()) || {};
    }
    emitWorkspaceDelta({ sceneDelta });
  }

  function scheduleSceneDelta(options = {}) {
    if (workspaceMutationDepth > 0) return;
    if (options.full) fullSceneDirty = true;
    if (options.settings) sceneSettingsDirty = true;
    if (options.entityId) {
      const id = String(options.entityId);
      if (options.removed) {
        dirtyEntityIds.delete(id);
        removedEntityIds.add(id);
      } else {
        removedEntityIds.delete(id);
        dirtyEntityIds.add(id);
      }
    }
    if (!sceneInteractionHoldStartedAt) sceneInteractionHoldStartedAt = Date.now();
    if (sceneSyncTimer) clearTimeout(sceneSyncTimer);
    sceneSyncTimer = setTimeout(flushSceneDelta, 800);
  }

  function installWorkspaceEvents() {
    const globals = window.editor?.api?.globals;
    if (globals?.assets && !workspaceEventsInstalled) {
      const assets = globals.assets;
      workspaceEventsInstalled = true;
      const observeAsset = (asset) => {
        if (!asset || typeof asset.on !== "function" || observedAssets.has(asset)) return;
        observedAssets.add(asset);
        const id = () => safeGetEditorValue(asset, "id");
        const target = asset.observer && typeof asset.observer.on === "function" ? asset.observer : asset;
        try {
          target.on("*:set", (path) => {
            if (!path) return;
            if (path.startsWith("thumbnails") || path === "has_thumbnail" || path === "file.url") return;
            scheduleAssetDelta(id(), false);
          });
          target.on("*:unset", (path) => {
            if (!path || path.startsWith("thumbnails")) return;
            scheduleAssetDelta(id(), false);
          });
          target.on("*:insert", () => scheduleAssetDelta(id(), false));
          target.on("*:remove", () => scheduleAssetDelta(id(), false));
          target.on("*:move", () => scheduleAssetDelta(id(), false));
        } catch {
          for (const event of ["file:hash:set", "file:filename:set", "path:set", "name:set"]) {
            try { asset.on(event, () => scheduleAssetDelta(id(), false)); } catch { /* optional */ }
          }
        }
      };
      for (const asset of assets.list()) observeAsset(asset);
      try {
        assets.on("add", (asset) => {
          observeAsset(asset);
          scheduleAssetDelta(safeGetEditorValue(asset, "id"), false);
        });
      } catch { /* optional */ }
      try {
        assets.on("remove", (asset) => {
          scheduleAssetDelta(safeGetEditorValue(asset, "id"), true);
        });
      } catch { /* optional */ }
      try {
        assets.on("move", (asset) => {
          scheduleAssetDelta(safeGetEditorValue(asset, "id"), false);
        });
      } catch { /* optional */ }
      try {
        assets.on("load:all", () => {
          for (const asset of assets.list()) observeAsset(asset);
          if (workspaceMutationDepth === 0) {
            void daemonRequest("/workspace/sync", "POST", {}, 60000).catch(() => undefined);
          }
        });
      } catch { /* optional */ }
    }

    if (globals?.entities && typeof globals.entities.list === "function" && !sceneEventsInstalled) {
      sceneEventsInstalled = true;
      const entities = globals.entities;
      const observeEntity = (entity) => {
        if (!entity || observedEntities.has(entity)) return;
        const target = entity.observer && typeof entity.observer.on === "function"
          ? entity.observer
          : typeof entity.on === "function" ? entity : null;
        if (!target) return;
        observedEntities.add(entity);
        const id = () => safeGetEditorValue(entity, "resource_id");
        for (const ev of ["*:set", "*:unset", "*:insert", "*:remove", "*:move"]) {
          try { target.on(ev, () => scheduleSceneDelta({ entityId: id() })); } catch { /* optional */ }
        }
      };
      for (const entity of entities.list()) observeEntity(entity);
      if (typeof entities.on === "function") {
        try {
          entities.on("add", (entity) => {
            observeEntity(entity);
            scheduleSceneDelta({ entityId: safeGetEditorValue(entity, "resource_id") });
          });
        } catch { /* optional */ }
        try {
          entities.on("remove", (entity) => {
            scheduleSceneDelta({ entityId: safeGetEditorValue(entity, "resource_id"), removed: true });
          });
        } catch { /* optional */ }
      }
      const sceneSettings = globals.settings?.scene;
      const settingsTarget = sceneSettings?.observer && typeof sceneSettings.observer.on === "function"
        ? sceneSettings.observer
        : typeof sceneSettings?.on === "function" ? sceneSettings : null;
      if (settingsTarget) {
        for (const ev of ["*:set", "*:unset", "*:insert", "*:remove", "*:move"]) {
          try { settingsTarget.on(ev, () => scheduleSceneDelta({ settings: true })); } catch { /* optional */ }
        }
      }
      if (window.editor && typeof window.editor.on === "function") {
        try {
          window.editor.on("scene:load", () => {
            for (const entity of entities.list()) observeEntity(entity);
            scheduleSceneDelta({ full: true });
          });
          window.editor.on("scene:name", () => {
            scheduleSceneDelta({ settings: true });
          });
        } catch { /* optional */ }
      }
    }
  }

  async function readAssetText(params) {
    const asset = requireEditorAsset(params.assetId);
    const type = String(asset.get("type") || "");
    if (!TEXT_ASSET_TYPES.has(type)) {
      throw new Error("Asset is not a text asset: " + params.assetId);
    }
    const { response, filename } = await fetchAssetFile(asset);
    return {
      assetId: String(asset.get("id")),
      filename,
      text: await response.text()
    };
  }

  async function readAssetFile(params) {
    const asset = requireEditorAsset(params.assetId);
    const { response, filename } = await fetchAssetFile(asset);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      assetId: String(asset.get("id")),
      filename,
      mime: response.headers.get("content-type") || "application/octet-stream",
      size: bytes.length,
      base64: base64FromBytes(bytes)
    };
  }

  async function readAssetResource(params) {
    const asset = requireEditorAsset(params.assetId);
    const file = plainAssetJson(asset)?.file || {};
    const allowedUrls = new Set();
    if (file.url) allowedUrls.add(String(file.url));
    for (const variant of Object.values(file.variants || {})) {
      if (variant && variant.url) allowedUrls.add(String(variant.url));
    }
    if (asset.get("type") === "font" && file.url) {
      const mapCount = Number(plainAssetJson(asset)?.data?.info?.maps?.length || 0);
      for (let index = 1; index < mapCount; index += 1) {
        allowedUrls.add(String(file.url).replace(/(\.[^.]*)$/, `${index}$1`));
      }
    }
    const url = String(params.url || "");
    if (!url || !allowedUrls.has(url)) {
      throw new Error("Requested URL does not belong to asset " + params.assetId + ".");
    }
    const resolvedUrl = new URL(url, location.href);
    const headers = {};
    const accessToken = window.editor.api.globals.accessToken;
    const playCanvasHost =
      resolvedUrl.hostname === "playcanvas.com" || resolvedUrl.hostname.endsWith(".playcanvas.com");
    if (accessToken && playCanvasHost) headers.Authorization = "Bearer " + accessToken;
    const response = await fetch(resolvedUrl.href, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(body || "Failed to download asset resource " + params.assetId + ".");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      assetId: String(asset.get("id")),
      mime: response.headers.get("content-type") || "application/octet-stream",
      size: bytes.length,
      base64: base64FromBytes(bytes)
    };
  }

  async function writeAssetFileInner(params) {
    const asset = requireEditorAsset(params.assetId);
    if (asset.get("type") === "script") {
      throw new Error("Use the script text writer for script assets: " + params.assetId);
    }
    const filename = String(
      params.filename || asset.get("file.filename") || asset.get("name") || "asset.bin"
    );
    const bytes = bytesFromBase64(String(params.base64 || ""));
    const form = new FormData();
    form.append("filename", filename);
    form.append(
      "file",
      new Blob([bytes], { type: params.mime || "application/octet-stream" }),
      filename
    );
    const branchId =
      (window.config && window.config.self && window.config.self.branch && window.config.self.branch.id) ||
      (window.config && window.config.branch && window.config.branch.id);
    if (branchId) form.append("branchId", String(branchId));
    const headers = {};
    const accessToken = window.editor.api.globals.accessToken;
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    const response = await fetch("/api/assets/" + encodeURIComponent(String(asset.get("id"))), {
      method: "PUT",
      headers,
      body: form
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new Error(body.error || "Failed to update asset file.");
    }
    return {
      assetId: String(asset.get("id")),
      filename,
      size: bytes.length,
      response: body
    };
  }

  function writeAssetFile(params) {
    return withWorkspaceMutationSuppression(() => writeAssetFileInner(params));
  }

  async function renameAssetInner(params) {
    const asset = requireEditorAsset(params.assetId);
    const assets = window.editor.api.globals.assets;
    const folderResult = await resolveFolder(assets, params);
    const filename = String(params.filename || asset.get("file.filename") || asset.get("name") || "asset.bin");
    const name = String(params.name || filename);
    await new Promise((resolve, reject) => {
      const error = window.editor.call("assets:rename", asset.observer, name, (callbackError) => {
        if (callbackError) reject(new Error(String(callbackError)));
        else resolve();
      });
      if (error) reject(new Error(String(error)));
    });
    if (typeof window.editor.call === "function" && Object.prototype.hasOwnProperty.call(params, "folder")) {
      const error = window.editor.call(
        "assets:fs:move",
        [asset.observer],
        folderResult.folder ? folderResult.folder.observer : null
      );
      if (error) throw new Error(String(error));
    }
    return { asset: readAsset(asset), createdFolders: folderResult.created.map(readAsset) };
  }

  function renameAsset(params) {
    return withWorkspaceMutationSuppression(() => renameAssetInner(params));
  }

  function textMimeForAssetType(type) {
    if (type === "script") return "text/javascript";
    if (type === "css") return "text/css";
    if (type === "html") return "text/html";
    if (type === "json") return "application/json";
    return "text/plain";
  }

  async function writeAssetTextInner(params, requireScript = false) {
    const asset = requireEditorAsset(params.assetId);
    const type = String(asset.get("type") || "");
    if (requireScript && type !== "script") {
      throw new Error("Asset is not a script: " + params.assetId);
    }
    if (!TEXT_ASSET_TYPES.has(type)) {
      throw new Error("Asset is not a text asset: " + params.assetId);
    }
    const filename = String(params.filename || asset.get("file.filename") || asset.get("name") || "asset.txt");
    const form = new FormData();
    form.append("filename", filename);
    form.append("file", new Blob([String(params.text || "")], { type: textMimeForAssetType(type) }), filename);
    const branchId =
      (window.config && window.config.self && window.config.self.branch && window.config.self.branch.id) ||
      (window.config && window.config.branch && window.config.branch.id);
    if (branchId) form.append("branchId", String(branchId));
    const headers = {};
    const accessToken = window.editor.api.globals.accessToken;
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    const response = await fetch("/api/assets/" + encodeURIComponent(String(asset.get("id"))), {
      method: "PUT",
      headers,
      body: form
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new Error(body.error || "Failed to update script asset.");
    }

    let scripts = {};
    let parsed = false;
    if (type === "script" && window.editor && typeof window.editor.call === "function") {
      const parseResult = await new Promise((resolve, reject) => {
        window.editor.call("scripts:parse", asset.observer, (error, data) => {
          if (error) reject(new Error(String(error)));
          else resolve(data || {});
        });
      });
      scripts = parseResult.scripts || {};
      parsed = true;
    }
    return {
      assetId: String(asset.get("id")),
      filename,
      parsed,
      scripts,
      response: body
    };
  }

  function writeScriptText(params) {
    return withWorkspaceMutationSuppression(() => writeAssetTextInner(params, true));
  }

  function writeAssetText(params) {
    return withWorkspaceMutationSuppression(() => writeAssetTextInner(params, false));
  }

  function createDataAsset(params) {
    return withWorkspaceMutationSuppression(async () => {
      if (!window.editor || !window.editor.api || !window.editor.api.globals) {
        throw new Error("Workspace operations require a ready PlayCanvas Editor target.");
      }
      const type = String(params.type || "");
      if (!DATA_JSON_ASSET_TYPES.has(type)) {
        throw new Error("Unsupported structured JSON asset type: " + type);
      }
      const name = String(params.name || "New Asset");
      const assets = window.editor.api.globals.assets;
      const folderResult = await resolveFolder(assets, params);
      const defaultData = window.editor.api.globals.schema?.assets?.getDefaultData?.(type) || {};
      const incomingData = params.data && typeof params.data === "object" && !Array.isArray(params.data)
        ? params.data
        : {};
      const mergedData = { ...defaultData, ...incomingData };
      const asset = await assets.upload(
        {
          name,
          type,
          folder: folderResult.folder || undefined,
          preload: params.preload !== false,
          tags: Array.isArray(params.tags) ? params.tags : [],
          data: mergedData
        },
        null
      );
      if (asset && typeof asset.set === "function") {
        if (Array.isArray(params.tags)) asset.set("tags", params.tags);
        if (typeof params.preload === "boolean") asset.set("preload", params.preload);
        for (const [key, value] of Object.entries(incomingData)) {
          asset.set("data." + key, value);
        }
      }
      return {
        asset: readAsset(asset),
        createdFolders: folderResult.created.map(readAsset)
      };
    });
  }

  function patchAssetData(params) {
    return withWorkspaceMutationSuppression(async () => {
      const asset = requireEditorAsset(params.assetId);
      const type = String(asset.get("type") || "");
      if (!DATA_JSON_ASSET_TYPES.has(type)) {
        throw new Error("Asset is not a structured JSON asset: " + params.assetId);
      }
      if (typeof params.name === "string" && params.name && params.name !== asset.get("name")) {
        await new Promise((resolve, reject) => {
          const error = window.editor.call("assets:rename", asset.observer, params.name, (callbackError) => {
            if (callbackError) reject(new Error(String(callbackError)));
            else resolve();
          });
          if (error) reject(new Error(String(error)));
        });
      }
      if (Object.prototype.hasOwnProperty.call(params, "folder")) {
        const assets = window.editor.api.globals.assets;
        const folderResult = await resolveFolder(assets, params);
        if (typeof window.editor.call === "function") {
          const error = window.editor.call(
            "assets:fs:move",
            [asset.observer],
            folderResult.folder ? folderResult.folder.observer : null
          );
          if (error) throw new Error(String(error));
        }
      }
      if (typeof params.preload === "boolean") asset.set("preload", params.preload);
      if (Array.isArray(params.tags)) asset.set("tags", params.tags);
      for (const path of Array.isArray(params.unsets) ? params.unsets : []) {
        if (typeof asset.unset === "function") asset.unset("data." + path);
        else if (asset.observer && typeof asset.observer.unset === "function") asset.observer.unset("data." + path);
      }
      for (const change of Array.isArray(params.sets) ? params.sets : []) {
        if (change && typeof change.path === "string") {
          asset.set("data." + change.path, change.value);
        }
      }
      return { asset: readAsset(asset) };
    });
  }

  function deleteAssets(params) {
    return withWorkspaceMutationSuppression(async () => {
      if (!window.editor || !window.editor.api || !window.editor.api.globals) {
        throw new Error("Workspace operations require a ready PlayCanvas Editor target.");
      }
      const assets = window.editor.api.globals.assets;
      const ids = Array.isArray(params.assetIds) ? params.assetIds : [params.assetId];
      const found = [];
      const deletedIds = [];
      for (const rawId of ids) {
        if (rawId === undefined || rawId === null) continue;
        const asset = assets.get(Number(rawId));
        if (asset) {
          found.push(asset);
          deletedIds.push(String(asset.get("id")));
        }
      }
      if (!found.length) return { deletedIds: [] };
      if (typeof assets.delete === "function") {
        await assets.delete(found);
      } else if (typeof window.editor.call === "function") {
        window.editor.call("assets:delete", found.map((item) => item.observer || item));
      } else {
        throw new Error("Editor assets delete API is unavailable.");
      }
      return { deletedIds };
    });
  }

  async function readScene(params) {
    if (!window.editor || !window.editor.api || !window.editor.api.globals) {
      throw new Error("Scene operations require a ready PlayCanvas Editor target.");
    }
    const requestedId = String(params.sceneId || getActiveSceneId() || "");
    if (!requestedId) throw new Error("sceneId is required.");
    const activeId = getActiveSceneId();
    if (activeId && requestedId === activeId) {
      const activeScene = readActiveScene();
      if (activeScene) return activeScene;
    }
    if (typeof window.editor.call !== "function") {
      throw new Error("Editor scenes:get method is unavailable.");
    }
    const data = await new Promise((resolve, reject) => {
      window.editor.call("scenes:get", requestedId, (error, sceneData) => {
        if (error) reject(new Error(typeof error === "string" ? error : JSON.stringify(error)));
        else resolve(sceneData);
      });
    });
    if (!data || typeof data !== "object") {
      throw new Error("Scene not found: " + requestedId);
    }
    return {
      id: String(data.id || requestedId),
      name: String(data.name || "Scene"),
      active: false,
      modified: data.modified ? String(data.modified) : null,
      settings: clonePlainJson(data.settings) || {},
      entities: clonePlainJson(data.entities) || {}
    };
  }

  function patchScene(params) {
    return withWorkspaceMutationSuppression(async () => {
      const globals = window.editor && window.editor.api && window.editor.api.globals;
      if (!globals || !globals.entities || !globals.entities.root) {
        throw new Error("Active scene is not loaded in the PlayCanvas Editor.");
      }
      const activeId = getActiveSceneId();
      if (params.sceneId && activeId && String(params.sceneId) !== activeId) {
        throw new Error(`Scene ${params.sceneId} is not active in the Editor (active: ${activeId}).`);
      }
      if (typeof params.name === "string" && params.name.trim()) {
        const nextName = params.name.trim();
        const currentRealtimeScene = globals.realtime && globals.realtime.scenes && globals.realtime.scenes.current;
        if (currentRealtimeScene && currentRealtimeScene.data && typeof window.editor.call === "function") {
          const oldName = currentRealtimeScene.data.name || "";
          if (oldName !== nextName) {
            window.editor.call("realtime:scene:op", { p: ["name"], od: oldName, oi: nextName });
            if (typeof window.editor.emit === "function") window.editor.emit("scene:name", nextName);
          }
        }
        if (window.config && window.config.scene) window.config.scene.name = nextName;
      }
      const entities = globals.entities;

      for (const item of Array.isArray(params.creates) ? params.creates : []) {
        if (!item || !item.entity) continue;
        const data = { ...item.entity, children: [] };
        if (typeof data.parent === "string") {
          const parent = entities.get(data.parent);
          if (!parent) throw new Error("Parent entity not found: " + data.parent);
          data.parent = parent;
        } else if (!data.parent) {
          data.parent = entities.root;
        }
        const options = { history: true, select: false };
        if (Number.isInteger(item.index) && item.index >= 0) options.index = item.index;
        const created = entities.create(data, options);
        if (!created) throw new Error("Failed to create entity " + (data.resource_id || data.name || ""));
      }

      for (const move of Array.isArray(params.reparents) ? params.reparents : []) {
        const entity = entities.get(move.id);
        const parent = entities.get(move.parent);
        if (!entity || !parent) continue;
        if (typeof entity.reparent === "function") {
          entity.reparent(parent, move.index, { history: true, preserveTransform: false });
        } else if (typeof entities.reparent === "function") {
          await entities.reparent([{ entity, parent, index: move.index }], {
            history: true,
            preserveTransform: false
          });
        }
      }

      for (const update of Array.isArray(params.updates) ? params.updates : []) {
        const entity = entities.get(update.id);
        if (!entity) continue;
        for (const comp of Array.isArray(update.removedComponents) ? update.removedComponents : []) {
          if (entity.get("components." + comp)) entity.removeComponent(comp);
        }
        if (update.addedComponents && typeof update.addedComponents === "object") {
          for (const [comp, compData] of Object.entries(update.addedComponents)) {
            if (entity.get("components." + comp)) entity.set("components." + comp, compData || {});
            else entity.addComponent(comp, compData || {});
          }
        }
        for (const path of Array.isArray(update.unsets) ? update.unsets : []) {
          if (typeof entity.unset === "function") entity.unset(path);
          else if (entity.observer && typeof entity.observer.unset === "function") entity.observer.unset(path);
        }
        for (const change of Array.isArray(update.sets) ? update.sets : []) {
          if (change && typeof change.path === "string") entity.set(change.path, change.value);
        }
      }

      const deleteIds = Array.isArray(params.deletes) ? params.deletes : [];
      if (deleteIds.length) {
        const toDelete = deleteIds.map((id) => entities.get(id)).filter(Boolean);
        if (toDelete.length) {
          if (typeof entities.delete === "function") await entities.delete(toDelete);
          else for (const entity of toDelete) entities.remove(entity);
        }
      }

      const sceneSettings = globals.settings && globals.settings.scene;
      if (sceneSettings) {
        for (const path of Array.isArray(params.settingsUnsets) ? params.settingsUnsets : []) {
          if (typeof sceneSettings.unset === "function") sceneSettings.unset(path);
          else if (sceneSettings.observer && typeof sceneSettings.observer.unset === "function") sceneSettings.observer.unset(path);
        }
        for (const change of Array.isArray(params.settingsSets) ? params.settingsSets : []) {
          if (change && typeof change.path === "string") sceneSettings.set(change.path, change.value);
        }
      }

      return { scene: readActiveScene() };
    });
  }

  function plainAssetJson(asset) {
    if (!asset) return null;
    if (typeof asset.json === "function") return asset.json();
    if (asset.observer && typeof asset.observer.json === "function") return asset.observer.json();
    return null;
  }

  function collectAssetReferences(assets, value, ids, depth = 0) {
    if (!value || typeof value !== "object" || depth > 100) return;
    for (const [key, child] of Object.entries(value)) {
      if (["id", "path", "uniqueId", "scope", "testTemplate"].includes(key)) continue;
      if (Number.isInteger(child)) {
        const referenced = assets.get(Number(child));
        const id = String(child);
        if (referenced && !ids.has(id)) {
          ids.add(id);
          collectAssetReferences(assets, plainAssetJson(referenced), ids, depth + 1);
        }
      } else if (child && typeof child === "object") {
        collectAssetReferences(assets, child, ids, depth + 1);
      }
    }
  }

  function templateScriptNames(templateData) {
    const names = new Set();
    for (const entity of Object.values((templateData && templateData.entities) || {})) {
      const scripts = entity && entity.components && entity.components.script &&
        entity.components.script.scripts;
      for (const name of Object.keys(scripts || {})) names.add(name);
    }
    return [...names];
  }

  function templateChildren(templateData) {
    const ids = new Set();
    for (const entity of Object.values((templateData && templateData.entities) || {})) {
      const attributes = entity && entity.components && entity.components.script &&
        entity.components.script.scripts &&
        entity.components.script.scripts.sdsTinyRootHandler &&
        entity.components.script.scripts.sdsTinyRootHandler.attributes;
      if (attributes && attributes.type === "testTemplate" && Number.isInteger(attributes.testTemplate)) {
        ids.add(String(attributes.testTemplate));
      }
    }
    return [...ids];
  }

  function collectTemplateDependencies(params) {
    if (!window.editor || !window.editor.api || !window.editor.api.globals) {
      throw new Error("Template builds require a ready PlayCanvas Editor target.");
    }
    const assets = window.editor.api.globals.assets;
    const template = assets.get(Number(params.assetId));
    if (!template || template.get("type") !== "template") {
      throw new Error("Template asset not found: " + params.assetId);
    }
    const templateJson = plainAssetJson(template);
    if (!templateJson || !templateJson.data) {
      throw new Error("Template asset has no serializable data: " + params.assetId);
    }

    const ids = new Set();
    collectAssetReferences(assets, templateJson.data, ids);
    const scripts = [];
    for (const name of templateScriptNames(templateJson.data)) {
      const scriptAsset =
        (typeof assets.getAssetForScript === "function" && assets.getAssetForScript(name)) ||
        (window.editor.assets && typeof window.editor.assets.getAssetForScript === "function" &&
          window.editor.assets.getAssetForScript(name)) ||
        assets.list().find((asset) =>
          asset.get("type") === "script" &&
          (asset.get("name") === name || asset.get("data.scripts." + name) !== undefined)
        );
      if (!scriptAsset) continue;
      const scriptJson = plainAssetJson(scriptAsset);
      const filename = scriptJson && scriptJson.file && scriptJson.file.filename;
      if (
        name.startsWith("sds") ||
        String(filename || (scriptJson && scriptJson.name) || "").startsWith("sds")
      ) continue;
      ids.add(String(scriptAsset.get("id")));
      scripts.push({ name, assetId: String(scriptAsset.get("id")) });
    }

    return {
      template: templateJson,
      assets: [...ids].map((id) => plainAssetJson(assets.get(Number(id)))).filter(Boolean),
      scripts,
      childTemplateIds: templateChildren(templateJson.data),
      projectUrl: window.config && window.config.project && window.config.project.id
        ? "https://playcanvas.com/project/" + window.config.project.id + "/overview"
        : null,
      sceneUrl: location.href
    };
  }

  function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function daemonRequest(path, method, body, timeoutMs = 15000) {
    const id = "daemon-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        daemonWaiters.delete(id);
        reject(new Error("No response from the local pcbridge daemon."));
      }, timeoutMs);
      daemonWaiters.set(id, { resolve, reject, timer });
      window.postMessage({
        channel: CHANNEL,
        side: "main",
        type: "daemon-request",
        id,
        path,
        method,
        body: body || {}
      }, "*");
    });
  }

  function selectedAssetStateFromEditor() {
    if (!window.editor) return { known: false, asset: null };
    try {
      const items = window.editor.call && window.editor.call("selector:items");
      if (Array.isArray(items)) return { known: true, asset: items[0] || null };
    } catch {
      // Fall through to the public selection API.
    }
    const selection = window.editor.api && window.editor.api.globals &&
      window.editor.api.globals.selection;
    const items = selection && (
      (Array.isArray(selection.items) && selection.items) ||
      (typeof selection.list === "function" && selection.list()) ||
      (typeof selection.get === "function" && selection.get())
    );
    return Array.isArray(items)
      ? { known: true, asset: items[0] || null }
      : { known: false, asset: null };
  }

  function destroyBuilderPanel() {
    if (builderPanel && typeof builderPanel.destroy === "function") builderPanel.destroy();
    builderPanel = null;
    selectedTemplateId = null;
    selectedTemplateAsset = null;
  }

  function builderPanelIsAttached(layout) {
    if (!builderPanel || builderPanel.destroyed === true) return false;
    if (builderPanel.dom && typeof builderPanel.dom.isConnected === "boolean") {
      return builderPanel.dom.isConnected;
    }
    if ("parent" in builderPanel) return builderPanel.parent === layout;
    return true;
  }

  function appendRow(pcui, container, labelText, control) {
    const row = new pcui.Container();
    row.flex = true;
    row.flexDirection = "row";
    row.append(new pcui.Label({ text: labelText }));
    row.append(control);
    container.append(row);
  }

  function showBuilderPanel(asset) {
    const type = asset && typeof asset.get === "function" ? asset.get("type") : null;
    const id = asset && typeof asset.get === "function" ? String(asset.get("id")) : null;
    if (type !== "template" || !id) {
      destroyBuilderPanel();
      return;
    }
    const pcui = window.pcui;
    const layout = window.editor && window.editor.call && window.editor.call("layout.attributes");
    if (!pcui || !pcui.Container || !pcui.Button || !pcui.Label || !pcui.TextInput || !layout) return;
    if (builderPanel && selectedTemplateId === id && builderPanelIsAttached(layout)) return;
    destroyBuilderPanel();

    const projectId = window.config && window.config.project && window.config.project.id
      ? String(window.config.project.id)
      : "project";
    const suffixKey = `pcbridge:builder:${id}:suffix`;
    const prefixKey = `pcbridge:builder:${projectId}:prefix`;
    const container = new pcui.Container();
    container.flex = true;
    container.flexDirection = "column";
    if (container.class && typeof container.class.add === "function") {
      container.class.add("pcbridge-tiny-builder");
    }
    container.append(new pcui.Label({ text: "pcbridge Tiny Builder" }));
    const prefixInput = new pcui.TextInput({ value: localStorage.getItem(prefixKey) || "" });
    const suffixInput = new pcui.TextInput({ value: localStorage.getItem(suffixKey) || "" });
    if (typeof prefixInput.on === "function") {
      prefixInput.on("change", () => localStorage.setItem(prefixKey, String(prefixInput.value || "")));
      suffixInput.on("change", () => localStorage.setItem(suffixKey, String(suffixInput.value || "")));
    }
    appendRow(pcui, container, "上传目录", prefixInput);
    appendRow(pcui, container, "文件后缀", suffixInput);
    const pathLabel = new pcui.Label({ text: localStorage.getItem(`pcbridge:builder:${id}:url`) || "" });
    appendRow(pcui, container, "引用路径", pathLabel);
    const buildButton = new pcui.Button({ text: "构建并上传到 S3" });
    const copyButton = new pcui.Button({ text: "复制引用路径" });
    const logLabel = new pcui.Label({ text: "从项目 .env 或工作区 .env 读取 S3 配置" });
    copyButton.on("click", () => {
      if (pathLabel.text) void navigator.clipboard.writeText(pathLabel.text);
    });
    buildButton.on("click", async () => {
      buildButton.enabled = false;
      try {
        let job = await daemonRequest("/builder/jobs", "POST", {
          templateAssetId: id,
          suffix: String(suffixInput.value || ""),
          prefix: String(prefixInput.value || "")
        });
        while (job && job.state !== "completed" && job.state !== "error") {
          logLabel.text = job.message || job.state;
          await new Promise((resolve) => setTimeout(resolve, 1000));
          job = await daemonRequest(
            "/builder/jobs/" + encodeURIComponent(job.id),
            "GET",
            {},
            30000
          );
        }
        if (!job || job.state === "error") {
          throw new Error((job && job.error) || "Template build failed.");
        }
        pathLabel.text = job.publicUrl || "";
        localStorage.setItem(`pcbridge:builder:${id}:url`, pathLabel.text);
        logLabel.text = job.message || "上传完成";
      } catch (error) {
        logLabel.text = "构建失败: " + String((error && error.message) || error);
      } finally {
        buildButton.enabled = true;
      }
    });
    container.append(buildButton);
    container.append(copyButton);
    container.append(logLabel);
    layout.append(container);
    builderPanel = container;
    selectedTemplateId = id;
    selectedTemplateAsset = asset;
  }

  function scheduleBuilderPanelRefresh(asset) {
    if (builderRefreshTimer !== null) clearTimeout(builderRefreshTimer);
    builderRefreshTimer = setTimeout(() => {
      builderRefreshTimer = null;
      const selection = selectedAssetStateFromEditor();
      if (selection.known) showBuilderPanel(selection.asset);
      else showBuilderPanel(asset || selectedTemplateAsset);
    }, 150);
  }

  function installBuilderPanel() {
    if (!location.pathname.startsWith("/editor") || typeof setInterval !== "function") return;
    let subscribed = false;
    setInterval(() => {
      if (!window.editor || !window.editor.api || !window.editor.api.globals) return;
      if (!subscribed) {
        subscribed = true;
        const refresh = (asset) => scheduleBuilderPanelRefresh(asset);
        const legacy = window.editor.selection;
        if (legacy && typeof legacy.on === "function") {
          legacy.on("add", refresh);
          legacy.on("remove", () => refresh());
        }
        const selection = window.editor.api.globals.selection;
        if (selection && typeof selection.on === "function") {
          selection.on("add", refresh);
          selection.on("remove", () => refresh());
          selection.on("change", () => refresh());
        }
      }
      const selection = selectedAssetStateFromEditor();
      if (selection.known) showBuilderPanel(selection.asset);
      else if (selectedTemplateAsset) showBuilderPanel(selectedTemplateAsset);
    }, 1000);
  }

  async function evalInPage(params, requestId) {
    const timeoutMs = Number(params.timeoutMs || 15000);
    const command = {
      id: requestId,
      method: "bridge:eval",
      args: params.args || {},
      params,
      timeoutMs
    };

    const context = {
      page: window,
      window,
      document,
      editor: window.editor,
      pc: window.pc,
      pcui: window.pcui,
      runtimeApp: getRuntimeApp(),
      command,
      serialize
    };

    const fn = new window.Function(
      "ctx",
      `
        const page = ctx.page;
        const window = ctx.window;
        const document = ctx.document;
        const editor = ctx.editor;
        const pc = ctx.pc;
        const pcui = ctx.pcui;
        const runtimeApp = ctx.runtimeApp;
        const command = ctx.command;
        const serialize = ctx.serialize;
        return (async () => {
          ${String(params.code || "")}
        })();
      `
    );

    return serialize(await withTimeout(fn(context), timeoutMs), params.serializeOptions);
  }

  function encodeCanvas(canvas, params, source) {
    const maxWidth = Number(params.maxWidth || 1200);
    let outWidth = canvas.width;
    let outHeight = canvas.height;
    if (maxWidth > 0 && canvas.width > maxWidth) {
      outWidth = maxWidth;
      outHeight = Math.round(canvas.height * (maxWidth / canvas.width));
    }

    const dstCanvas = document.createElement("canvas");
    dstCanvas.width = outWidth;
    dstCanvas.height = outHeight;
    dstCanvas.getContext("2d").drawImage(canvas, 0, 0, outWidth, outHeight);

    const mime = params.format === "webp" ? "image/webp" : "image/png";
    const dataUrl = dstCanvas.toDataURL(mime, Number(params.quality || 0.85));
    return {
      mime,
      width: outWidth,
      height: outHeight,
      source,
      base64: dataUrl.split(",")[1]
    };
  }

  function canvasFromWebglPixels(gl, width, height) {
    const pixels = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const flipped = new Uint8Array(width * height * 4);
    const rowSize = width * 4;
    for (let y = 0; y < height; y += 1) {
      flipped.set(
        pixels.subarray((height - 1 - y) * rowSize, (height - y) * rowSize),
        y * rowSize
      );
    }

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = width;
    srcCanvas.height = height;
    srcCanvas
      .getContext("2d")
      .putImageData(new ImageData(new Uint8ClampedArray(flipped.buffer), width, height), 0, 0);
    return srcCanvas;
  }

  function captureEditorViewport(params) {
    const app = window.editor.call("viewport:app");
    if (!app) throw new Error("Viewport app not found.");
    const device = app.graphicsDevice;
    const gl = device && device.gl;
    if (!gl) throw new Error("WebGL context not found.");

    window.editor.call("viewport:render");
    app.tick();

    const width = device.width;
    const height = device.height;
    const srcCanvas = canvasFromWebglPixels(gl, width, height);
    return encodeCanvas(srcCanvas, params, "editor-viewport");
  }

  function getCanvasWebglContext(canvas) {
    const app = getRuntimeApp();
    const appCanvas = getPrimaryCanvas(app);
    if (appCanvas === canvas && app && app.graphicsDevice && app.graphicsDevice.gl) {
      return app.graphicsDevice.gl;
    }

    return (
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")
    );
  }

  function captureRuntimeCanvas(params) {
    const app = getRuntimeApp();
    const canvas = getPrimaryCanvas(app);
    if (!canvas) {
      throw new Error("PlayCanvas launch canvas not found.");
    }

    try {
      const gl = getCanvasWebglContext(canvas);
      if (gl && typeof gl.readPixels === "function") {
        const width =
          (app && app.graphicsDevice && app.graphicsDevice.width) ||
          gl.drawingBufferWidth ||
          canvas.width;
        const height =
          (app && app.graphicsDevice && app.graphicsDevice.height) ||
          gl.drawingBufferHeight ||
          canvas.height;
        const srcCanvas = canvasFromWebglPixels(gl, width, height);
        return encodeCanvas(srcCanvas, params, "launch-webgl");
      }
    } catch (error) {
      pushLog("warn", ["WebGL capture failed; falling back to canvas capture.", error], "pcbridge");
    }

    return encodeCanvas(canvas, params, "launch-canvas");
  }

  function captureViewport(params) {
    if (window.editor && typeof window.editor.call === "function") {
      return captureEditorViewport(params);
    }

    return captureRuntimeCanvas(params);
  }

  function getLogs(params) {
    const level = params.level ? String(params.level).toLowerCase() : null;
    const since = params.since === undefined || params.since === null || params.since === ""
      ? null
      : Number(params.since);
    const limit = Math.max(1, Math.min(Number(params.limit || 100), 500));
    let items = capturedLogs;

    if (level) {
      items = items.filter((entry) => entry.level === level);
    }
    if (since !== null && Number.isFinite(since)) {
      items = items.filter((entry) => entry.seq > since);
    }

    const total = items.length;
    const hasExplicitOffset =
      params.offset !== undefined && params.offset !== null && params.offset !== "";
    const offset = hasExplicitOffset
      ? Math.max(0, Number(params.offset || 0))
      : Math.max(0, total - limit);
    const page = items.slice(offset, offset + limit);

    return {
      items: page,
      total,
      offset,
      limit,
      hasMore: offset + page.length < total,
      nextSince: page.length ? page[page.length - 1].seq : since
    };
  }

  function clearLogs() {
    const affected = capturedLogs.length;
    capturedLogs.length = 0;
    return { affected };
  }

  async function uploadAssetInner(params) {
    if (!params.base64) throw new Error("base64 file content is required.");
    if (!params.name) throw new Error("name is required.");

    const assets = window.editor.api.globals.assets;
    const folderResult = await resolveFolder(assets, params);
    const blob = new Blob([bytesFromBase64(params.base64)], {
      type: params.mime || "application/octet-stream"
    });
    const uploadData = {
        name: params.name,
        folder: folderResult.folder || undefined,
        filename: params.filename || params.name,
        file: blob,
        preload: params.preload !== false
    };
    if (params.type) uploadData.type = params.type;
    const asset = await assets.upload(
      uploadData,
      null
    );
    return {
      asset: readAsset(asset),
      createdFolders: folderResult.created.map(readAsset)
    };
  }

  function uploadAsset(params) {
    return withWorkspaceMutationSuppression(() => uploadAssetInner(params));
  }

  function focusViewport(params) {
    const ids = Array.isArray(params.ids) && params.ids.length ? params.ids : [params.id];
    const entitiesApi = window.editor.api.globals.entities;
    const entities = ids.map((id) => entitiesApi.get(id)).filter(Boolean);
    if (!entities.length) {
      throw new Error("No valid entities found.");
    }

    window.editor.api.globals.selection.set(entities, { history: true });

    const camera = window.editor.call("camera:current");
    if (!camera) {
      throw new Error("Could not retrieve current camera.");
    }
    const aabb = window.editor.call("selection:aabb");
    if (!aabb) {
      throw new Error("Could not calculate selection bounds.");
    }

    let distance = Math.max(aabb.halfExtents.x, aabb.halfExtents.y, aabb.halfExtents.z);
    distance /= Math.tan(0.5 * camera.camera.fov * Math.PI / 180.0);
    distance = distance * 1.1 + 1;

    if (params.view) {
      const views = {
        top: [-90, 0],
        bottom: [90, 0],
        front: [0, 0],
        back: [0, 180],
        left: [0, -90],
        right: [0, 90],
        perspective: [-25, 45]
      };
      const angles = views[params.view];
      if (angles) {
        camera.setEulerAngles(angles[0], angles[1], 0);
      }
    } else if (
      (params.yaw !== undefined && params.yaw !== null) ||
      (params.pitch !== undefined && params.pitch !== null)
    ) {
      const yaw = params.yaw ?? 45;
      const pitch = params.pitch ?? -25;
      camera.setEulerAngles(pitch, yaw, 0);
    }

    window.editor.call("camera:focus", aabb.center, distance);
    return {
      focused: ids,
      view: params.view || null,
      yaw: params.yaw ?? null,
      pitch: params.pitch ?? null
    };
  }

  async function callMethod(method, params, requestId) {
    if (method === "bridge:importJob") {
      if (getTargetKind() !== "editor" || !window.config?.selfhost || !window.editor?.api?.globals) {
        throw Object.assign(new Error("Selfhost Editor required"), { code: "SELFHOST_EDITOR_REQUIRED" });
      }
      if (!window.editor.methods?.has("assets:import:request")) {
        throw Object.assign(new Error("Refresh the upgraded selfhost Editor before importing"), { code: "PROCESSING_EDITOR_UNSUPPORTED" });
      }
      const api = window.editor.api.globals;
      const context = { projectId: api.projectId, branchId: api.branchId };
      const action = params.action;
      let path, verb = "GET", body;
      if (action === "list") path = `/jobs?projectId=${api.projectId}&branchId=${encodeURIComponent(api.branchId)}`;
      else if (action === "submit") {
        if (!/^\d+$/.test(params.assetId || "") || !["model", "texture"].includes(params.kind)) throw new Error("Invalid import submission");
        path = `/${params.assetId}/${params.kind === "texture" ? "texture" : "reimport"}`;
        verb = "POST"; body = { ...context, options: params.options || {} };
      } else if (["status", "cancel", "retry"].includes(action) && /^[a-zA-Z0-9-]{1,100}$/.test(params.jobId || "")) {
        path = `/jobs/${params.jobId}${action === "status" ? "" : `/${action}`}`;
        if (action !== "status") { verb = "POST"; body = {}; }
      } else throw new Error("Invalid import action");
      return window.editor.call("assets:import:request", path, verb, body);
    }
    if (method === "bridge:ping") return { pong: true, href: location.href };
    if (method === "bridge:describeTarget") return describeTarget();
    if (method === "bridge:eval") return evalInPage(params || {}, requestId);
    if (method === "bridge:captureViewport") return captureViewport(params || {});
    if (method === "bridge:getLogs") return getLogs(params || {});
    if (method === "bridge:clearLogs") return clearLogs();
    if (method === "bridge:uploadAsset") return uploadAsset(params || {});
    if (method === "bridge:focusViewport") return focusViewport(params || {});
    if (method === "bridge:workspaceSnapshot") {
      installWorkspaceEvents();
      return workspaceSnapshot();
    }
    if (method === "bridge:collectTemplateDependencies") return collectTemplateDependencies(params || {});
    if (method === "bridge:readAssetText") return readAssetText(params || {});
    if (method === "bridge:readAssetFile") return readAssetFile(params || {});
    if (method === "bridge:readAssetResource") return readAssetResource(params || {});
    if (method === "bridge:writeAssetFile") return writeAssetFile(params || {});
    if (method === "bridge:renameAsset") return renameAsset(params || {});
    if (method === "bridge:writeScriptText") return writeScriptText(params || {});
    if (method === "bridge:writeAssetText") return writeAssetText(params || {});
    if (method === "bridge:createDataAsset") return createDataAsset(params || {});
    if (method === "bridge:patchAssetData") return patchAssetData(params || {});
    if (method === "bridge:deleteAssets") return deleteAssets(params || {});
    if (method === "bridge:readScene") return readScene(params || {});
    if (method === "bridge:patchScene") return patchScene(params || {});
    throw new Error(`Unknown bridge method: ${method}`);
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.side !== "isolated") return;
    if (message.type === "daemon-response" && message.id) {
      const waiter = daemonWaiters.get(message.id);
      if (!waiter) return;
      daemonWaiters.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.data);
      else waiter.reject(message.error || new Error("Local daemon request failed."));
      return;
    }
    if (message.type !== "request") return;

    const startedAt = performance.now();
    try {
      const data = await callMethod(message.method, message.params || {}, message.id);
      window.postMessage(
        {
          channel: CHANNEL,
          side: "main",
          type: "response",
          id: message.id,
          ok: true,
          data,
          meta: { durationMs: Math.round(performance.now() - startedAt) }
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          channel: CHANNEL,
          side: "main",
          type: "response",
          id: message.id,
          ok: false,
          error: serialize(error)
        },
        "*"
      );
    }
  });

  installBuilderPanel();
  window.postMessage({ channel: CHANNEL, side: "main", type: "ready" }, "*");
})();
