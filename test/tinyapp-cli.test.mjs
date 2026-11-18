import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { tinyappManageSnippet } from "../src/snippets.ts";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
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
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("pcbridge help tinyapp exposes structured TinyApp CLI surface and validates arguments", async () => {
  const overview = await runCli(["dist/cli.js", "help"]);
  assert.equal(overview.status, 0);
  assert.ok(JSON.parse(overview.stdout).data.commands.includes("pcbridge help tinyapp"));

  const topic = await runCli(["dist/cli.js", "help", "tinyapp"]);
  assert.equal(topic.status, 0);
  const commands = JSON.parse(topic.stdout).data.commands;
  assert.ok(commands.some((line) => line.startsWith("pcbridge tinyapp inspect")));
  assert.ok(commands.some((line) => line.startsWith("pcbridge tinyapp build")));
  assert.ok(commands.some((line) => line.startsWith("pcbridge tinyapp delete")));

  for (const invalid of [
    ["dist/cli.js", "tinyapp", "inspect"],
    ["dist/cli.js", "tinyapp", "build", "--template", "abc"],
    ["dist/cli.js", "tinyapp", "build", "--template", "12", "--child-strategy", "invalid"],
    ["dist/cli.js", "tinyapp", "delete"],
  ]) {
    const res = await runCli(invalid);
    assert.equal(res.status, 1);
    assert.equal(JSON.parse(res.stdout).error.code, "INVALID_REQUEST");
  }
});

test("tinyappManageSnippet supports self-hosted Editor APIs and reports clear fallback on official playcanvas.com", async () => {
  const snippet = tinyappManageSnippet();
  const fn = new AsyncFunction("editor", "window", "fetch", "command", snippet);

  // 1. Official playcanvas.com (no selfhost.tinyAppPipeline)
  const officialEditor = {
    api: { globals: { projectId: 100, branchId: "master", apiUrl: "https://playcanvas.com/api" } },
  };
  const officialStatus = await fn(officialEditor, { config: { project: { id: 100 } } }, async () => {
    throw new Error("should not fetch");
  }, { args: { action: "status" } });
  assert.equal(officialStatus.supported, false);
  assert.match(officialStatus.reason, /tinyapp-builder/);

  await assert.rejects(
    fn(officialEditor, { config: { project: { id: 100 } } }, async () => ({}), {
      args: { action: "build", templateAssetId: 5 },
    }),
    /only available on self-hosted/,
  );

  // 2. Self-hosted server (selfhost.tinyAppPipeline === 'server-v1')
  const requests = [];
  let buildPollCount = 0;
  const mockFetch = async (url, init = {}) => {
    requests.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/tinyapps?limit=10")) {
      return {
        ok: true,
        json: async () => ({
          service: { enabled: true, publicBaseUrl: "https://cdn.example.com" },
          totals: { buildCount: 1, templateCount: 1, totalBytes: 2048, orphanedBuildCount: 0 },
          templates: [],
        }),
      };
    }
    if (url.endsWith("/templates/88/tinyapp/builds") && init.method === "POST") {
      return {
        ok: true,
        json: async () => ({ id: 501, status: "running", version: 3 }),
      };
    }
    if (url.endsWith("/tinyapps/builds/501") && (!init.method || init.method === "GET")) {
      buildPollCount += 1;
      return {
        ok: true,
        json: async () => ({
          id: 501,
          status: buildPollCount >= 2 ? "complete" : "running",
          version: 3,
          publicUrl: "https://cdn.example.com/42/88-Booth-v3/tinyapp.json",
        }),
      };
    }
    if (url.endsWith("/tinyapps/builds/501?force=true") && init.method === "DELETE") {
      return {
        ok: true,
        json: async () => ({ deleted: { id: 501 }, deletedObjects: 4, freedBytes: 4096 }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const selfhostWindow = {
    config: {
      selfhost: { tinyAppPipeline: "server-v1" },
      project: { id: 42 },
      scene: { id: "9" },
      self: { branch: { id: "main" } },
      url: { api: "https://pc-editor.sightp.com/api" },
    },
  };
  const selfhostEditor = {
    api: {
      globals: {
        projectId: 42,
        branchId: "main",
        apiUrl: "https://pc-editor.sightp.com/api",
        accessToken: "tok",
      },
    },
  };

  const status = await fn(selfhostEditor, selfhostWindow, mockFetch, { args: { action: "status" } });
  assert.equal(status.supported, true);
  assert.equal(status.service.publicBaseUrl, "https://cdn.example.com");

  const built = await fn(selfhostEditor, selfhostWindow, mockFetch, {
    args: {
      action: "build",
      templateAssetId: 88,
      label: "Test CLI build",
      childStrategy: "reuse-if-unchanged",
      wait: true,
      waitTimeoutMs: 10000,
    },
  });
  assert.equal(built.status, "complete");
  assert.equal(built.publicUrl, "https://cdn.example.com/42/88-Booth-v3/tinyapp.json");

  const deleted = await fn(selfhostEditor, selfhostWindow, mockFetch, {
    args: { action: "delete", buildId: 501, force: true },
  });
  assert.equal(deleted.deletedObjects, 4);
});
