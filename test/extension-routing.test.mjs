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

async function loadServiceWorker() {
  const runtimeMessages = createEvent();
  const tabUpdates = createEvent();
  const tabRemovals = createEvent();
  const local = createStorageArea();
  const session = createStorageArea();
  const updatedTabs = [];
  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: runtimeMessages,
    },
    storage: { local, session },
    tabs: {
      onRemoved: tabRemovals,
      onUpdated: tabUpdates,
      async update(tabId, update) {
        updatedTabs.push({ tabId, ...update });
      },
    },
  };
  const source = await readFile(join(process.cwd(), "extension/service-worker.js"), "utf8");
  vm.runInNewContext(source, { URL, chrome, fetch, console, Response });

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
  };
}

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
