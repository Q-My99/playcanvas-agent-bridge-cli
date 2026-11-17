import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

function createMockNode(tag = "div") {
  const handlers = {};
  const node = {
    tag,
    className: "",
    textContent: "",
    title: "",
    value: "",
    type: "",
    disabled: false,
    hidden: false,
    inert: false,
    dataset: {},
    attributes: {},
    children: [],
    handlers,
    classList: {
      add() {},
      toggle() {},
    },
    addEventListener(name, handler) {
      handlers[name] = handler;
    },
    setAttribute(name, val) {
      node.attributes[name] = String(val);
    },
    append(...items) {
      node.children.push(...items);
    },
    replaceChildren(...items) {
      node.children = [...items];
    },
  };
  return node;
}

async function runPopup(initialUrl, statusData, options = {}) {
  const elements = new Map();
  const intervals = [];
  const runtimeMessages = [];
  const daemonCalls = [];
  let storedWorkspace = { eagerMaxMb: 2, pendingDaemonSync: false };
  const document = {
    createElement(tag) {
      return createMockNode(tag);
    },
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createMockNode("div"));
      }
      return elements.get(id);
    },
  };
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "0.8.0" }),
      getURL: () => "chrome-extension://test/config.json",
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        if (message.type === "pcbridge:siteStatus") {
          return { enabled: true, builtin: true, origin: "https://playcanvas.com/*" };
        }
        if (message.type === "pcbridge:getWorkspaceSettings") {
          return { ok: true, ...storedWorkspace };
        }
        if (message.type === "pcbridge:setWorkspaceSettings") {
          storedWorkspace = {
            eagerMaxMb: message.eagerMaxMb,
            pendingDaemonSync: Boolean(message.pendingDaemonSync),
          };
          return { ok: true, ...storedWorkspace };
        }
        return null;
      },
    },
    tabs: {
      query: async () => [{ id: 123, url: initialUrl }],
    },
  };
  const fetchMock = async (url, reqOptions = {}) => {
    const rawUrl = String(url);
    if (rawUrl.startsWith("chrome-extension:")) {
      return new Response(JSON.stringify({
        host: "127.0.0.1",
        port: 17329,
        token: "test-token",
      }));
    }
    if (rawUrl.includes("/plugins")) {
      const method = reqOptions.method || "GET";
      const payload = reqOptions.body ? JSON.parse(String(reqOptions.body)) : null;
      daemonCalls.push({ endpoint: rawUrl.replace(/^http:\/\/127\.0\.0\.1:17329/, ""), method, payload });
      if (options.onPluginRequest) {
        return new Response(JSON.stringify(await options.onPluginRequest(rawUrl, method, payload)));
      }
      return new Response(JSON.stringify({ ok: true, data: { plugins: [], available: [] } }));
    }
    if (rawUrl.endsWith("/workspace/settings") && reqOptions.method === "POST") {
      const payload = JSON.parse(String(reqOptions.body || "{}"));
      daemonCalls.push(payload);
      const currentStatus = typeof statusData === "function" ? statusData() : statusData;
      if (!currentStatus) throw new Error("daemon offline");
      if (currentStatus.workspace) currentStatus.workspace.eagerMaxMb = payload.eagerMaxMb;
      if (currentStatus.daemon) currentStatus.daemon.eagerMaxMb = payload.eagerMaxMb;
      return new Response(JSON.stringify({
        ok: true,
        data: { eagerMaxMb: payload.eagerMaxMb, eagerMaxBytes: payload.eagerMaxMb * 1024 * 1024 },
      }));
    }
    if (rawUrl.endsWith("/update") && reqOptions.method === "POST") {
      const payload = JSON.parse(String(reqOptions.body || "{}"));
      daemonCalls.push({ endpoint: "/update", ...payload });
      return new Response(JSON.stringify({
        ok: true,
        data: { packageUpdated: true, version: "0.9.0" },
      }));
    }
    const currentStatus = typeof statusData === "function" ? statusData() : statusData;
    if (!currentStatus) throw new Error("daemon offline");
    return new Response(JSON.stringify({ ok: true, data: currentStatus }));
  };
  const window = { close: () => undefined };
  const source = await readFile(join(process.cwd(), "extension/popup.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    chrome,
    console,
    document,
    fetch: fetchMock,
    navigator: { clipboard: { writeText: async () => undefined } },
    Response,
    setInterval: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    setTimeout,
    window,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, intervals, runtimeMessages, daemonCalls };
}

test("popup HTML removes built-in Editor Frontend section and renders connection & workspace status cleanly", async () => {
  const html = await readFile(join(process.cwd(), "extension/popup.html"), "utf8");
  assert.doesNotMatch(html, /id="frontend-title"/);
  assert.doesNotMatch(html, /id="use-custom"/);
  assert.doesNotMatch(html, /id="use-official"/);

  let state = "syncing";
  const popup = await runPopup(
    "https://pc-editor.sightp.com/editor/scene/42",
    () => ({
      daemon: { version: "0.8.0", targetCount: 1 },
      target: {
        connected: true,
        ready: true,
        kind: "editor",
        projectId: "42",
        projectName: "selfhost-demo",
      },
      workspace: {
        available: true,
        state,
        projectDirectory: "/workspace/42-selfhost-demo",
        lastSyncedAt: state === "synced" ? new Date().toISOString() : null,
        progress: state === "syncing" ? {
          phase: "reconciling",
          startedAt: new Date().toISOString(),
          completed: 1,
          total: 3,
          assetId: "21",
          action: "downloading",
        } : null,
        counts: { scripts: 3, scriptsSynced: state === "synced" ? 3 : 1, assets: 20 },
      },
    }),
  );
  assert.equal(popup.elements.get("daemon-status").textContent, "Connected");
  assert.equal(popup.elements.get("project").textContent, "selfhost-demo · 42");
  assert.equal(popup.elements.get("workspace-status").textContent, "Syncing");
  assert.equal(
    popup.elements.get("workspace-note").textContent,
    "Comparing workspace files 1/3 · downloading #21",
  );

  state = "synced";
  await popup.intervals[0]();
  assert.equal(popup.elements.get("workspace-status").textContent, "Synced");
  assert.equal(popup.elements.get("metric-scripts").textContent, "3/3");
});

test("extension popup direct-sync slider defaults to 2 MB and syncs 1-10 MB updates to daemon", async () => {
  const liveStatus = {
    daemon: { version: "0.8.0", targetCount: 1, eagerMaxMb: 2 },
    target: {
      connected: true,
      ready: true,
      kind: "editor",
      projectId: "1552681",
      projectName: "pcbridge-test",
    },
    workspace: {
      available: true,
      state: "synced",
      eagerMaxMb: 2,
      projectDirectory: "/workspace/1552681-pcbridge-test",
      counts: { scripts: 1, scriptsSynced: 1, assets: 5, lazyAssets: 2, conflicts: 0 },
    },
  };
  const popup = await runPopup("https://playcanvas.com/editor/scene/2558608", () => liveStatus);
  const slider = popup.elements.get("eager-limit");
  const label = popup.elements.get("eager-limit-value");

  assert.equal(slider.value, "2");
  assert.equal(label.textContent, "2 MB");

  slider.value = "7";
  slider.handlers.input();
  assert.equal(label.textContent, "7 MB");
  await popup.intervals[0]();
  assert.equal(slider.value, "7");

  await slider.handlers.change();
  assert.deepEqual(popup.daemonCalls, [{ eagerMaxMb: 7 }]);
  assert.equal(liveStatus.workspace.eagerMaxMb, 7);
  assert.equal(label.textContent, "7 MB");
  const savedMsg = popup.runtimeMessages.find((item) => item.type === "pcbridge:setWorkspaceSettings");
  assert.deepEqual(JSON.parse(JSON.stringify(savedMsg)), {
    type: "pcbridge:setWorkspaceSettings",
    eagerMaxMb: 7,
    pendingDaemonSync: false,
  });
});

test("extension popup shows core update banner, plugin update count, discovers new official plugins, and triggers one-click Update & Reload", async () => {
  let localFrontendInstalled = false;
  const statusWithUpdates = {
    daemon: { version: "0.8.0", targetCount: 1, eagerMaxMb: 2 },
    target: {
      connected: true,
      ready: true,
      kind: "editor",
      projectId: "1552681",
      projectName: "pcbridge-test",
    },
    workspace: {
      available: true,
      state: "synced",
      eagerMaxMb: 2,
      projectDirectory: "/workspace/1552681-pcbridge-test",
      counts: { scripts: 1, scriptsSynced: 1, assets: 5, lazyAssets: 2, conflicts: 0 },
    },
    updates: {
      hasUpdates: true,
      core: {
        currentVersion: "0.8.0",
        latestVersion: "0.9.0",
        updateAvailable: true,
        canSelfUpdate: true,
        installKind: "bun-global",
      },
      plugins: [
        {
          id: "tinyapp-builder",
          name: "Tiny Builder",
          currentVersion: "1.0.1",
          latestVersion: "1.2.0",
          updateAvailable: true,
          compatible: true,
        },
      ],
    },
  };

  const popup = await runPopup("https://playcanvas.com/editor/scene/2558608", statusWithUpdates, {
    onPluginRequest: async (url, method, payload) => {
      if (url.endsWith("/plugins/add") && method === "POST" && payload.source === "local-frontend") {
        localFrontendInstalled = true;
        return { ok: true, data: { id: "local-frontend", state: "active" } };
      }
      return {
        ok: true,
        data: {
          plugins: localFrontendInstalled
            ? [{
                id: "local-frontend",
                name: "Local Frontend",
                version: "1.0.0",
                latestVersion: "1.0.0",
                updateAvailable: false,
                compatible: true,
                enabled: true,
                state: "active",
                source: { type: "official", name: "local-frontend" },
                runtimes: { node: true, editor: true, launch: false },
                pages: [],
              }]
            : [],
          available: localFrontendInstalled
            ? []
            : [{
                id: "local-frontend",
                name: "Local Frontend",
                version: "1.0.0",
                minPcbridgeVersion: "0.8.0",
                compatible: true,
                description: "Serve local frontend builds.",
                source: "local-frontend",
              }],
        },
      };
    },
  });
  assert.equal(popup.elements.get("update-banner").hidden, false);
  assert.equal(popup.elements.get("update-status").textContent, "v0.9.0");
  assert.match(popup.elements.get("update-note").textContent, /v0\.8\.0 → v0\.9\.0/);
  assert.equal(popup.elements.get("tab-plugins").textContent, "Plugins · 1↑");
  assert.ok(popup.runtimeMessages.some((m) => m.type === "pcbridge:syncUpdateBadge" && m.updates?.hasUpdates === true));

  // Clicking Plugins tab refreshes remote catalog (/plugins?refresh=1) and displays Local Frontend
  popup.elements.get("tab-plugins").handlers.click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(popup.daemonCalls.some((c) => c.endpoint === "/plugins?refresh=1"));
  const availableRows = popup.elements.get("plugin-available").children;
  assert.equal(availableRows.length, 1);
  const installBtn = availableRows[0].children.at(-1).children[0];
  assert.equal(installBtn.textContent, "Install");
  assert.equal(installBtn.disabled, false);

  await installBtn.handlers.click();
  assert.equal(localFrontendInstalled, true);
  assert.equal(popup.elements.get("plugin-list").children.length, 1);

  await popup.elements.get("update-apply").handlers.click();
  assert.ok(popup.daemonCalls.some((c) => c.endpoint === "/update" && c.includePlugins === true && c.reloadTabs === true));
  assert.ok(popup.runtimeMessages.some((m) => m.type === "pcbridge:reloadExtension" && m.reloadTabs === true));
});
