import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
