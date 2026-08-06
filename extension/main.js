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
    if (location.pathname.startsWith("/editor")) return "editor";
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
    return {
      id: get("id"),
      name: get("name"),
      type: get("type"),
      path,
      folder: Array.isArray(path) && path.length ? path[path.length - 1] : null,
      tags: get("tags") || [],
      file: get("file") || null
    };
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

  function workspaceSnapshot() {
    if (!window.editor || !window.editor.api || !window.editor.api.globals) {
      throw new Error("Workspace operations require a ready PlayCanvas Editor target.");
    }
    return {
      assets: window.editor.api.globals.assets.list().map(readAsset)
    };
  }

  async function readAssetText(params) {
    const asset = requireEditorAsset(params.assetId);
    if (asset.get("type") !== "script") {
      throw new Error("Asset is not a script: " + params.assetId);
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

  async function writeAssetFile(params) {
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

  async function writeScriptText(params) {
    const asset = requireEditorAsset(params.assetId);
    if (asset.get("type") !== "script") {
      throw new Error("Asset is not a script: " + params.assetId);
    }
    const filename = asset.get("file.filename") || asset.get("name");
    const form = new FormData();
    form.append("filename", filename);
    form.append("file", new Blob([String(params.text || "")], { type: "text/javascript" }), filename);
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

    const parseResult = await new Promise((resolve, reject) => {
      window.editor.call("scripts:parse", asset.observer, (error, data) => {
        if (error) reject(new Error(String(error)));
        else resolve(data || {});
      });
    });
    return {
      assetId: String(asset.get("id")),
      filename,
      parsed: true,
      scripts: parseResult.scripts || {},
      response: body
    };
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

  async function uploadAsset(params) {
    if (!params.base64) throw new Error("base64 file content is required.");
    if (!params.name) throw new Error("name is required.");
    if (!params.type) throw new Error("type is required.");

    const assets = window.editor.api.globals.assets;
    const folderResult = await resolveFolder(assets, params);
    const blob = new Blob([bytesFromBase64(params.base64)], {
      type: params.mime || "application/octet-stream"
    });
    const asset = await assets.upload(
      {
        name: params.name,
        type: params.type,
        folder: folderResult.folder || undefined,
        filename: params.filename || params.name,
        file: blob,
        preload: params.preload !== false
      },
      null
    );
    return {
      asset: readAsset(asset),
      createdFolders: folderResult.created.map(readAsset)
    };
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
    if (method === "bridge:ping") return { pong: true, href: location.href };
    if (method === "bridge:describeTarget") return describeTarget();
    if (method === "bridge:eval") return evalInPage(params || {}, requestId);
    if (method === "bridge:captureViewport") return captureViewport(params || {});
    if (method === "bridge:getLogs") return getLogs(params || {});
    if (method === "bridge:clearLogs") return clearLogs();
    if (method === "bridge:uploadAsset") return uploadAsset(params || {});
    if (method === "bridge:focusViewport") return focusViewport(params || {});
    if (method === "bridge:workspaceSnapshot") return workspaceSnapshot();
    if (method === "bridge:collectTemplateDependencies") return collectTemplateDependencies(params || {});
    if (method === "bridge:readAssetText") return readAssetText(params || {});
    if (method === "bridge:readAssetFile") return readAssetFile(params || {});
    if (method === "bridge:readAssetResource") return readAssetResource(params || {});
    if (method === "bridge:writeAssetFile") return writeAssetFile(params || {});
    if (method === "bridge:writeScriptText") return writeScriptText(params || {});
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
