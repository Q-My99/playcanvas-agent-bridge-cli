import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { c as createTar } from "tar";
import { createDaemonServer } from "../dist/daemon/server.js";
import { createFrontendServer } from "../plugins/local-frontend/node/server.js";
import {
  FrontendError,
  getFrontendStatus,
  installFrontend,
  listFrontends,
  readFrontendPreferences,
  removeFrontend,
  setFrontendPreference,
  useFrontend,
  validateFrontendManifest,
} from "../plugins/local-frontend/node/store.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const REQUIRED_FIXTURE_FILES = {
  "dist/js/editor.js": "globalThis.fixtureEditor = true;\n",
  "dist/js/editor-empty.js": "",
  "dist/js/code-editor.js": "",
  "dist/js/launch.js": "",
  "dist/css/editor.css": "body { color: black; }\n",
  "dist/css/code-editor.css": "",
  "dist/css/launch.css": "",
  "dist/js/monaco-editor/min/vs/loader.js": "",
  "dist/wasm/draco.wasm": "",
  "LICENSE": "MIT\n",
};

async function makeFixture(root, release) {
  const payload = join(root, `payload-${release}`);
  for (const [file, content] of Object.entries(REQUIRED_FIXTURE_FILES)) {
    const target = join(payload, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const archivePath = join(root, `${release}.tar.gz`);
  await createTar(
    {
      cwd: payload,
      file: archivePath,
      gzip: true,
    },
    ["dist", "LICENSE"],
  );
  const archive = await readFile(archivePath);
  const manifest = {
    schemaVersion: 1,
    release,
    editorVersion: "2.28.1",
    sourceRepository: "Q-My99/playcanvas-editor",
    sourceCommit: "a".repeat(40),
    archive: {
      name: `${release}.tar.gz`,
      url: `https://github.com/Q-My99/playcanvas-editor/releases/download/${release}/${release}.tar.gz`,
      sha256: createHash("sha256").update(archive).digest("hex"),
      size: archive.length,
    },
    builtAt: "2026-07-31T00:00:00Z",
    minPcbridgeVersion: "0.3.0",
  };
  return { archive, manifest };
}

function fixtureFetch(manifest, archive) {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/release.json")) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === manifest.archive.url) {
      return new Response(archive, {
        status: 200,
        headers: { "Content-Type": "application/gzip" },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

test("local-frontend store and server install, validate, serve, and remove releases safely", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "local-frontend-store-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configRoot = join(root, "config");
  const firstRelease = "playcanvas-editor-v2.28.1-r99";
  const first = await makeFixture(root, firstRelease);
  assert.equal(validateFrontendManifest(first.manifest).release, firstRelease);

  // Reject checksum mismatch
  await assert.rejects(
    installFrontend(firstRelease, {
      rootDir: configRoot,
      fetch: fixtureFetch(
        { ...first.manifest, archive: { ...first.manifest.archive, sha256: "0".repeat(64) } },
        first.archive,
      ),
    }),
    (error) => error instanceof FrontendError && error.code === "FRONTEND_CHECKSUM_MISMATCH",
  );

  const installed = await installFrontend(firstRelease, {
    rootDir: configRoot,
    fetch: fixtureFetch(first.manifest, first.archive),
  });
  assert.equal(installed.alreadyInstalled, false);
  assert.equal(installed.manifest.release, firstRelease);

  const repeated = await installFrontend(firstRelease, {
    rootDir: configRoot,
    fetch: fixtureFetch(first.manifest, first.archive),
  });
  assert.equal(repeated.alreadyInstalled, true);

  const status = await getFrontendStatus({ rootDir: configRoot });
  assert.equal(status.ready, true);
  assert.equal(status.activeRelease, firstRelease);
  assert.equal(status.installed.length, 1);

  await setFrontendPreference("1552681", "local", { rootDir: configRoot });
  assert.deepEqual(await readFrontendPreferences({ rootDir: configRoot }), { "1552681": "local" });
  await setFrontendPreference("1552681", "clear", { rootDir: configRoot });
  assert.deepEqual(await readFrontendPreferences({ rootDir: configRoot }), {});

  const frontendServer = createFrontendServer({
    rootDir: configRoot,
    port: 0,
  });
  await frontendServer.listen();
  t.after(() => frontendServer.close());
  const runtime = await frontendServer.status();
  assert.equal(runtime.server.listening, true);
  assert.notEqual(runtime.server.port, 0);

  const base = `http://127.0.0.1:${runtime.server.port}`;
  const healthResponse = await fetch(`${base}/__pcbridge_frontend__/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).activeRelease, firstRelease);

  const scriptResponse = await fetch(`${base}/js/editor.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type") || "", /text\/javascript/);
  assert.equal(scriptResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(await scriptResponse.text(), REQUIRED_FIXTURE_FILES["dist/js/editor.js"]);

  const headResponse = await fetch(`${base}/wasm/draco.wasm`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("content-type"), "application/wasm");
  assert.equal(await headResponse.text(), "");

  const missingResponse = await fetch(`${base}/missing.js`);
  assert.equal(missingResponse.status, 404);

  await assert.rejects(
    removeFrontend(firstRelease, { rootDir: configRoot }),
    (error) => error instanceof FrontendError && error.code === "FRONTEND_IS_ACTIVE",
  );

  const secondRelease = "playcanvas-editor-v2.28.1-r98";
  const second = await makeFixture(root, secondRelease);
  await installFrontend(secondRelease, {
    rootDir: configRoot,
    fetch: fixtureFetch(second.manifest, second.archive),
    activate: false,
  });
  assert.equal((await listFrontends({ rootDir: configRoot })).length, 2);
  await removeFrontend(secondRelease, { rootDir: configRoot });
  assert.equal((await listFrontends({ rootDir: configRoot })).length, 1);
  assert.equal((await useFrontend(firstRelease, { rootDir: configRoot })).ready, true);
});

test("daemon runs without built-in frontend, and enabling/disabling local-frontend plugin starts/stops the static server", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "local-frontend-daemon-test-"));
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });

  const prevPort = process.env.PCBRIDGE_FRONTEND_PORT;
  const prevRoot = process.env.PCBRIDGE_FRONTEND_ROOT_DIR;
  process.env.PCBRIDGE_FRONTEND_PORT = "0";
  process.env.PCBRIDGE_FRONTEND_ROOT_DIR = configDir;

  const release = "playcanvas-editor-v2.28.1-r99";
  const fixture = await makeFixture(root, release);
  await installFrontend(release, {
    rootDir: configDir,
    fetch: fixtureFetch(fixture.manifest, fixture.archive),
  });

  const token = "test-token-that-is-long-enough";
  const daemon = createDaemonServer({
    token,
    port: 0,
    configDir,
    workspaceRoot: root,
  });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    if (prevPort === undefined) delete process.env.PCBRIDGE_FRONTEND_PORT;
    else process.env.PCBRIDGE_FRONTEND_PORT = prevPort;
    if (prevRoot === undefined) delete process.env.PCBRIDGE_FRONTEND_ROOT_DIR;
    else process.env.PCBRIDGE_FRONTEND_ROOT_DIR = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  const api = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "X-PCBridge-Token": token },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  // Core no longer exposes /frontend/status or frontend fields in /health
  const legacyRoute = await api("/frontend/status");
  assert.equal(legacyRoute.status, 404);
  const health = await api("/health");
  assert.equal(health.body.ok, true);
  assert.equal("frontend" in health.body.data, false);

  // Link local-frontend plugin -> activates immediately and serves the release
  const pluginSource = join(process.cwd(), "plugins/local-frontend");
  const added = await api("/plugins/add", { source: pluginSource, link: true });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.data.state, "active");

  const pluginStatus = await api("/plugins/local-frontend/actions/status", {
    params: { projectId: "1552681" },
  });
  assert.equal(pluginStatus.body.ok, true);
  assert.equal(pluginStatus.body.data.ready, true);
  assert.equal(pluginStatus.body.data.activeRelease, release);
  assert.equal(pluginStatus.body.data.server.listening, true);

  const frontendPort = pluginStatus.body.data.server.port;
  const servedJs = await fetch(`http://127.0.0.1:${frontendPort}/js/editor.js`);
  assert.equal(servedJs.status, 200);
  assert.equal(await servedJs.text(), REQUIRED_FIXTURE_FILES["dist/js/editor.js"]);

  // Disabling the plugin immediately releases the frontend port
  const disabled = await api("/plugins/local-frontend/disable", {});
  assert.equal(disabled.body.data.state, "disabled");
  await assert.rejects(fetch(`http://127.0.0.1:${frontendPort}/__pcbridge_frontend__/health`));

  // Re-enabling starts listening again
  const reenabled = await api("/plugins/local-frontend/enable", {});
  assert.equal(reenabled.body.data.state, "active");
  const afterReenable = await api("/plugins/local-frontend/actions/status", {});
  assert.equal(afterReenable.body.data.server.listening, true);
});

function makeFakeDom() {
  function makeEl(tag) {
    const handlers = {};
    const el = {
      tag,
      className: "",
      textContent: "",
      innerHTML: "",
      title: "",
      type: "",
      hidden: false,
      disabled: false,
      dataset: {},
      style: {},
      children: [],
      parentNode: null,
      handlers,
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      append(...items) {
        for (const item of items) el.appendChild(item);
      },
      remove() {
        if (!el.parentNode) return;
        el.parentNode.children = el.parentNode.children.filter((c) => c !== el);
        el.parentNode = null;
      },
      contains(other) {
        if (other === el) return true;
        return el.children.some((c) => c.contains && c.contains(other));
      },
      addEventListener(name, fn) {
        handlers[name] = fn;
      },
      getBoundingClientRect: () => ({ right: 44, top: 72 }),
    };
    return el;
  }
  const head = makeEl("head");
  const body = makeEl("body");
  const toolbarDom = makeEl("div");
  return {
    document: {
      head,
      body,
      createElement: makeEl,
    },
    toolbarDom,
  };
}

async function runLocalFrontendPage({ href, selfhost = false, projectId = 1552681, statusResponse }) {
  const code = await readFile(join(process.cwd(), "plugins/local-frontend/page/editor.js"), "utf8");
  const { document, toolbarDom } = makeFakeDom();
  const handlers = new Map();
  const disposers = [];
  const pluginCalls = [];
  const navigations = [];
  const windowListeners = new Map();
  const parsed = new URL(href);
  const location = {
    href: parsed.href,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    replace(url) {
      navigations.push(url);
      location.href = url;
    },
  };
  const windowObj = {
    config: {
      selfhost,
      project: projectId ? { id: projectId } : undefined,
    },
    addEventListener(name, fn) {
      windowListeners.set(name, fn);
    },
    removeEventListener(name) {
      windowListeners.delete(name);
    },
  };
  const editor = {
    call(method) {
      if (method === "layout.toolbar") return { dom: toolbarDom };
      return null;
    },
  };
  const fn = new AsyncFunction(
    "plugin",
    "editor",
    "pc",
    "pcui",
    "runtimeApp",
    "window",
    "document",
    "location",
    code,
  );
  await fn(
    {
      id: "local-frontend",
      version: "1.0.0",
      kind: "editor",
      handle: (name, handler) => handlers.set(name, handler),
      call: async (action, params) => {
        pluginCalls.push({ action, params });
        if (action === "status") return statusResponse;
        return { ok: true };
      },
      onDispose: (dispose) => disposers.push(dispose),
    },
    editor,
    {},
    {},
    null,
    windowObj,
    document,
    location,
  );
  return {
    document,
    toolbarDom,
    handlers,
    disposers,
    pluginCalls,
    navigations,
    windowListeners,
  };
}

test("local-frontend page script injects toolbar UI on playcanvas.com, ignores self-hosted Editors, and cleans up on dispose", async () => {
  // 1. Self-hosted Editor is untouched
  const selfhost = await runLocalFrontendPage({
    href: "https://pc-editor.sightp.com/editor/scene/12",
    selfhost: true,
    statusResponse: {
      ready: true,
      activeRelease: "playcanvas-editor-v2.28.1-r4",
      preference: "local",
      server: { port: 3487, listening: true },
    },
  });
  assert.equal(selfhost.toolbarDom.children.length, 0);
  assert.equal(selfhost.pluginCalls.length, 0);
  assert.equal(selfhost.navigations.length, 0);
  assert.deepEqual(selfhost.handlers.get("navigateMode")({ mode: "local" }), {
    ok: false,
    redirected: false,
    reason: "official-playcanvas-only",
  });

  // 2. Official playcanvas.com renders toolbar button + popover, switches modes preserving query & hash, and disposes cleanly
  const official = await runLocalFrontendPage({
    href: "https://playcanvas.com/editor/scene/2558608?foo=bar#viewport",
    selfhost: false,
    statusResponse: {
      ready: true,
      activeRelease: "playcanvas-editor-v2.28.1-r4",
      preference: null,
      server: { port: 3487, listening: true, error: null },
    },
  });
  assert.equal(official.toolbarDom.children.length, 1);
  assert.equal(official.document.body.children.length, 1);
  assert.equal(official.document.head.children.length, 1);

  const popover = official.document.body.children[0];
  const actionsRow = popover.children.find((c) => c.className === "local-frontend-actions");
  const useLocalBtn = actionsRow.children[0];
  const useOfficialBtn = actionsRow.children[1];
  assert.equal(useLocalBtn.disabled, false);
  assert.equal(useOfficialBtn.disabled, true);

  await useLocalBtn.handlers.click();
  assert.equal(official.navigations.length, 1);
  const switchedUrl = new URL(official.navigations[0]);
  assert.equal(switchedUrl.searchParams.get("foo"), "bar");
  assert.equal(switchedUrl.searchParams.has("use_local_frontend"), true);
  assert.equal(switchedUrl.hash, "#viewport");

  for (const dispose of official.disposers.reverse()) dispose();
  assert.equal(official.toolbarDom.children.length, 0);
  assert.equal(official.document.body.children.length, 0);
  assert.equal(official.document.head.children.length, 0);
  assert.equal(official.windowListeners.size, 0);

  // 3. Remembered 'local' preference auto-redirects on playcanvas.com ONLY when local server is ready
  const autoRedirected = await runLocalFrontendPage({
    href: "https://playcanvas.com/editor/scene/2558608?branch=dev",
    selfhost: false,
    statusResponse: {
      ready: true,
      activeRelease: "playcanvas-editor-v2.28.1-r4",
      preference: "local",
      server: { port: 3487, listening: true, error: null },
    },
  });
  assert.equal(autoRedirected.navigations.length, 1);
  assert.match(autoRedirected.navigations[0], /use_local_frontend/);

  const serverOfflineNoRedirect = await runLocalFrontendPage({
    href: "https://playcanvas.com/editor/scene/2558608?branch=dev",
    selfhost: false,
    statusResponse: {
      ready: false,
      activeRelease: null,
      preference: "local",
      server: { port: 3487, listening: false, error: null },
    },
  });
  assert.equal(serverOfflineNoRedirect.navigations.length, 0);
  assert.equal(serverOfflineNoRedirect.toolbarDom.children[0].dataset.warning, "true");
});
