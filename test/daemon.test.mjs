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
