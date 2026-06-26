(() => {
  "use strict";

  const CHANNEL = "playcanvas-agent-bridge";
  if (window.__pcbridgeMainWorld) return;
  window.__pcbridgeMainWorld = true;

  const MAX_LOGS = 500;
  const capturedLogs = [];
  let nextLogSeq = 1;

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
        return {
          name: current.name,
          message: current.message,
          stack: current.stack
        };
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

  function getRuntimeApp() {
    try {
      if (
        window.pc &&
        window.pc.Application &&
        typeof window.pc.Application.getApplication === "function"
      ) {
        const app = window.pc.Application.getApplication();
        if (app) return app;
      }
    } catch {
      // Fall through to common global app locations.
    }

    if (window.app && window.app.graphicsDevice) return window.app;
    if (window.pc && window.pc.app && window.pc.app.graphicsDevice) return window.pc.app;
    return null;
  }

  function getPrimaryCanvas(app) {
    return (
      (app && app.graphicsDevice && app.graphicsDevice.canvas) ||
      (app && app.canvas) ||
      document.querySelector("canvas")
    );
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
    const app = getRuntimeApp();
    const canvasCount = document.querySelectorAll("canvas").length;
    const launchReady = kind === "launch" && document.readyState !== "loading";
    const ready = editorReady || launchReady;
    return {
      kind,
      url: location.href,
      title: document.title || "",
      ready,
      hasEditor: Boolean(window.editor),
      hasPc: Boolean(window.pc),
      hasRuntimeApp: Boolean(app),
      canvasCount,
      projectId: config.project && config.project.id ? String(config.project.id) : undefined,
      sceneId:
        (config.scene && config.scene.id ? String(config.scene.id) : undefined) ||
        getSceneIdFromUrl(),
      branchId:
        (config.self && config.self.branch && config.self.branch.id
          ? String(config.self.branch.id)
          : undefined) ||
        (config.branch && config.branch.id ? String(config.branch.id) : undefined)
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
        const command = ctx.command;
        const serialize = ctx.serialize;
        return (async () => {
          ${String(params.code || "")}
        })();
      `
    );

    return serialize(await withTimeout(fn(context), timeoutMs));
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
    throw new Error(`Unknown bridge method: ${method}`);
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.side !== "isolated") return;
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

  window.postMessage({ channel: CHANNEL, side: "main", type: "ready" }, "*");
})();
