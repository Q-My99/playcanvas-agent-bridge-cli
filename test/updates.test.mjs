import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { c as createTar } from "tar";
import { WebSocket } from "ws";
import { VERSION } from "../dist/config.js";

const cliPath = join(process.cwd(), "dist", "cli.js");

function spawnCli(args, options) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    result.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    result.stderr += chunk;
  });
  return result;
}

function waitForExit(result, timeoutMs = 15000) {
  if (result.child.exitCode !== null) return Promise.resolve(result.child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CLI did not exit. stdout: ${result.stdout}\nstderr: ${result.stderr}`));
    }, timeoutMs);
    result.child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function runCli(args, options) {
  const result = spawnCli(args, options);
  const status = await waitForExit(result);
  return { ...result, status, body: result.stdout ? JSON.parse(result.stdout) : null };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("update status, meta.updates, and one-click pcbridge update converge CLI, skills, extension, plugins, and daemon", { timeout: 25000 }, async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "updates-e2e-test-"));
  const configDir = join(root, "config");
  const workspaceRoot = join(root, "workspace");
  const customSkillsDir = join(root, "custom-skills");
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(customSkillsDir, { recursive: true }),
  ]);

  // Prepare a remote plugin archive for tinyapp-builder v1.2.0
  const archiveBuildDir = join(root, "archive-build/repo-main/plugins/tinyapp-builder");
  await mkdir(join(archiveBuildDir, "node"), { recursive: true });
  await mkdir(join(archiveBuildDir, "page"), { recursive: true });
  await writeFile(
    join(archiveBuildDir, "pcbridge-plugin.json"),
    JSON.stringify({
      id: "tinyapp-builder",
      name: "Tiny Builder",
      version: "1.2.0",
      apiVersion: 1,
      minPcbridgeVersion: "0.7.0",
      description: "Updated Tiny Builder",
      node: "node/index.js",
      page: { editor: "page/editor.js" },
      actions: { status: { description: "Status" } },
    }),
  );
  await writeFile(
    join(archiveBuildDir, "node/index.js"),
    'export function activate(plugin) { plugin.handle("status", () => ({ version: "1.2.0" })); }\n',
  );
  await writeFile(join(archiveBuildDir, "page/editor.js"), "// v1.2.0\n");
  const archiveFile = join(root, "repo-main.tar.gz");
  await createTar({ cwd: join(root, "archive-build"), file: archiveFile, gzip: true }, ["repo-main"]);

  let mockNpmVersion = "9.9.9";
  let mockPluginVersion = "1.0.0";
  const updateServer = createHttpServer(async (req, res) => {
    if (req.url === "/npm-latest") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: mockNpmVersion }));
      return;
    }
    if (req.url === "/plugins/index.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          plugins: [
            {
              id: "tinyapp-builder",
              name: "Tiny Builder",
              version: mockPluginVersion,
              apiVersion: 1,
              minPcbridgeVersion: "0.7.0",
              description: "Tiny Builder",
              subdir: "plugins/tinyapp-builder",
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve, reject) => {
    updateServer.once("error", reject);
    updateServer.listen(0, "127.0.0.1", resolve);
  });
  const serverAddress = updateServer.address();
  const mockServerPort = typeof serverAddress === "object" && serverAddress ? serverAddress.port : 0;

  const daemonPort = await freePort();
  const token = "update-test-session-token-1234567890";
  await writeFile(
    join(configDir, "session.json"),
    `${JSON.stringify({ token, port: daemonPort, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );

  const installMarkerFile = join(root, "installed-package-version.txt");
  const baseEnv = {
    ...process.env,
    TMPDIR: "/tmp",
    BUN_INSTALL_CACHE_DIR: "/tmp/bun-cache",
    PCBRIDGE_CONFIG_DIR: configDir,
    PCBRIDGE_SKIP_HOME_SKILL_PROBE: "1",
    PCBRIDGE_DISABLE_BACKGROUND_UPDATE_CHECK: "1",
    PCBRIDGE_UPDATE_MOCK_INSTALL_KIND: "bun-global",
    PCBRIDGE_NPM_LATEST_URL: `http://127.0.0.1:${mockServerPort}/npm-latest`,
    PCBRIDGE_PLUGINS_INDEX_URL: `http://127.0.0.1:${mockServerPort}/plugins/index.json`,
    PCBRIDGE_UPDATE_INSTALL_CMD: `printf "%s" "$PCBRIDGE_TARGET_VERSION" > "${installMarkerFile}"`,
  };

  const daemonProc = spawnCli(["daemon", "start", "--workspace", workspaceRoot], {
    cwd: root,
    env: baseEnv,
  });

  t.after(async () => {
    if (daemonProc.child.exitCode === null) daemonProc.child.kill("SIGTERM");
    await waitForExit(daemonProc).catch(() => null);
    await new Promise((resolve) => updateServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  // Wait for daemon to start listening
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`, {
        headers: { "X-PCBridge-Token": token },
      });
      if (res.ok) break;
    } catch {
      // Wait for startup.
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // Install initial skill into custom directory so update refreshes it
  const skillInstall = await runCli(
    ["install-skill", "--agent", "codex", "--path", customSkillsDir],
    { cwd: root, env: baseEnv },
  );
  assert.equal(skillInstall.status, 0, skillInstall.stderr);
  await writeFile(join(customSkillsDir, "playcanvas-agent-bridge-cli", "SKILL.md"), "stale-skill\n");

  // Connect a mock extension WebSocket target that handles bridge:reloadExtension
  const reloadRequests = [];
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/extension?token=${token}&clientId=ext-1`);
  t.after(() => ws.close());
  await once(ws, "open");
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "request" && msg.method === "bridge:reloadExtension") {
      reloadRequests.push(msg.params);
      ws.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          ok: true,
          data: { ok: true, reloading: true },
        }),
      );
    } else if (msg.type === "request") {
      ws.send(JSON.stringify({ type: "response", id: msg.id, ok: true, data: { plugins: [] } }));
    }
  });
  ws.send(
    JSON.stringify({
      type: "target:update",
      target: {
        clientId: "ext-1",
        tabId: 10,
        kind: "editor",
        extensionVersion: "0.6.0",
        url: "https://pc-editor.sightp.com/editor/scene/1",
        ready: true,
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 40));

  // 1. Check update status (--refresh writes update-state.json cache)
  const statusRes = await runCli(["update", "status", "--refresh"], { cwd: root, env: baseEnv });
  assert.equal(statusRes.status, 0, statusRes.stderr);
  assert.equal(statusRes.body.data.hasUpdates, true);
  assert.equal(statusRes.body.data.core.currentVersion, VERSION);
  assert.equal(statusRes.body.data.core.latestVersion, "9.9.9");
  assert.equal(statusRes.body.data.core.updateAvailable, true);
  assert.equal(statusRes.body.data.core.extensionReloadRequired, true);

  // 2. Subsequent regular CLI commands automatically include meta.updates from cache!
  const targetsRes = await runCli(["targets"], { cwd: root, env: baseEnv });
  assert.equal(targetsRes.status, 0, targetsRes.stderr);
  assert.ok(targetsRes.body.meta?.updates?.pcbridge);
  assert.equal(targetsRes.body.meta.updates.pcbridge.latestVersion, "9.9.9");
  assert.equal(targetsRes.body.meta.updates.pcbridge.command, "pcbridge update");

  // 3. Run one-click `pcbridge update`
  const applyRes = await runCli(["update"], { cwd: root, env: baseEnv });
  assert.equal(applyRes.status, 0, applyRes.stderr);
  assert.equal(applyRes.body.data.packageUpdated, true);
  assert.equal(await readFile(installMarkerFile, "utf8"), "9.9.9");
  assert.equal(applyRes.body.data.extensionReloadTriggered, true);
  assert.deepEqual(reloadRequests, [{ reloadTabs: true }]);
  assert.equal(applyRes.body.data.skillsRefreshed, 2);
  assert.equal(applyRes.body.data.daemonRestartTriggered, true);

  // Verify custom skill file was refreshed and extension directory was generated
  const refreshedSkill = await readFile(
    join(customSkillsDir, "playcanvas-agent-bridge-cli", "SKILL.md"),
    "utf8",
  );
  assert.notEqual(refreshedSkill, "stale-skill\n");
  await access(join(configDir, "extension", "manifest.json"));

  // Verify the daemon restarted in-place and is still serving the original workspaceRoot!
  const healthAfter = await fetch(`http://127.0.0.1:${daemonPort}/health`, {
    headers: { "X-PCBridge-Token": token },
  }).then((r) => r.json());
  assert.equal(healthAfter.ok, true);
  assert.equal(healthAfter.data.workspaceRoot, workspaceRoot);
});
