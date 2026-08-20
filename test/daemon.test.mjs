import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/daemon/server.js";

test("daemon logs target connection transitions but not repeated target updates", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "daemon-workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const logs = [];
  const token = "daemon-test-token-that-is-long-enough";
  const daemon = createDaemonServer({
    token,
    port: 0,
    frontendPort: 0,
    frontendRootDir: join(root, "frontend"),
    workspaceRoot: root,
    log: (message) => logs.push(message),
  });
  await daemon.listen();
  t.after(() => daemon.close());

  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon.port}/extension?token=${token}&clientId=test-client`,
  );
  await once(socket, "open");
  const update = JSON.stringify({
    type: "target:update",
    target: {
      clientId: "test-client",
      tabId: 123,
      kind: "editor",
      url: "https://playcanvas.com/editor/scene/1",
      ready: false,
    },
  });
  socket.send(update);
  socket.send(update);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(logs.filter((line) => line.startsWith("connected ")).length, 1);

  socket.close();
  await once(socket, "close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(logs.filter((line) => line.startsWith("disconnected ")).length, 1);
  assert.equal(logs.some((line) => line.startsWith("target ")), false);

  const response = await fetch(`http://127.0.0.1:${daemon.port}/status?tabId=123`, {
    headers: { "X-PCBridge-Token": token },
  });
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.daemon.workspaceRoot, root);
});

test("daemon shutdown requires the session token and releases the listener", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "daemon-shutdown-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const token = "daemon-shutdown-token-that-is-long-enough";
  const daemon = createDaemonServer({
    token,
    port: 0,
    frontendPort: 0,
    frontendRootDir: join(root, "frontend"),
    workspaceRoot: root,
  });
  await daemon.listen();
  t.after(() => daemon.close());

  const badResponse = await fetch(`http://127.0.0.1:${daemon.port}/shutdown`, {
    method: "POST",
    headers: { "X-PCBridge-Token": "wrong-token" },
  });
  assert.equal(badResponse.status, 403);
  assert.equal((await badResponse.json()).error.code, "BAD_TOKEN");

  const healthResponse = await fetch(`http://127.0.0.1:${daemon.port}/health`, {
    headers: { "X-PCBridge-Token": token },
  });
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.data.service, "pcbridge-daemon");

  const shutdownResponse = await fetch(`http://127.0.0.1:${daemon.port}/shutdown`, {
    method: "POST",
    headers: { "X-PCBridge-Token": token },
  });
  assert.equal(shutdownResponse.status, 200);
  assert.equal((await shutdownResponse.json()).data.stopping, true);
  await daemon.closed;

  await assert.rejects(fetch(`http://127.0.0.1:${daemon.port}/health`, {
    headers: { "X-PCBridge-Token": token },
  }));
});
