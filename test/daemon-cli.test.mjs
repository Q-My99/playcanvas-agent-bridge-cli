import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

const cliPath = join(process.cwd(), "dist", "cli.js");

function spawnCli(args, options) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { result.stdout += chunk; });
  child.stderr.on("data", (chunk) => { result.stderr += chunk; });
  return result;
}

function waitForExit(result, timeoutMs = 10000) {
  if (result.child.exitCode !== null) return Promise.resolve(result.child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CLI did not exit. stderr: ${result.stderr}`));
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
  return { ...result, status };
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

async function waitForWorkspace(port, token, workspaceRoot, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { "X-PCBridge-Token": token },
      });
      const body = await response.json();
      if (body.ok && body.data.workspaceRoot === workspaceRoot) return body;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Daemon did not switch to ${workspaceRoot}: ${String(lastError)}`);
}

test("daemon restart switches workspace roots and stop releases the process", { timeout: 20000 }, async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "daemon-cli-test-"));
  const workspaceA = join(root, "workspace a");
  const workspaceB = join(root, "workspace b");
  const configDir = join(root, "config");
  await Promise.all([
    mkdir(workspaceA),
    mkdir(workspaceB),
    mkdir(configDir),
  ]);

  const token = "daemon-cli-test-token-that-is-long-enough";
  const port = await freePort();
  await writeFile(join(configDir, "session.json"), `${JSON.stringify({
    token,
    port,
    createdAt: new Date().toISOString(),
  })}\n`);
  const options = {
    cwd: root,
    env: { ...process.env, PCBRIDGE_CONFIG_DIR: configDir },
  };
  const children = [];
  t.after(async () => {
    for (const result of children) {
      if (result.child.exitCode === null) result.child.kill("SIGTERM");
    }
    await Promise.all(children.map((result) => waitForExit(result).catch(() => null)));
    await rm(root, { recursive: true, force: true });
  });

  const first = spawnCli(["daemon", "start", "--workspace", workspaceA], options);
  children.push(first);
  await waitForWorkspace(port, token, workspaceA);

  const restarted = spawnCli([
    "daemon",
    "restart",
    "--workspace",
    "workspace b",
  ], options);
  children.push(restarted);
  const restartedHealth = await waitForWorkspace(port, token, workspaceB);
  assert.equal(restartedHealth.data.service, "pcbridge-daemon");
  assert.equal(await waitForExit(first), 0, first.stderr);

  const stopped = await runCli(["daemon", "stop"], options);
  assert.equal(stopped.status, 0, stopped.stderr);
  const stoppedBody = JSON.parse(stopped.stdout);
  assert.equal(stoppedBody.data.stopped, true);
  assert.equal(stoppedBody.data.previousWorkspaceRoot, workspaceB);
  assert.equal(await waitForExit(restarted), 0, restarted.stderr);
  assert.equal(JSON.parse(restarted.stdout).data.restarted, true);
});

test("daemon stop never shuts down an unverified port listener", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "daemon-foreign-listener-test-"));
  const configDir = join(root, "config");
  await mkdir(configDir);

  const requests = [];
  const foreignServer = createHttpServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(`${JSON.stringify({ ok: true, data: { service: "another-service" } })}\n`);
  });
  await new Promise((resolve, reject) => {
    foreignServer.once("error", reject);
    foreignServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => foreignServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const address = foreignServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await writeFile(join(configDir, "session.json"), `${JSON.stringify({
    token: "foreign-listener-token-that-is-long-enough",
    port,
    createdAt: new Date().toISOString(),
  })}\n`);

  const result = await runCli(["daemon", "stop"], {
    cwd: root,
    env: { ...process.env, PCBRIDGE_CONFIG_DIR: configDir },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "NOT_PCBRIDGE_DAEMON");
  assert.equal(foreignServer.listening, true);
  assert.deepEqual(requests, ["GET /health"]);
});
