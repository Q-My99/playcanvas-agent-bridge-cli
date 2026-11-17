import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
    configDir: join(root, "config"),
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
    configDir: join(root, "config"),
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

test("daemon validates workspace settings 1-10 MB and applies WebSocket workspace:delta", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "daemon-delta-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const token = "daemon-delta-token-that-is-long-enough";
  const daemon = createDaemonServer({
    token,
    port: 0,
    configDir: join(root, "config"),
    workspaceRoot: root,
  });
  await daemon.listen();
  t.after(() => daemon.close());

  const invalidResp = await fetch(`http://127.0.0.1:${daemon.port}/workspace/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PCBridge-Token": token },
    body: JSON.stringify({ eagerMaxMb: 25 }),
  });
  assert.equal(invalidResp.status, 400);

  const validResp = await fetch(`http://127.0.0.1:${daemon.port}/workspace/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PCBridge-Token": token },
    body: JSON.stringify({ eagerMaxMb: 6 }),
  });
  assert.equal(validResp.status, 200);
  assert.equal((await validResp.json()).data.eagerMaxMb, 6);

  const socket = new WebSocket(
    `ws://127.0.0.1:${daemon.port}/extension?token=${token}&clientId=delta-client`,
  );
  await once(socket, "open");
  t.after(() => socket.close());

  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "request" && msg.method === "bridge:workspaceSnapshot") {
      socket.send(JSON.stringify({
        type: "response",
        id: msg.id,
        ok: true,
        data: {
          assets: [{
            id: 1,
            name: "Armor",
            type: "material",
            path: [],
            file: null,
            data: { diffuse: [0.3, 0.3, 0.3] },
          }],
        },
      }));
    }
  });

  socket.send(JSON.stringify({
    type: "target:update",
    target: {
      clientId: "delta-client",
      tabId: 88,
      kind: "editor",
      url: "https://playcanvas.com/editor/scene/1",
      projectId: "888",
      projectName: "LiveDelta",
      sceneId: "1",
      branchId: "main",
      ready: true,
    },
  }));

  const armorPath = join(root, "888-LiveDelta", "assets", "Armor.material.json");
  for (let i = 0; i < 40; i++) {
    try {
      await readFile(armorPath, "utf8");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  assert.deepEqual(JSON.parse(await readFile(armorPath, "utf8")).data.diffuse, [0.3, 0.3, 0.3]);

  // Push incremental workspace:delta over WebSocket without any snapshot RPC!
  socket.send(JSON.stringify({
    type: "workspace:delta",
    clientId: "delta-client",
    tabId: 88,
    delta: {
      upsertedAssets: [{
        id: 1,
        name: "Armor",
        type: "material",
        path: [],
        file: null,
        data: { diffuse: [0.9, 0.8, 0.1] },
      }],
    },
  }));

  for (let i = 0; i < 40; i++) {
    const cur = JSON.parse(await readFile(armorPath, "utf8"));
    if (cur.data.diffuse[0] === 0.9) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.deepEqual(JSON.parse(await readFile(armorPath, "utf8")).data.diffuse, [0.9, 0.8, 0.1]);
});
