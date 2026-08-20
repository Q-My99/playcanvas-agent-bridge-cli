import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { diagnoseDaemonConnection } from "../dist/cli.js";
import { normalizeError } from "../dist/shared/protocol.js";

test("daemon connection diagnostics distinguish listener and loopback failures", () => {
  assert.equal(
    diagnoseDaemonConnection({ cause: { code: "ECONNREFUSED" } }).code,
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

test("known CLI commands return a non-zero exit code for failed envelopes", () => {
  const result = spawnSync(process.execPath, ["dist/cli.js", "template", "create"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "INVALID_REQUEST");

  const builder = spawnSync(process.execPath, ["dist/cli.js", "builder", "start"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(builder.status, 1, builder.stderr);
  assert.equal(JSON.parse(builder.stdout).error.code, "INVALID_REQUEST");
});

test("mutation timeouts and target focus selectors are validated before RPC", () => {
  const timeout = spawnSync(
    process.execPath,
    ["dist/cli.js", "template", "apply", "--entity-id", "one", "--timeout-ms", "abc"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(timeout.status, 1);
  assert.equal(JSON.parse(timeout.stdout).error.code, "INVALID_REQUEST");

  const focus = spawnSync(process.execPath, ["dist/cli.js", "target", "focus"], {
    cwd: process.cwd(),
    encoding: "utf8",
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

  const codex = spawnSync(
    process.execPath,
    [cliPath, "install-skill", "--agent", "codex", "--path", "custom skills"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(codex.status, 0, codex.stderr);
  const codexTarget = join(root, "custom skills", "playcanvas-agent-bridge-cli");
  assert.equal(JSON.parse(codex.stdout).data[0].path, codexTarget);
  await access(join(codexTarget, "SKILL.md"));

  const cursorParent = join(root, "project", ".cursor", "rules");
  const cursor = spawnSync(
    process.execPath,
    [cliPath, "install-skill", "--agent", "cursor", "--path", cursorParent],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cursor.status, 0, cursor.stderr);
  const cursorTarget = join(cursorParent, "playcanvas-agent-bridge-cli.mdc");
  assert.equal(JSON.parse(cursor.stdout).data[0].path, cursorTarget);
  await access(cursorTarget);

  const all = spawnSync(
    process.execPath,
    [cliPath, "install-skill", "--agent", "all", "--path", join(root, "all")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(all.status, 1, all.stderr);
  assert.equal(JSON.parse(all.stdout).error.code, "INVALID_REQUEST");
  await assert.rejects(access(join(root, "all")));
});
