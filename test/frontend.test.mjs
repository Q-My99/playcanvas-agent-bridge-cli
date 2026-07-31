import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { c as createTar } from "tar";
import { createDaemonServer } from "../dist/daemon/server.js";
import {
  FrontendError,
  getFrontendStatus,
  installFrontend,
  listFrontends,
  removeFrontend,
  useFrontend,
  validateFrontendManifest,
} from "../dist/frontend/store.js";
import { createFrontendServer } from "../dist/frontend/server.js";

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

async function runPopup(initialUrl, frontendData) {
  const elements = new Map();
  const updatedUrls = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const handlers = {};
        elements.set(id, {
          disabled: false,
          handlers,
          textContent: "",
          addEventListener(name, handler) {
            handlers[name] = handler;
          },
        });
      }
      return elements.get(id);
    },
  };
  const chrome = {
    runtime: {
      getURL: () => "chrome-extension://test/config.json",
    },
    tabs: {
      query: async () => [{ id: 123, url: initialUrl }],
      update: async (_id, update) => {
        updatedUrls.push(update.url);
      },
    },
  };
  const fetchMock = async (url) => {
    if (String(url).startsWith("chrome-extension:")) {
      return new Response(JSON.stringify({
        host: "127.0.0.1",
        port: 17329,
        token: "test-token",
      }));
    }
    if (!frontendData) throw new Error("daemon offline");
    return new Response(JSON.stringify({ ok: true, data: frontendData }));
  };
  const window = { close: () => undefined };
  const source = await readFile(join(process.cwd(), "extension/popup.js"), "utf8");
  vm.runInNewContext(source, {
    URL,
    chrome,
    console,
    document,
    fetch: fetchMock,
    Response,
    window,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, updatedUrls };
}

test("frontend releases install, switch, serve, and remove safely", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "frontend-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configRoot = join(root, "config");
  const firstRelease = "playcanvas-editor-v2.28.1-r99";
  const first = await makeFixture(root, firstRelease);
  assert.equal(validateFrontendManifest(first.manifest).release, firstRelease);

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

  const token = "test-token-that-is-long-enough";
  const daemon = createDaemonServer({
    token,
    port: 0,
    frontendPort: 0,
    frontendRootDir: configRoot,
  });
  await daemon.listen();
  t.after(() => daemon.close());
  const daemonBase = `http://127.0.0.1:${daemon.port}`;
  const daemonStatusResponse = await fetch(`${daemonBase}/frontend/status`, {
    headers: { "X-PCBridge-Token": token },
  });
  assert.equal(daemonStatusResponse.status, 200);
  const daemonStatus = await daemonStatusResponse.json();
  assert.equal(daemonStatus.ok, true);
  assert.equal(daemonStatus.data.activeRelease, firstRelease);
  assert.equal(daemonStatus.data.server.listening, true);

  const unauthorizedResponse = await fetch(`${daemonBase}/frontend/status`);
  assert.equal(unauthorizedResponse.status, 403);

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

test("extension popup preserves Editor URLs and always allows returning to official mode", async () => {
  const frontendData = {
    ready: true,
    activeRelease: "playcanvas-editor-v2.28.1-r1",
    server: {
      host: "127.0.0.1",
      port: 3487,
      listening: true,
      error: null,
    },
  };
  const official = await runPopup(
    "https://playcanvas.com/editor/scene/2558608?foo=bar#viewport",
    frontendData,
  );
  assert.equal(official.elements.get("use-custom").disabled, false);
  assert.equal(official.elements.get("use-official").disabled, true);
  await official.elements.get("use-custom").handlers.click();
  const customUrl = new URL(official.updatedUrls[0]);
  assert.equal(customUrl.searchParams.get("foo"), "bar");
  assert.equal(customUrl.searchParams.has("use_local_frontend"), true);
  assert.equal(customUrl.hash, "#viewport");

  const custom = await runPopup(
    "https://playcanvas.com/editor/scene/2558608?foo=bar&use_local_frontend",
    null,
  );
  assert.equal(custom.elements.get("use-custom").disabled, true);
  assert.equal(custom.elements.get("use-official").disabled, false);
  await custom.elements.get("use-official").handlers.click();
  const restoredUrl = new URL(custom.updatedUrls[0]);
  assert.equal(restoredUrl.searchParams.get("foo"), "bar");
  assert.equal(restoredUrl.searchParams.has("use_local_frontend"), false);
});

test("frontend install rejects a checksum mismatch", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "frontend-checksum-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const release = "playcanvas-editor-v2.28.1-r97";
  const fixture = await makeFixture(root, release);
  const invalidManifest = {
    ...fixture.manifest,
    archive: {
      ...fixture.manifest.archive,
      sha256: "0".repeat(64),
    },
  };

  await assert.rejects(
    installFrontend(release, {
      rootDir: join(root, "config"),
      fetch: fixtureFetch(invalidManifest, fixture.archive),
    }),
    (error) => error instanceof FrontendError && error.code === "FRONTEND_CHECKSUM_MISMATCH",
  );
});
