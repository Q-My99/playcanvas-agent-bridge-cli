import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager, safeAssetName, safeWorkspaceName } from "../dist/workspace/manager.js";

function sha256(value) {
  return import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(value).digest("hex")
  );
}

test("workspace creates a project mirror, syncs scripts, and lazily pulls binaries", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let remoteText = "const version = 1;\n";
  let remoteHash = "remote-file-v1";
  let includeTemporaryFolder = true;
  const writes = [];
  const snapshot = () => ({
    assets: [
      { id: 10, name: "Scripts", type: "folder", path: [] },
      {
        id: 11,
        name: "controller.js",
        type: "script",
        path: [10],
        file: { filename: "controller.js", hash: remoteHash, size: remoteText.length },
      },
      { id: 20, name: "Textures", type: "folder", path: [] },
      {
        id: 21,
        name: "logo",
        type: "texture",
        path: [20],
        file: { filename: "logo.png", hash: "texture-v1", size: 4 },
      },
      ...(includeTemporaryFolder ? [{ id: 30, name: "Temporary", type: "folder", path: [] }] : []),
    ],
  });

  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") return { ok: true, data: snapshot() };
      if (method === "bridge:readAssetText") {
        return { ok: true, data: { assetId: "11", filename: "controller.js", text: remoteText } };
      }
      if (method === "bridge:writeScriptText") {
        remoteText = String(params.text);
        remoteHash = `remote-file-${writes.length + 2}`;
        writes.push(remoteText);
        return { ok: true, data: { assetId: "11", parsed: true } };
      }
      if (method === "bridge:readAssetFile") {
        return { ok: true, data: { assetId: "21", filename: "logo.png", base64: "AQIDBA==" } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());

  const target = {
    id: "tab:123",
    clientId: "client-1",
    tabId: 123,
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/2533764",
    projectId: "1552681",
    projectName: "pc bridge:test",
    sceneId: "2533764",
    sceneName: "Main",
    branchId: "99",
    branchName: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };

  await manager.handleTarget(target);
  const projectDirectory = join(root, "1552681-pc-bridge-test");
  const scriptPath = join(projectDirectory, "assets", "Scripts", "controller.js");
  assert.equal(await readFile(scriptPath, "utf8"), remoteText);
  const manifest = JSON.parse(await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"));
  assert.equal(manifest.project.id, "1552681");
  assert.equal(manifest.activeBranch.id, "99");

  await writeFile(scriptPath, "const version = 2;\n");
  await manager.syncTarget(target);
  assert.equal(writes.at(-1), "const version = 2;\n");

  remoteText = "const version = 3;\n";
  remoteHash = "remote-file-v3";
  await manager.syncTarget(target);
  assert.equal(await readFile(scriptPath, "utf8"), remoteText);

  const pulled = await manager.pullAsset(target, "21");
  assert.equal(pulled.assetId, "21");
  assert.deepEqual(
    Array.from(await readFile(join(projectDirectory, "assets", "Textures", "logo.png"))),
    [1, 2, 3, 4],
  );

  includeTemporaryFolder = false;
  await manager.syncTarget(target);
  await assert.rejects(access(join(projectDirectory, "assets", "Temporary")));

  await writeFile(scriptPath, "const version = 4;\n");
  remoteText = "const version = 5;\n";
  remoteHash = "remote-file-v5";
  await manager.syncTarget(target);
  const status = manager.statusForTarget(target);
  assert.equal(status.state, "conflict");
  assert.equal(status.counts.conflicts, 1);
  const conflicts = await readFile(
    join(projectDirectory, "tmp", "conflicts", "11-controller.js.remote"),
    "utf8",
  );
  assert.equal(conflicts, remoteText);
});

test("workspace names remove path separators and reserved characters", async () => {
  assert.equal(safeWorkspaceName("  Demo / Project:*  ", "project"), "Demo-Project");
  assert.equal(safeAssetName("Demo Folder / File.js", "asset"), "Demo Folder - File.js");
  assert.equal(safeWorkspaceName("...", "project"), "project");
  assert.equal((await sha256("same")).length, 64);
});
