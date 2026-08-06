import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

function createEvent() {
  let listener = null;
  return {
    addListener(value) {
      listener = value;
    },
    fire(...args) {
      assert.ok(listener, "expected an extension event listener");
      return listener(...args);
    },
  };
}

function createStorageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return { [key]: structuredClone(data[key]) };
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
  };
}

async function settleExtensionTasks() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate, message) {
  for (let index = 0; index < 20; index += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function loadBridgeWorlds({ fetchImpl } = {}) {
  const listeners = new Map();
  const sockets = [];
  const pageMessages = [];
  const runtimeRequests = [];
  const window = {
    console: { debug() {}, log() {}, info() {}, warn() {}, error() {} },
    document: {
      readyState: "complete",
      visibilityState: "visible",
      title: "Editor test",
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    location: {
      hostname: "playcanvas.com",
      pathname: "/editor/scene/1",
      href: "https://playcanvas.com/editor/scene/1",
    },
    editor: { api: { globals: {} }, call: () => null },
    addEventListener(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    postMessage(message) {
      pageMessages.push(message);
      const event = { source: window, data: message };
      for (const listener of listeners.get("message") || []) void listener(event);
    },
  };
  window.window = window;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(type, listener) {
      const values = this.listeners.get(type) || [];
      values.push(listener);
      this.listeners.set(type, values);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    dispatch(type, value = {}) {
      for (const listener of this.listeners.get(type) || []) void listener(value);
    }

    close() {
      this.readyState = 3;
    }
  }

  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "test" }),
      sendMessage(message, callback) {
        runtimeRequests.push(message);
        const responses = {
          "pcbridge:applyFrontendPreference": {},
          "pcbridge:getConfig": { host: "127.0.0.1", port: 17329, token: "test" },
          "pcbridge:getTabInfo": { tabId: 1, windowId: 1 },
          "pcbridge:probeDaemon": { reachable: true },
          "pcbridge:daemonRequest": { ok: true, data: { id: "build-1", state: "queued" } },
          "pcbridge:rememberProjectContext": { ok: true },
        };
        callback(responses[message.type] || null);
      },
    },
  };
  const context = vm.createContext({
    window,
    document: window.document,
    location: window.location,
    console: window.console,
    chrome,
    WebSocket: FakeWebSocket,
    crypto: { randomUUID: () => "request-id" },
    performance,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    URLSearchParams,
    Blob,
    FormData,
    fetch: fetchImpl || fetch,
    Response,
    Uint8Array,
    Uint8ClampedArray,
    WeakSet,
    Set,
    Map,
  });
  window.Function = vm.runInContext("Function", context);
  const mainSource = await readFile(join(process.cwd(), "extension/main.js"), "utf8");
  const isolatedSource = await readFile(join(process.cwd(), "extension/isolated.js"), "utf8");
  vm.runInContext(mainSource, context);
  vm.runInContext(isolatedSource, context);

  const socket = await waitFor(() => sockets[0], "isolated bridge did not create a WebSocket");
  socket.readyState = FakeWebSocket.OPEN;
  socket.dispatch("open");
  await settleExtensionTasks();
  socket.sent.length = 0;
  socket.pageMessages = pageMessages;
  socket.runtimeRequests = runtimeRequests;
  socket.window = window;
  return socket;
}

async function loadServiceWorker(fetchImpl = fetch) {
  const runtimeMessages = createEvent();
  const tabUpdates = createEvent();
  const tabRemovals = createEvent();
  const local = createStorageArea();
  const session = createStorageArea();
  const updatedTabs = [];
  const updatedWindows = [];
  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: runtimeMessages,
    },
    storage: { local, session },
    windows: {
      async update(windowId, update) {
        updatedWindows.push({ windowId, ...update });
      },
    },
    tabs: {
      onRemoved: tabRemovals,
      onUpdated: tabUpdates,
      async update(tabId, update) {
        updatedTabs.push({ tabId, ...update });
      },
    },
  };
  const source = await readFile(join(process.cwd(), "extension/service-worker.js"), "utf8");
  vm.runInNewContext(source, { URL, chrome, fetch: fetchImpl, console, Response });

  async function sendMessage(message, sender = {}) {
    return new Promise((resolve) => {
      const result = runtimeMessages.fire(message, sender, resolve);
      if (result !== true) resolve(undefined);
    });
  }

  return {
    local,
    sendMessage,
    session,
    tabRemovals,
    tabUpdates,
    updatedTabs,
    updatedWindows,
  };
}

test("extension can focus the PlayCanvas tab that requested it", async () => {
  const extension = await loadServiceWorker();
  const response = await extension.sendMessage(
    { type: "pcbridge:focusCurrentTab" },
    { tab: { id: 41, windowId: 7 } },
  );
  assert.equal(response.ok, true);
  assert.equal(response.tabId, 41);
  assert.equal(response.windowId, 7);
  assert.deepEqual(extension.updatedWindows, [{ windowId: 7, focused: true }]);
  assert.deepEqual(extension.updatedTabs, [{ tabId: 41, active: true }]);
});

test("structured main-world errors keep details through isolated WebSocket forwarding", async () => {
  const socket = await loadBridgeWorlds();
  socket.dispatch("message", {
    data: JSON.stringify({
      type: "request",
      id: "rpc-1",
      method: "bridge:eval",
      timeoutMs: 2000,
      params: {
        timeoutMs: 2000,
        code: `
          const error = new Error("template state is unknown");
          error.code = "TEMPLATE_CALLBACK_TIMEOUT";
          error.details = { stateUnknown: true, completedEntityIds: ["one"] };
          throw error;
        `,
      },
    }),
  });

  const response = await waitFor(
    () => socket.sent.find((message) => message.id === "rpc-1"),
    "isolated bridge did not forward the main-world error",
  );
  assert.equal(response.ok, false);
  assert.deepEqual(response.error, {
    code: "TEMPLATE_CALLBACK_TIMEOUT",
    message: "template state is unknown",
    details: { stateUnknown: true, completedEntityIds: ["one"] },
  });
});

test("isolated bridge forwards Template builder jobs through the extension background", async () => {
  const socket = await loadBridgeWorlds({
    fetchImpl: async () => { throw new Error("the isolated page must not fetch the daemon"); },
  });
  socket.window.postMessage({
    channel: "playcanvas-agent-bridge",
    side: "main",
    type: "daemon-request",
    id: "builder-request",
    path: "/builder/jobs",
    method: "POST",
    body: { templateAssetId: "123" },
  });
  const response = await waitFor(
    () => socket.pageMessages.find((message) =>
      message.type === "daemon-response" && message.id === "builder-request"
    ),
    "isolated bridge did not return the daemon response",
  );
  assert.equal(response.ok, true);
  const request = socket.runtimeRequests.find((item) => item.type === "pcbridge:daemonRequest");
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    type: "pcbridge:daemonRequest",
    path: "/builder/jobs",
    method: "POST",
    body: {
      templateAssetId: "123",
      target: "tab:1",
    },
  });
});

test("extension background authenticates Template builder requests to the local daemon", async () => {
  const requests = [];
  const extension = await loadServiceWorker(async (url, options) => {
    if (url === "chrome-extension://test/config.json") {
      return new Response(JSON.stringify({ host: "127.0.0.1", port: 17329, token: "test" }), {
        status: 200,
      });
    }
    requests.push({ url, options });
    return new Response(JSON.stringify({
      ok: true,
      data: { id: "build-1", state: "queued" },
    }), { status: 202, headers: { "Content-Type": "application/json" } });
  });
  const response = await extension.sendMessage({
    type: "pcbridge:daemonRequest",
    path: "/builder/jobs",
    method: "POST",
    body: { templateAssetId: "123" },
  }, { tab: { id: 41 } });
  assert.equal(response.ok, true);
  assert.equal(requests[0].url, "http://127.0.0.1:17329/builder/jobs");
  assert.equal(requests[0].options.headers["X-PCBridge-Token"], "test");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    templateAssetId: "123",
    target: "tab:41",
  });
  const blocked = await extension.sendMessage({
    type: "pcbridge:daemonRequest",
    path: "/rpc",
    method: "POST",
    body: {},
  }, { tab: { id: 41 } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "UNSUPPORTED_DAEMON_REQUEST");
  assert.equal(requests.length, 1);
});

test("extension remembers frontend mode per project and applies it to project and scene URLs", async () => {
  const extension = await loadServiceWorker();
  const projectUrl = "https://playcanvas.com/editor/project/1552681?foo=bar#scenes";

  const saved = await extension.sendMessage({
    type: "pcbridge:setFrontendPreference",
    tabId: 41,
    url: projectUrl,
    mode: "custom",
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.projectId, "1552681");
  assert.equal(extension.local.data.pcbridgeFrontendPreferences["1552681"], "custom");

  extension.tabUpdates.fire(41, { url: projectUrl });
  await settleExtensionTasks();
  const projectRedirect = new URL(extension.updatedTabs.at(-1).url);
  assert.equal(projectRedirect.searchParams.get("foo"), "bar");
  assert.equal(projectRedirect.searchParams.has("use_local_frontend"), true);
  assert.equal(projectRedirect.hash, "#scenes");

  const sceneUrl = "https://playcanvas.com/editor/scene/2533764?foo=scene#viewport";
  extension.tabUpdates.fire(41, { url: sceneUrl });
  await settleExtensionTasks();
  const sceneRedirect = new URL(extension.updatedTabs.at(-1).url);
  assert.equal(sceneRedirect.pathname, "/editor/scene/2533764");
  assert.equal(sceneRedirect.searchParams.get("foo"), "scene");
  assert.equal(sceneRedirect.searchParams.has("use_local_frontend"), true);
  assert.equal(sceneRedirect.hash, "#viewport");

  const remembered = await extension.sendMessage({
    type: "pcbridge:rememberProjectContext",
    projectId: "1552681",
    sceneId: "2533764",
    url: sceneRedirect.toString(),
  }, { tab: { id: 41, url: sceneRedirect.toString() } });
  assert.equal(remembered.ok, true);
  assert.equal(extension.local.data.pcbridgeSceneProjects["2533764"], "1552681");

  const official = await extension.sendMessage({
    type: "pcbridge:setFrontendPreference",
    tabId: 77,
    url: sceneRedirect.toString(),
    mode: "official",
  });
  assert.equal(official.ok, true);
  assert.equal(official.projectId, "1552681");

  extension.tabUpdates.fire(77, { url: sceneRedirect.toString() });
  await settleExtensionTasks();
  const officialRedirect = new URL(extension.updatedTabs.at(-1).url);
  assert.equal(officialRedirect.searchParams.get("foo"), "scene");
  assert.equal(officialRedirect.searchParams.has("use_local_frontend"), false);
  assert.equal(officialRedirect.hash, "#viewport");

  const updateCount = extension.updatedTabs.length;
  extension.tabUpdates.fire(88, {
    url: "https://playcanvas.com/editor/project/9999999",
  });
  await settleExtensionTasks();
  assert.equal(extension.updatedTabs.length, updateCount);
});
