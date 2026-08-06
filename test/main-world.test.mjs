import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const CHANNEL = "playcanvas-agent-bridge";

function canvas(id = "application-canvas") {
  return {
    id,
    width: 474,
    height: 958,
    getBoundingClientRect: () => ({ width: 474, height: 958 }),
  };
}

async function loadMainWorld({
  app,
  assetsApi,
  editorApp,
  editorLocation = false,
  exposeEditorApi = false,
  pcui,
  selectedAsset,
  visibilityState = "visible",
  splashVisible = false,
}) {
  const listeners = new Map();
  const messages = [];
  const primaryCanvas = canvas();
  const emptyApp = {
    graphicsDevice: { canvas: canvas("empty-canvas") },
    root: { children: [{ name: "Legacy scene" }] },
    scene: {},
    frame: 20,
    scripts: {},
  };
  const document = {
    readyState: "complete",
    visibilityState,
    title: "Launch test",
    querySelector(selector) {
      if (selector === "canvas") return primaryCanvas;
      if (splashVisible && selector === "#application-splash-wrapper") {
        return { getBoundingClientRect: () => ({ width: 100, height: 100 }) };
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "canvas" ? [primaryCanvas] : [];
    },
    createElement() {
      return canvas("");
    },
  };
  const location = editorLocation
    ? {
        hostname: "playcanvas.com",
        pathname: "/editor/scene/2558183",
        href: "https://playcanvas.com/editor/scene/2558183",
      }
    : {
        hostname: "launch.playcanvas.com",
        pathname: "/2558183",
        href: "https://launch.playcanvas.com/2558183",
      };
  const intervals = [];
  const storage = new Map();
  const window = {
    console: { debug() {}, log() {}, info() {}, warn() {}, error() {} },
    document,
    location,
    pc: {
      version: "2.21.3",
      AppBase: {
        getApplication(id) {
          return id === "application-canvas" ? app : app;
        },
      },
      Application: { getApplication: () => emptyApp },
    },
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    postMessage(message) {
      messages.push(message);
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    pcui,
  };
  if (editorApp || exposeEditorApi || selectedAsset) {
    window.editor = {
      ...(exposeEditorApi ? { api: { globals: assetsApi ? { assets: assetsApi } : {} } } : {}),
      ...(assetsApi ? { assets: assetsApi } : {}),
      call(method) {
        if (method === "viewport:app") return editorApp || app;
        if (method === "selector:items") {
          const asset = typeof selectedAsset === "function" ? selectedAsset() : selectedAsset;
          return asset ? [asset] : [];
        }
        if (method === "layout.attributes") return pcui && pcui.layout;
        return null;
      },
    };
  }
  window.window = window;
  const context = vm.createContext({
    window,
    document,
    location,
    console: window.console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval() {},
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    navigator: { clipboard: { writeText: async () => undefined } },
    URLSearchParams,
    Blob,
    FormData,
    ImageData: class ImageData {},
    Uint8Array,
    Uint8ClampedArray,
    WeakSet,
    Set,
    Map,
  });
  window.Function = vm.runInContext("Function", context);
  const source = await readFile(join(process.cwd(), "extension/main.js"), "utf8");
  vm.runInContext(source, context);

  async function callRaw(method, params = {}) {
    const id = `test-${messages.length}`;
    const event = {
      source: window,
      data: { channel: CHANNEL, side: "isolated", type: "request", id, method, params },
    };
    for (const listener of listeners.get("message") || []) await listener(event);
    const response = messages.find((message) => message.type === "response" && message.id === id);
    assert.ok(response, `missing response for ${method}`);
    return response;
  }

  async function call(method, params = {}) {
    const response = await callRaw(method, params);
    assert.equal(response.ok, true, JSON.stringify(response.error));
    return response.data;
  }

  return { call, callRaw, intervals, messages, window };
}

test("Launch target uses Engine V2 AppBase and reports a stalled hidden lifecycle", async () => {
  const runtime = await loadMainWorld({
    app: {
      graphicsDevice: { canvas: canvas() },
      root: { children: [] },
      scene: {},
      frame: 0,
      scripts: {},
    },
    visibilityState: "hidden",
  });
  const target = await runtime.call("bridge:describeTarget");
  assert.equal(target.ready, false);
  assert.equal(target.runtimeCreated, true);
  assert.equal(target.runtimeStarted, false);
  assert.equal(target.sceneLoaded, false);
  assert.equal(target.readinessMode, "heuristic");
  assert.equal(target.runtimeAppSource, "pc.AppBase.getApplication(application-canvas)");
  assert.deepEqual(Array.from(target.readinessBlockers), ["tab-hidden", "scene-not-loaded"]);
});

test("Launch Editor globals never bypass runtime lifecycle readiness", async () => {
  const runtime = await loadMainWorld({
    app: {
      graphicsDevice: { canvas: canvas() },
      root: { children: [] },
      scene: {},
      frame: 0,
      scripts: {},
    },
    exposeEditorApi: true,
  });
  const target = await runtime.call("bridge:describeTarget");
  assert.equal(target.hasEditor, true);
  assert.equal(target.ready, false);
  assert.equal(target.lifecycleReady, false);
});

test("loaded Launch reports lifecycle ready but remains target-not-ready in the background", async () => {
  const app = {
    graphicsDevice: { canvas: canvas() },
    root: { children: [{ name: "Scene" }] },
    scene: {},
    frame: 3,
    scripts: {},
  };
  const runtime = await loadMainWorld({ app, visibilityState: "hidden" });
  const target = await runtime.call("bridge:describeTarget");
  assert.equal(target.ready, false);
  assert.equal(target.lifecycleReady, true);
  assert.equal(target.rootChildCount, 1);
  assert.equal(target.runtimeFrame, 3);
  assert.equal(target.engineVersion, "2.21.3");
  assert.deepEqual(Array.from(target.readinessBlockers), ["tab-hidden"]);

  const truncated = await runtime.call("bridge:eval", {
    code: "return { nested: { a: { b: { c: 1 } } } };",
    serializeOptions: { maxDepth: 2 },
  });
  assert.equal(truncated.nested.a, "[MaxDepth Object]");

  const evaluated = await runtime.call("bridge:eval", {
    code: "return { childCount: runtimeApp.root.children.length, nested: { a: { b: { c: 1 } } } };",
    serializeOptions: { maxDepth: 8 },
  });
  assert.equal(evaluated.childCount, 1);
  assert.equal(evaluated.nested.a.b.c, 1);
});

test("visible Launch is ready after its scene is attached and one frame has run", async () => {
  const app = {
    graphicsDevice: { canvas: canvas(), contextLost: false },
    root: { children: [{ name: "Scene" }] },
    scene: {},
    frame: 1,
    scripts: { list: () => [] },
  };
  const runtime = await loadMainWorld({ app });
  const target = await runtime.call("bridge:describeTarget");
  assert.equal(target.ready, true);
  assert.equal(target.graphicsReady, true);
  assert.equal(target.sceneLoaded, true);
  assert.equal(target.runtimeStarted, true);
  assert.equal(target.scriptsReady, true);
  assert.equal(target.scriptTypeCount, 0);
});

test("Launch viewport app outranks a stale application-canvas registry result", async () => {
  const stale = {
    graphicsDevice: { canvas: canvas() },
    root: { children: [{ name: "Stale" }] },
    scene: {},
    frame: 99,
    scripts: {},
  };
  const current = {
    graphicsDevice: { canvas: canvas() },
    root: { children: [{ name: "Current" }] },
    scene: {},
    frame: 1,
    scripts: {},
  };
  const runtime = await loadMainWorld({ app: stale, editorApp: current });
  const target = await runtime.call("bridge:describeTarget");
  assert.equal(target.runtimeAppSource, "editor.call(viewport:app)");
  const evaluated = await runtime.call("bridge:eval", {
    code: "return runtimeApp.root.children[0].name;",
  });
  assert.equal(evaluated, "Current");
});

test("visible startup splash blocks Launch readiness", async () => {
  const runtime = await loadMainWorld({
    app: {
      graphicsDevice: { canvas: canvas() },
      root: { children: [{}] },
      scene: {},
      frame: 1,
      scripts: {},
    },
    splashVisible: true,
  });
  const target = await runtime.call("bridge:describeTarget");
  assert.equal(target.ready, false);
  assert.equal(target.splashVisible, true);
  assert.deepEqual(Array.from(target.readinessBlockers), ["splash-visible"]);
});

test("lost graphics context blocks Launch readiness", async () => {
  const runtime = await loadMainWorld({
    app: {
      graphicsDevice: { canvas: canvas(), contextLost: true },
      root: { children: [{}] },
      scene: {},
      frame: 2,
      scripts: {},
    },
  });
  const target = await runtime.call("bridge:describeTarget");
  assert.equal(target.ready, false);
  assert.equal(target.graphicsContextLost, true);
  assert.deepEqual(
    Array.from(target.readinessBlockers),
    ["graphics-context-lost", "scene-not-loaded"],
  );
});

test("eval preserves structured page error codes and details", async () => {
  const runtime = await loadMainWorld({
    app: {
      graphicsDevice: { canvas: canvas() },
      root: { children: [{}] },
      scene: {},
      frame: 1,
      scripts: {},
    },
  });
  const response = await runtime.callRaw("bridge:eval", {
    code: `
      const error = new Error("invalid script");
      error.code = "SCRIPT_PARSE_INVALID";
      error.details = { parserCompleted: true };
      throw error;
    `,
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "SCRIPT_PARSE_INVALID");
  assert.equal(response.error.details.parserCompleted, true);
});

test("Template dependency collection follows asset references and excludes sds scripts", async () => {
  const asset = (data) => ({
    get(path) {
      return path.split(".").reduce((value, key) => value && value[key], data);
    },
    json: () => structuredClone(data),
  });
  const values = new Map([
    [1, asset({
      id: 1,
      name: "Root Template",
      type: "template",
      data: {
        entities: {
          root: {
            components: {
              render: { material: 2 },
              script: {
                scripts: {
                  mover: { attributes: {} },
                  sdsWebOnly: { attributes: {} },
                  sdsTinyRootHandler: {
                    attributes: { type: "testTemplate", testTemplate: 9 },
                  },
                },
              },
            },
          },
        },
      },
    })],
    [2, asset({ id: 2, name: "Material", type: "material", data: { diffuseMap: 3 }, file: null })],
    [3, asset({
      id: 3,
      name: "Texture",
      type: "texture",
      data: {},
      file: { filename: "texture.png", hash: "abc", url: "/texture.png" },
    })],
    [4, asset({
      id: 4,
      name: "mover.js",
      type: "script",
      data: {},
      file: { filename: "mover.js", hash: "def", url: "/mover.js" },
    })],
    [5, asset({
      id: 5,
      name: "sdsWebOnly.js",
      type: "script",
      data: {},
      file: { filename: "sdsWebOnly.js", hash: "ghi", url: "/sds.js" },
    })],
    [9, asset({ id: 9, name: "Child", type: "template", data: { entities: {} }, file: null })],
  ]);
  const assetsApi = {
    get: (id) => values.get(Number(id)),
    list: () => [...values.values()],
    getAssetForScript(name) {
      if (name === "mover") return values.get(4);
      if (name === "sdsWebOnly") return values.get(5);
      return null;
    },
  };
  const runtime = await loadMainWorld({
    app: null,
    assetsApi,
    exposeEditorApi: true,
  });
  const result = await runtime.call("bridge:collectTemplateDependencies", { assetId: "1" });
  assert.deepEqual(Array.from(result.assets, (item) => item.id).sort(), [2, 3, 4]);
  assert.deepEqual(Array.from(result.scripts, (item) => item.name), ["mover"]);
  assert.deepEqual(Array.from(result.childTemplateIds), ["9"]);
});

test("Template selection injects the pcbridge builder panel into the attributes layout", async () => {
  class Element {
    constructor(args = {}) {
      Object.assign(this, args);
      this.children = [];
      this.handlers = new Map();
      this.class = { add() {} };
      this.enabled = true;
    }
    append(value) {
      value.parent = this;
      this.children.push(value);
    }
    on(type, handler) { this.handlers.set(type, handler); }
    destroy() {
      this.destroyed = true;
      if (this.parent) {
        this.parent.children = this.parent.children.filter((child) => child !== this);
        this.parent = null;
      }
    }
  }
  const layout = new Element();
  const pcui = {
    Container: Element,
    Button: Element,
    Label: Element,
    TextInput: Element,
    layout,
  };
  const selectedAsset = {
    get(path) {
      if (path === "id") return 123;
      if (path === "type") return "template";
      return null;
    },
  };
  let currentSelection = selectedAsset;
  const runtime = await loadMainWorld({
    app: null,
    editorLocation: true,
    exposeEditorApi: true,
    pcui,
    selectedAsset: () => currentSelection,
  });
  const selectionHandlers = new Map();
  runtime.window.editor.selection = {
    on(type, handler) { selectionHandlers.set(type, handler); },
  };
  assert.equal(runtime.intervals.length, 1);
  runtime.intervals[0]();
  assert.equal(layout.children.length, 1);
  const panel = layout.children[0];
  assert.equal(panel.children[0].text, "pcbridge Tiny Builder");
  assert.ok(panel.children.some((item) => item.text === "构建并上传到 S3"));

  currentSelection = null;
  selectionHandlers.get("remove")();
  currentSelection = selectedAsset;
  selectionHandlers.get("add")(selectedAsset);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(layout.children.length, 1, "a remove/add selection race must not hide the panel");

  layout.children = [];
  panel.parent = null;
  runtime.intervals[0]();
  assert.equal(layout.children.length, 1, "an Inspector rebuild must reattach the panel");
  assert.notEqual(layout.children[0], panel);
});
