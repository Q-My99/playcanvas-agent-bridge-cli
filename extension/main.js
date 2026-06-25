(() => {
  "use strict";

  const CHANNEL = "playcanvas-agent-bridge";
  if (window.__pcbridgeMainWorld) return;
  window.__pcbridgeMainWorld = true;

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

  function describeTarget() {
    const config = window.config || {};
    const ready = Boolean(window.editor && window.editor.api && window.editor.api.globals);
    const matchScene = location.href.match(/\/editor\/scene\/([^/?#]+)/);
    return {
      url: location.href,
      title: document.title || "",
      ready,
      projectId: config.project && config.project.id ? String(config.project.id) : undefined,
      sceneId:
        (config.scene && config.scene.id ? String(config.scene.id) : undefined) ||
        (matchScene ? matchScene[1] : undefined),
      branchId:
        (config.self && config.self.branch && config.self.branch.id
          ? String(config.self.branch.id)
          : undefined) ||
        (config.branch && config.branch.id ? String(config.branch.id) : undefined)
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

  function captureViewport(params) {
    const app = window.editor.call("viewport:app");
    if (!app) throw new Error("Viewport app not found.");
    const device = app.graphicsDevice;
    const gl = device && device.gl;
    if (!gl) throw new Error("WebGL context not found.");

    window.editor.call("viewport:render");
    app.tick();

    const width = device.width;
    const height = device.height;
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

    const maxWidth = Number(params.maxWidth || 1200);
    let outWidth = width;
    let outHeight = height;
    if (maxWidth > 0 && width > maxWidth) {
      outWidth = maxWidth;
      outHeight = Math.round(height * (maxWidth / width));
    }

    const dstCanvas = document.createElement("canvas");
    dstCanvas.width = outWidth;
    dstCanvas.height = outHeight;
    dstCanvas.getContext("2d").drawImage(srcCanvas, 0, 0, outWidth, outHeight);

    const mime = params.format === "webp" ? "image/webp" : "image/png";
    const dataUrl = dstCanvas.toDataURL(mime, Number(params.quality || 0.85));
    return {
      mime,
      width: outWidth,
      height: outHeight,
      base64: dataUrl.split(",")[1]
    };
  }

  async function callMethod(method, params, requestId) {
    if (method === "bridge:ping") return { pong: true, href: location.href };
    if (method === "bridge:describeTarget") return describeTarget();
    if (method === "bridge:eval") return evalInPage(params || {}, requestId);
    if (method === "bridge:captureViewport") return captureViewport(params || {});
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
