import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { diagnoseDaemonConnection } from "../dist/cli.js";
import { normalizeError } from "../dist/shared/protocol.js";

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

test("doctor reports the Bun runtime independently of daemon availability", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const configDir = await mkdtemp(join(tmpBase, "bun-doctor-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await writeFile(join(configDir, "session.json"), JSON.stringify({
    token: "runtime-test-token-not-a-real-session",
    port: 1,
    createdAt: new Date().toISOString(),
  }));
  const result = await runCli(["dist/cli.js", "doctor"], {
    cwd: process.cwd(),
    env: { ...process.env, PCBRIDGE_CONFIG_DIR: configDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const { data } = JSON.parse(result.stdout);
  const runtime = data.checks.find(check => check.name === "bun");
  assert.equal(runtime.ok, true);
  assert.equal(runtime.version, process.versions.bun);
  assert.equal(data.healthy, false);
});

test("daemon connection diagnostics distinguish listener and loopback failures", () => {
  assert.equal(
    diagnoseDaemonConnection({ cause: { code: "ECONNREFUSED" } }).code,
    "DAEMON_NOT_LISTENING",
  );
  assert.equal(
    diagnoseDaemonConnection({ code: "ConnectionRefused" }).code,
    "DAEMON_NOT_LISTENING",
  );
  const denied = diagnoseDaemonConnection({ cause: { code: "EPERM" } });
  assert.equal(denied.code, "LOOPBACK_ACCESS_DENIED");
  assert.match(denied.nextAction, /loopback permission/i);
  assert.match(
    diagnoseDaemonConnection({ cause: { code: "ECONNREFUSED" } }, 4567).message,
    /127\.0\.0\.1:4567/,
  );
});

test("structured page error details survive daemon normalization", () => {
  assert.deepEqual(
    normalizeError({
      code: "SCRIPT_PARSE_INVALID",
      message: "invalid",
      details: { parserCompleted: true },
    }),
    {
      code: "SCRIPT_PARSE_INVALID",
      message: "invalid",
      details: { parserCompleted: true },
    },
  );
});

test("known CLI commands return a non-zero exit code for failed envelopes", async () => {
  const result = await runCli(["dist/cli.js", "template", "create"], {
    cwd: process.cwd(),
  });
  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "INVALID_REQUEST");

  const plugin = await runCli(["dist/cli.js", "plugin", "call", "tinyapp-builder"], {
    cwd: process.cwd(),
  });
  assert.equal(plugin.status, 1, plugin.stderr);
  assert.equal(JSON.parse(plugin.stdout).error.code, "INVALID_REQUEST");
});

test("mutation timeouts and target focus selectors are validated before RPC", async () => {
  const timeout = await runCli(
    ["dist/cli.js", "template", "apply", "--entity-id", "one", "--timeout-ms", "abc"],
    { cwd: process.cwd() },
  );
  assert.equal(timeout.status, 1);
  assert.equal(JSON.parse(timeout.stdout).error.code, "INVALID_REQUEST");

  const focus = await runCli(["dist/cli.js", "target", "focus"], {
    cwd: process.cwd(),
  });
  assert.equal(focus.status, 1);
  assert.equal(JSON.parse(focus.stdout).error.code, "INVALID_REQUEST");
});

test("install-skill supports one agent under a custom parent directory", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "install-skill-path-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cliPath = join(process.cwd(), "dist", "cli.js");

  const codex = await runCli(
    [cliPath, "install-skill", "--agent", "codex", "--path", "custom skills"],
    { cwd: root },
  );
  assert.equal(codex.status, 0, codex.stderr);
  const codexTarget = join(root, "custom skills", "playcanvas-agent-bridge-cli");
  assert.equal(JSON.parse(codex.stdout).data[0].path, codexTarget);
  await access(join(codexTarget, "SKILL.md"));
  await access(join(root, "custom skills", "pcbridge-plugin-authoring", "SKILL.md"));

  const cursorParent = join(root, "project", ".cursor", "rules");
  const cursor = await runCli(
    [cliPath, "install-skill", "--agent", "cursor", "--path", cursorParent],
    { cwd: root },
  );
  assert.equal(cursor.status, 0, cursor.stderr);
  const cursorTarget = join(cursorParent, "playcanvas-agent-bridge-cli.mdc");
  assert.equal(JSON.parse(cursor.stdout).data[0].path, cursorTarget);
  await access(cursorTarget);
  await access(join(cursorParent, "pcbridge-plugin-authoring.mdc"));

  const all = await runCli(
    [cliPath, "install-skill", "--agent", "all", "--path", join(root, "all")],
    { cwd: root },
  );
  assert.equal(all.status, 1, all.stderr);
  assert.equal(JSON.parse(all.stdout).error.code, "INVALID_REQUEST");
  await assert.rejects(access(join(root, "all")));
});
