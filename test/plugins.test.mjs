import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { c as createTar } from "tar";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/daemon/server.js";
import {
  parsePluginSource,
  PluginStore,
  readPluginManifest,
} from "../dist/plugins/store.js";

async function tempRoot(t, prefix) {
  const base = join(process.cwd(), "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFixturePlugin(directory, manifest = {}) {
  await mkdir(join(directory, "node"), { recursive: true });
  await mkdir(join(directory, "page"), { recursive: true });
  await writeFile(join(directory, "pcbridge-plugin.json"), JSON.stringify({
    id: "fixture",
    name: "Fixture",
    version: "1.0.0",
    apiVersion: 1,
    node: "node/index.js",
    page: { editor: "page/editor.js" },
    actions: { greet: { description: "Greets." } },
    ...manifest,
  }));
  await writeFile(join(directory, "node/greeting.js"), 'export const greeting = "hello";\n');
  await writeFile(join(directory, "node/index.js"), [
    'import { greeting } from "./greeting.js";',
    "export function activate(plugin) {",
    '  plugin.handle("greet", (params) => ({ message: `${greeting} ${params.name}`, rootDir: plugin.workspace.rootDir }));',
    '  plugin.handle("ask-page", (params, { target }) => plugin.callPage(target, "answer", { question: params.question }));',
    '  plugin.handle("fail", () => { throw Object.assign(new Error("nope"), { code: "FIXTURE_FAILED" }); });',
    "}",
    "",
  ].join("\n"));
  await writeFile(join(directory, "page/editor.js"), 'plugin.handle("answer", () => 42);\n');
}

test("plugin manifests and sources are validated", async (t) => {
  const root = await tempRoot(t, "plugin-manifest-test-");
  const directory = join(root, "fixture");
  await writeFixturePlugin(directory);
  assert.equal((await readPluginManifest(directory)).id, "fixture");

  for (const manifest of [
    { id: "Bad_Id" },
    { apiVersion: 2 },
    { version: "latest" },
    { node: "../outside.js" },
    { page: { editor: "page/missing.js" } },
    { node: undefined, page: undefined },
  ]) {
    await writeFixturePlugin(directory, manifest);
    await assert.rejects(readPluginManifest(directory), { code: "PLUGIN_MANIFEST_INVALID" });
  }

  assert.deepEqual(parsePluginSource("tinyapp-builder"), { type: "official", name: "tinyapp-builder" });
  assert.deepEqual(parsePluginSource("github:acme/tools"), {
    type: "github", repo: "acme/tools", subdir: "", ref: "HEAD",
  });
  assert.deepEqual(parsePluginSource("github:acme/tools/plugins/fixture#v1.2.0"), {
    type: "github", repo: "acme/tools", subdir: "plugins/fixture", ref: "v1.2.0",
  });
  assert.deepEqual(parsePluginSource(directory, true), { type: "link", path: directory });
  assert.throws(() => parsePluginSource("relative/path"), { code: "PLUGIN_SOURCE_INVALID" });
  assert.throws(() => parsePluginSource("github:acme/tools", true), { code: "PLUGIN_SOURCE_INVALID" });
});

test("plugin store installs a directory with its dependencies, updates, and removes it", async (t) => {
  const root = await tempRoot(t, "plugin-store-test-");
  const source = join(root, "source");
  await writeFixturePlugin(source);
  await mkdir(join(source, "vendor/fixture-dep"), { recursive: true });
  await writeFile(join(source, "vendor/fixture-dep/package.json"), JSON.stringify({
    name: "fixture-dep", version: "1.0.0", type: "module", main: "index.js",
  }));
  await writeFile(join(source, "vendor/fixture-dep/index.js"), "export const value = 1;\n");
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "fixture-plugin",
    private: true,
    type: "module",
    dependencies: { "fixture-dep": "file:./vendor/fixture-dep" },
  }));

  const store = new PluginStore(join(root, "plugins"), { officialDir: join(process.cwd(), "plugins") });
  assert.ok((await store.available()).some((plugin) => plugin.id === "tinyapp-builder"));

  const added = await store.add(parsePluginSource(source));
  assert.equal(added.enabled, true);
  assert.equal(added.path, join(root, "plugins", "installed", "fixture"));
  await access(join(added.path, "node_modules", "fixture-dep", "index.js"));
  await assert.rejects(store.add(parsePluginSource(source)), { code: "PLUGIN_EXISTS" });

  await writeFixturePlugin(source, { version: "1.1.0" });
  assert.deepEqual(await store.update("fixture"), { previousVersion: "1.0.0", version: "1.1.0" });

  await store.setEnabled("fixture", false);
  const [listed] = await store.list();
  assert.equal(listed.enabled, false);
  assert.equal(listed.manifest.version, "1.1.0");

  await store.remove("fixture");
  assert.deepEqual(await store.list(), []);
  await assert.rejects(access(added.path));
  await assert.rejects(store.remove("fixture"), { code: "PLUGIN_NOT_FOUND" });
});

test("plugin store installs a subdirectory of a GitHub repository archive", async (t) => {
  const root = await tempRoot(t, "plugin-github-test-");
  await writeFixturePlugin(join(root, "archive/tools-v1/plugins/fixture"));
  await writeFile(join(root, "archive/tools-v1/README.md"), "not part of the plugin\n");
  const archivePath = join(root, "tools.tar.gz");
  await createTar({ cwd: join(root, "archive"), file: archivePath, gzip: true }, ["tools-v1"]);

  const requested = [];
  const store = new PluginStore(join(root, "plugins"), {
    fetch: async (url) => {
      requested.push(url);
      return new Response(await readFile(archivePath));
    },
  });
  const added = await store.add(parsePluginSource("github:acme/tools/plugins/fixture#v1"));
  assert.deepEqual(requested, ["https://codeload.github.com/acme/tools/tar.gz/v1"]);
  assert.equal(added.manifest.id, "fixture");
  await access(join(added.path, "node/index.js"));
  await assert.rejects(access(join(added.path, "README.md")));

  const failing = new PluginStore(join(root, "failing"), {
    fetch: async () => new Response("missing", { status: 404 }),
  });
  await assert.rejects(
    failing.add(parsePluginSource("github:acme/missing")),
    { code: "PLUGIN_DOWNLOAD_FAILED" },
  );
  await assert.rejects(
    store.add(parsePluginSource("github:acme/tools/plugins/absent")),
    { code: "PLUGIN_SOURCE_NOT_FOUND" },
  );
  assert.deepEqual(await readdir(join(root, "failing", "installed")), [], "failed installs leave no staging directory");
  assert.deepEqual(await readdir(join(root, "plugins", "installed")), ["fixture"]);
});

test("daemon activates plugins, syncs page scripts, routes actions, and hot reloads", async (t) => {
  const root = await tempRoot(t, "plugin-daemon-test-");
  const pluginDir = join(root, "fixture");
  await writeFixturePlugin(pluginDir);
  const token = "plugin-test-token-not-a-real-session";
  const daemon = createDaemonServer({
    token,
    port: 0,
    frontendPort: 0,
    frontendRootDir: join(root, "config"),
    workspaceRoot: root,
  });
  await daemon.listen();
  t.after(() => daemon.close());

  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "X-PCBridge-Token": token },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  };

  const synced = [];
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/extension?token=${token}&clientId=page-1`);
  t.after(() => socket.close());
  await once(socket, "open");
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    let data = null;
    if (message.method === "bridge:syncPlugins") {
      synced.push(message.params.plugins);
      data = { plugins: message.params.plugins.map((plugin) => ({ id: plugin.id, ok: true })) };
    } else if (message.method === "plugin:fixture:answer") {
      data = { answer: message.params.question.toUpperCase() };
    }
    socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, data }));
  });
  socket.send(JSON.stringify({
    type: "target:update",
    target: { clientId: "page-1", tabId: 5, kind: "editor", url: "https://playcanvas.com/editor/scene/1", ready: true },
  }));
  for (let index = 0; index < 100 && synced.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(synced, [[]], "a ready target is synced even when no plugin is enabled");

  const added = await api("/plugins/add", { source: pluginDir, link: true });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.data.state, "active");
  assert.deepEqual(added.data.runtimes, { node: true, editor: true, launch: false });
  assert.deepEqual(added.data.pages, [{ target: "tab:5", ok: true, error: null }]);
  assert.deepEqual(synced.at(-1), [{
    id: "fixture",
    version: "1.0.0",
    code: 'plugin.handle("answer", () => 42);\n',
  }]);

  const greeted = await api("/plugins/fixture/actions/greet", { params: { name: "agent" } });
  assert.deepEqual(greeted.data, { message: "hello agent", rootDir: root });
  const asked = await api("/plugins/fixture/actions/ask-page", { target: "tab:5", params: { question: "why" } });
  assert.deepEqual(asked.data, { answer: "WHY" });
  const failed = await api("/plugins/fixture/actions/fail", {});
  assert.equal(failed.error.code, "FIXTURE_FAILED");
  assert.equal((await api("/plugins/fixture/actions/unknown", {})).error.code, "PLUGIN_ACTION_NOT_FOUND");
  assert.equal(
    (await api("/plugins/fixture/actions/greet", { target: "tab:404" })).error.code,
    "TARGET_NOT_FOUND",
  );

  await writeFile(join(pluginDir, "node/greeting.js"), 'export const greeting = "hi";\n');
  await writeFile(join(pluginDir, "page/editor.js"), 'plugin.handle("answer", () => 43);\n');
  assert.equal((await api("/plugins/fixture/reload", {})).data.state, "active");
  assert.equal(
    (await api("/plugins/fixture/actions/greet", { params: { name: "agent" } })).data.message,
    "hi agent",
    "reload must pick up changed node modules imported by the entry",
  );
  assert.equal(synced.at(-1)[0].code, 'plugin.handle("answer", () => 43);\n');

  await writeFile(join(pluginDir, "node/index.js"), "export const nothing = true;\n");
  const broken = (await api("/plugins/fixture/reload", {})).data;
  assert.equal(broken.state, "error");
  assert.match(broken.error, /activate\(plugin\)/);
  assert.deepEqual(synced.at(-1), [], "a plugin that fails to activate must not inject page code");
  assert.equal((await api("/plugins/fixture/actions/greet", {})).error.code, "PLUGIN_ERROR");

  const disabled = await api("/plugins/fixture/disable", {});
  assert.equal(disabled.data.state, "disabled");
  assert.equal((await api("/plugins/fixture/actions/greet", {})).error.code, "PLUGIN_DISABLED");

  const listed = await api("/plugins");
  assert.equal(listed.data.plugins.length, 1);
  assert.ok(listed.data.available.some((plugin) => plugin.id === "tinyapp-builder"));

  assert.deepEqual((await api("/plugins/fixture/remove", {})).data, { id: "fixture", removed: true });
  assert.deepEqual((await api("/plugins")).data.plugins, []);
  await access(join(pluginDir, "pcbridge-plugin.json"));
});

test("plugin CLI manages the registry on disk while the daemon is not running", async (t) => {
  const root = await tempRoot(t, "plugin-cli-test-");
  const pluginDir = join(root, "fixture");
  await writeFixturePlugin(pluginDir);
  const configDir = join(root, "config");
  await mkdir(configDir);
  await writeFile(join(configDir, "session.json"), JSON.stringify({
    token: "plugin-cli-test-token-not-a-real-session",
    port: 1,
  }));
  const run = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist/cli.js"), "plugin", ...args], {
      cwd: root,
      env: { ...process.env, PCBRIDGE_CONFIG_DIR: configDir },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, body: JSON.parse(stdout) }));
  });

  const added = await run("add", "./fixture", "--link");
  assert.equal(added.status, 0, JSON.stringify(added.body));
  assert.equal(added.body.data.state, "stopped");
  assert.deepEqual(added.body.data.source, { type: "link", path: pluginDir });

  assert.equal((await run("disable", "fixture")).body.data.state, "disabled");
  const info = await run("info", "fixture");
  assert.equal(info.body.data.enabled, false);
  assert.deepEqual(info.body.data.actions, { greet: { description: "Greets." } });

  const call = await run("call", "fixture", "greet");
  assert.equal(call.status, 1);
  assert.equal(call.body.error.code, "DAEMON_NOT_LISTENING");

  assert.deepEqual((await run("remove", "fixture")).body.data, { id: "fixture", removed: true });
  assert.equal((await run("info", "fixture")).body.error.code, "PLUGIN_NOT_FOUND");
});

test("official plugin catalog detects remote updates, discovers new official plugins, enforces minPcbridgeVersion, and batch updates", async (t) => {
  const root = await tempRoot(t, "plugin-official-catalog-test-");
  const localOfficialDir = join(root, "local-official");
  await writeFixturePlugin(join(localOfficialDir, "tinyapp-builder"), {
    id: "tinyapp-builder",
    name: "Tiny Builder",
    version: "1.0.0",
    minPcbridgeVersion: "0.7.0",
  });
  await writeFile(
    join(localOfficialDir, "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      plugins: [
        {
          id: "tinyapp-builder",
          name: "Tiny Builder",
          version: "1.0.0",
          apiVersion: 1,
          minPcbridgeVersion: "0.7.0",
          description: "Local v1.0.0",
          subdir: "plugins/tinyapp-builder",
        },
      ],
    }),
  );

  // Prepare remote GitHub tarball containing tinyapp-builder v1.2.0 and a new official plugin scene-auditor v0.2.0
  const remoteRepoRoot = join(root, "remote-archive/repo-main");
  await writeFixturePlugin(join(remoteRepoRoot, "plugins/tinyapp-builder"), {
    id: "tinyapp-builder",
    name: "Tiny Builder",
    version: "1.2.0",
    minPcbridgeVersion: "0.7.0",
  });
  await writeFixturePlugin(join(remoteRepoRoot, "plugins/scene-auditor"), {
    id: "scene-auditor",
    name: "Scene Auditor",
    version: "0.2.0",
    minPcbridgeVersion: "0.7.0",
  });
  await writeFixturePlugin(join(remoteRepoRoot, "plugins/future-plugin"), {
    id: "future-plugin",
    name: "Future Plugin",
    version: "2.0.0",
    minPcbridgeVersion: "99.0.0",
  });
  const archivePath = join(root, "remote-main.tar.gz");
  await createTar({ cwd: join(root, "remote-archive"), file: archivePath, gzip: true }, ["repo-main"]);

  let remoteCatalogVersion = "1.0.0";
  const remoteCatalogUrl = "https://raw.githubusercontent.com/Q-My99/playcanvas-agent-bridge-cli/main/plugins/index.json";
  const store = new PluginStore(join(root, "plugins"), {
    officialDir: localOfficialDir,
    remoteCatalogUrl,
    fetch: async (url) => {
      if (String(url) === remoteCatalogUrl) {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            plugins: [
              {
                id: "tinyapp-builder",
                name: "Tiny Builder",
                version: remoteCatalogVersion,
                apiVersion: 1,
                minPcbridgeVersion: "0.7.0",
                description: `Remote v${remoteCatalogVersion}`,
                subdir: "plugins/tinyapp-builder",
              },
              {
                id: "scene-auditor",
                name: "Scene Auditor",
                version: "0.2.0",
                apiVersion: 1,
                minPcbridgeVersion: "0.7.0",
                description: "New official plugin from GitHub",
                subdir: "plugins/scene-auditor",
              },
              {
                id: "future-plugin",
                name: "Future Plugin",
                version: "2.0.0",
                apiVersion: 1,
                minPcbridgeVersion: "99.0.0",
                description: "Requires future pcbridge",
                subdir: "plugins/future-plugin",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (String(url).startsWith("https://codeload.github.com/")) {
        return new Response(await readFile(archivePath), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  // Install tinyapp-builder while remote is 1.0.0 (uses local copy)
  const installed = await store.add(parsePluginSource("tinyapp-builder"));
  assert.equal(installed.manifest.version, "1.0.0");

  // Available list includes newly added remote official plugins and marks incompatible ones
  const offered = await store.available({ refresh: true });
  const sceneAuditor = offered.find((p) => p.id === "scene-auditor");
  const futurePlugin = offered.find((p) => p.id === "future-plugin");
  assert.ok(sceneAuditor);
  assert.equal(sceneAuditor.version, "0.2.0");
  assert.equal(sceneAuditor.compatible, true);
  assert.ok(futurePlugin);
  assert.equal(futurePlugin.compatible, false);
  assert.equal(futurePlugin.minPcbridgeVersion, "99.0.0");

  // Installing a remote-only official plugin downloads it from GitHub
  const addedRemoteOfficial = await store.add(parsePluginSource("scene-auditor"));
  assert.equal(addedRemoteOfficial.manifest.version, "0.2.0");

  // Installing an official plugin that requires a newer pcbridge is rejected
  await assert.rejects(
    store.add(parsePluginSource("future-plugin")),
    { code: "PLUGIN_REQUIRES_NEWER_PCBRIDGE" },
  );

  // Simulate pushing tinyapp-builder v1.2.0 to GitHub main
  remoteCatalogVersion = "1.2.0";
  const summariesBefore = await store.summaries({ refresh: true });
  const tinySummary = summariesBefore.find((p) => p.id === "tinyapp-builder");
  assert.equal(tinySummary.version, "1.0.0");
  assert.equal(tinySummary.latestVersion, "1.2.0");
  assert.equal(tinySummary.updateAvailable, true);
  assert.equal(tinySummary.compatible, true);

  // Batch updateAll updates only outdated compatible plugins
  const batchResult = await store.updateAll();
  assert.deepEqual(batchResult.updated, [
    { id: "tinyapp-builder", previousVersion: "1.0.0", version: "1.2.0" },
  ]);

  const summariesAfter = await store.summaries({ refresh: true });
  const tinyAfter = summariesAfter.find((p) => p.id === "tinyapp-builder");
  assert.equal(tinyAfter.version, "1.2.0");
  assert.equal(tinyAfter.updateAvailable, false);
});
