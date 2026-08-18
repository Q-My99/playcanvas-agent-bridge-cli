import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager, safeAssetName, safeWorkspaceName } from "../dist/workspace/manager.js";

function hash(value, algorithm = "md5") {
  return createHash(algorithm).update(value).digest("hex");
}

test("workspace creates a project mirror and synchronizes scripts and binary assets", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let remoteText = "const version = 1;\n";
  let remoteHash = hash(remoteText);
  let scriptName = "New Asset~11";
  let scriptFileReady = false;
  let includeTemporaryFolder = true;
  let emptySnapshot = false;
  const temporaryText = "const temporary = true;\n";
  const writes = [];
  let binaryReads = 0;
  const snapshot = () => ({
    assets: emptySnapshot ? [] : [
      { id: 10, name: "Scripts", type: "folder", path: [] },
      {
        id: 11,
        name: scriptName,
        type: "script",
        path: [10],
        file: scriptFileReady
          ? { filename: "controller.js", hash: remoteHash, size: remoteText.length }
          : null,
      },
      { id: 20, name: "Textures", type: "folder", path: [] },
      {
        id: 21,
        name: "logo",
        type: "texture",
        path: [20],
        file: { filename: "logo.png", hash: hash(Buffer.from([1, 2, 3, 4])), size: 4 },
      },
      ...(includeTemporaryFolder ? [
        { id: 30, name: "Temporary", type: "folder", path: [] },
        {
          id: 31,
          name: "temporary.js",
          type: "script",
          path: [30],
          file: { filename: "temporary.js", hash: hash(temporaryText), size: temporaryText.length },
        },
      ] : []),
    ],
  });

  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") return { ok: true, data: snapshot() };
      if (method === "bridge:readAssetText") {
        if (String(params.assetId) === "31") {
          return { ok: true, data: { assetId: "31", filename: "temporary.js", text: temporaryText } };
        }
        return { ok: true, data: { assetId: "11", filename: "controller.js", text: remoteText } };
      }
      if (method === "bridge:writeScriptText") {
        remoteText = String(params.text);
        remoteHash = hash(remoteText);
        writes.push(remoteText);
        return { ok: true, data: { assetId: "11", parsed: true } };
      }
      if (method === "bridge:readAssetFile") {
        binaryReads += 1;
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
  const temporaryScriptPath = join(projectDirectory, "assets", "Scripts", "New Asset~11");
  assert.equal(await readFile(temporaryScriptPath, "utf8"), remoteText);

  scriptName = "controller.js";
  scriptFileReady = true;
  await manager.syncTarget(target);
  assert.equal(await readFile(scriptPath, "utf8"), remoteText);
  await assert.rejects(access(temporaryScriptPath));
  const manifest = JSON.parse(await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.project.id, "1552681");
  assert.equal(manifest.activeBranch.id, "99");
  assert.equal(manifest.assets["11"].file.path, "assets/Scripts/controller.js");
  assert.equal(manifest.assets["11"].file.hash.algorithm, "md5");
  assert.equal(manifest.assets["11"].file.hash.matches, true);
  assert.equal(manifest.assets["21"].file.present, false);
  assert.equal(manifest.assets["21"].file.hash.matches, null);
  assert.equal(binaryReads, 0);

  await writeFile(scriptPath, "const version = 2;\n");
  await manager.syncTarget(target);
  assert.equal(writes.at(-1), "const version = 2;\n");
  assert.equal(manager.statusForTarget(target).state, "local-change");
  const pendingManifest = JSON.parse(
    await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"),
  );
  assert.equal(pendingManifest.assets["11"].state, "local-change");
  assert.equal(pendingManifest.assets["11"].file.hash.matches, false);
  await manager.syncTarget(target);
  assert.equal(manager.statusForTarget(target).state, "synced");
  assert.equal(binaryReads, 0, "unchanged lazy binary should not be downloaded");
  const manifestPath = join(projectDirectory, "pcbridge.project.json");
  const stableManifest = await readFile(manifestPath, "utf8");
  const stableManifestMtime = (await stat(manifestPath)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.syncTarget(target);
  assert.equal(await readFile(manifestPath, "utf8"), stableManifest);
  assert.equal((await stat(manifestPath)).mtimeMs, stableManifestMtime);

  remoteText = "const version = 3;\n";
  remoteHash = hash(remoteText);
  await manager.syncTarget(target);
  assert.equal(await readFile(scriptPath, "utf8"), remoteText);

  const pulled = await manager.pullAsset(target, "21");
  assert.equal(pulled.assetId, "21");
  assert.deepEqual(
    Array.from(await readFile(join(projectDirectory, "assets", "Textures", "logo.png"))),
    [1, 2, 3, 4],
  );
  const pulledManifest = JSON.parse(
    await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"),
  );
  assert.equal(pulledManifest.assets["21"].file.hash.matches, true);
  assert.equal(pulledManifest.assets["21"].file.present, true);

  emptySnapshot = true;
  await manager.syncTarget(target);
  assert.equal(await readFile(scriptPath, "utf8"), remoteText);
  assert.match(manager.statusForTarget(target).lastWarning, /Ignored an empty PlayCanvas asset snapshot/);
  const guardedManifest = JSON.parse(
    await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"),
  );
  assert.ok(guardedManifest.assets["11"]);
  emptySnapshot = false;

  includeTemporaryFolder = false;
  await manager.syncTarget(target);
  await access(join(projectDirectory, "assets", "Temporary"));
  assert.match(manager.statusForTarget(target).lastWarning, /Deferred 2 possible remote deletions/);
  await manager.syncTarget(target);
  await assert.rejects(access(join(projectDirectory, "assets", "Temporary")));
  const trashBatches = await readdir(join(projectDirectory, "tmp", "trash", "remote"));
  assert.equal(trashBatches.length, 1);
  await access(join(
    projectDirectory,
    "tmp",
    "trash",
    "remote",
    trashBatches[0],
    "31-temporary.js",
  ));
  assert.deepEqual(
    (await readdir(join(projectDirectory, "tmp", "conflicts")))
      .filter((name) => name.startsWith("remote-deleted-")),
    [],
  );

  await writeFile(scriptPath, "const version = 4;\n");
  remoteText = "const version = 5;\n";
  remoteHash = hash(remoteText);
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

test("workspace accepts a remote script edit immediately after a local upload", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-script-race-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const initialText = "const initial = true;\n";
  const localText = initialText + 'var testSyncProp = "test local to remote";\n';
  const remoteEditedText = localText + 'var testSyncProp2 = "test remote to local";\n';
  let remoteText = initialText;
  let advertisedHash = hash(initialText);
  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    localChangeDebounceMs: 60000,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") {
        return {
          ok: true,
          data: {
            assets: [{
              id: 11,
              name: "race.js",
              type: "script",
              path: [],
              file: { filename: "race.js", hash: advertisedHash, size: remoteText.length },
            }],
          },
        };
      }
      if (method === "bridge:readAssetText") {
        return { ok: true, data: { assetId: "11", filename: "race.js", text: remoteText } };
      }
      if (method === "bridge:writeScriptText") {
        remoteText = String(params.text);
        // Deliberately leave advertisedHash stale to reproduce the Editor
        // observer lag seen immediately after a local upload.
        return { ok: true, data: { assetId: "11", parsed: true } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  const target = {
    id: "tab:script-race",
    clientId: "client-script-race",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/5",
    projectId: "5",
    projectName: "Script Race",
    sceneId: "5",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };

  await manager.handleTarget(target);
  const scriptPath = join(root, "5-Script-Race", "assets", "race.js");
  await writeFile(scriptPath, localText);
  await manager.syncTarget(target);
  assert.equal(manager.statusForTarget(target).state, "local-change");

  remoteText = remoteEditedText;
  advertisedHash = hash(remoteEditedText);
  await manager.syncTarget(target);

  assert.equal(await readFile(scriptPath, "utf8"), remoteEditedText);
  assert.equal(manager.statusForTarget(target).state, "synced");
  const manifest = JSON.parse(
    await readFile(join(root, "5-Script-Race", "pcbridge.project.json"), "utf8"),
  );
  assert.equal(manifest.assets["11"].file.hash.base, hash(remoteEditedText));
  assert.equal(manifest.assets["11"].state, "synced");
});

test("workspace uses the MD5 baseline for binary upload, download, and conflict copies", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-binary-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let remote = Buffer.from([1, 2, 3]);
  const uploads = [];
  const snapshot = () => ({
    assets: [
      { id: 10, name: "Textures", type: "folder", path: [] },
      {
        id: 11,
        name: "image",
        type: "texture",
        path: [10],
        file: { filename: "image.png", hash: hash(remote), size: remote.length },
      },
    ],
  });
  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") return { ok: true, data: snapshot() };
      if (method === "bridge:readAssetFile") {
        return {
          ok: true,
          data: { assetId: "11", filename: "image.png", base64: remote.toString("base64") },
        };
      }
      if (method === "bridge:writeAssetFile") {
        remote = Buffer.from(String(params.base64), "base64");
        uploads.push(remote);
        return { ok: true, data: { assetId: "11", filename: "image.png" } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  const target = {
    id: "tab:binary",
    clientId: "client-binary",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/2",
    projectId: "2",
    projectName: "Binary",
    sceneId: "2",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };

  await manager.handleTarget(target);
  const projectDirectory = join(root, "2-Binary");
  const imagePath = join(projectDirectory, "assets", "Textures", "image.png");
  await assert.rejects(access(imagePath));
  await manager.pullAsset(target, "11");
  assert.deepEqual(await readFile(imagePath), Buffer.from([1, 2, 3]));

  await writeFile(imagePath, Buffer.from([4, 5, 6]));
  await manager.syncTarget(target);
  assert.deepEqual(uploads.at(-1), Buffer.from([4, 5, 6]));
  assert.equal(manager.statusForTarget(target).state, "local-change");
  await manager.syncTarget(target);
  assert.equal(manager.statusForTarget(target).state, "synced");

  remote = Buffer.from([7, 8, 9]);
  await manager.syncTarget(target);
  assert.deepEqual(await readFile(imagePath), remote);

  await writeFile(imagePath, Buffer.from([10, 11, 12]));
  remote = Buffer.from([13, 14, 15]);
  await manager.syncTarget(target);
  assert.equal(manager.statusForTarget(target).state, "conflict");
  assert.deepEqual(
    await readFile(join(projectDirectory, "tmp", "conflicts", "11-image.png.local")),
    Buffer.from([10, 11, 12]),
  );
  assert.deepEqual(
    await readFile(join(projectDirectory, "tmp", "conflicts", "11-image.png.remote")),
    Buffer.from([13, 14, 15]),
  );
});

test("workspace preserves an uploaded Asset id when a local binary is renamed", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-rename-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const content = Buffer.from([1, 3, 3, 7]);
  let remoteName = null;
  let uploadCount = 0;
  let renameCount = 0;
  const snapshot = () => ({
    assets: [
      { id: 10, name: "Textures", type: "folder", path: [] },
      ...(remoteName ? [{
        id: 11,
        name: remoteName,
        type: "texture",
        source: true,
        path: [10],
        file: { filename: "photo.png", hash: hash(content), size: content.length },
      }] : []),
    ],
  });
  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    localChangeDebounceMs: 60000,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") return { ok: true, data: snapshot() };
      if (method === "bridge:uploadAsset") {
        uploadCount += 1;
        remoteName = String(params.filename);
        return { ok: true, data: { asset: snapshot().assets.at(-1) } };
      }
      if (method === "bridge:renameAsset") {
        renameCount += 1;
        assert.equal(String(params.assetId), "11");
        remoteName = String(params.name);
        return { ok: true, data: { asset: snapshot().assets.at(-1) } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  const target = {
    id: "tab:rename",
    clientId: "client-rename",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/3",
    projectId: "3",
    projectName: "Rename",
    sceneId: "3",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };

  await manager.handleTarget(target);
  const directory = join(root, "3-Rename", "assets", "Textures");
  const original = join(directory, "photo.png");
  const renamed = join(directory, "renamed.png");
  await writeFile(original, content);
  await manager.syncTarget(target);
  assert.equal(uploadCount, 1);

  await rename(original, renamed);
  await manager.syncTarget(target);
  await manager.syncTarget(target);
  assert.equal(renameCount, 1);
  assert.equal(uploadCount, 1);
  assert.equal(remoteName, "renamed.png");
  assert.equal(manager.statusForTarget(target).counts.conflicts, 0);
});

test("workspace ignores GLB-derived Assets instead of re-uploading them", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-glb-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const content = Buffer.from("glTF-test");
  let uploaded = false;
  let processed = false;
  let uploadCount = 0;
  let binaryReads = 0;
  const snapshot = () => ({
    assets: [
      { id: 10, name: "Models", type: "folder", path: [] },
      ...(uploaded ? [{
        id: 11,
        name: "scene.glb",
        type: "scene",
        source: true,
        path: [10],
        file: { filename: "scene.glb", hash: hash(content), size: content.length },
      }] : []),
      ...(processed ? [{
        id: 12,
        name: "scene.glb",
        type: "container",
        source: false,
        source_asset_id: 11,
        path: [10],
        file: { filename: "scene.glb", hash: hash("processed"), size: 9 },
      }, {
        id: 13,
        name: "scene.glb",
        type: "model",
        source: false,
        source_asset_id: 11,
        path: [10],
        file: { filename: "scene.glb", hash: hash("model"), size: 5 },
      }] : []),
    ],
  });
  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    localChangeDebounceMs: 60000,
    requestTarget: async (_target, method) => {
      if (method === "bridge:workspaceSnapshot") return { ok: true, data: snapshot() };
      if (method === "bridge:uploadAsset") {
        uploadCount += 1;
        uploaded = true;
        return { ok: true, data: { asset: snapshot().assets.find((asset) => asset.id === 11) } };
      }
      if (method === "bridge:readAssetFile") {
        binaryReads += 1;
        throw new Error("Derived GLB assets must remain lazy.");
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  const target = {
    id: "tab:glb",
    clientId: "client-glb",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/4",
    projectId: "4",
    projectName: "GLB",
    sceneId: "4",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };

  await manager.handleTarget(target);
  const sourcePath = join(root, "4-GLB", "assets", "Models", "scene.glb");
  await writeFile(sourcePath, content);
  await manager.syncTarget(target);
  processed = true;
  await manager.syncTarget(target);
  await manager.syncTarget(target);

  assert.equal(uploadCount, 1);
  assert.equal(binaryReads, 0);
  assert.equal(manager.statusForTarget(target).counts.conflicts, 0);
  const manifest = JSON.parse(await readFile(join(root, "4-GLB", "pcbridge.project.json"), "utf8"));
  assert.equal(manifest.assets["11"].file.path, "assets/Models/scene.glb");
  assert.equal(manifest.assets["12"].file, null);
  assert.equal(manifest.assets["13"].file, null);
});

test("workspace migrates the v1 hidden asset index into the project manifest", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-migration-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectDirectory = join(root, "44-Legacy-Project");
  const scriptDirectory = join(projectDirectory, "assets", "Scripts");
  await mkdir(scriptDirectory, { recursive: true });
  await mkdir(join(projectDirectory, ".pcbridge"), { recursive: true });
  const scriptText = "const legacy = true;\n";
  await writeFile(join(scriptDirectory, "legacy.js"), scriptText);
  await writeFile(join(projectDirectory, "pcbridge.project.json"), JSON.stringify({
    schemaVersion: 1,
    project: { id: "44", name: "Legacy Project" },
    activeBranch: { id: "main-44", name: "main" },
    scenes: [],
    workspace: { createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
    settings: { sync: { contentMode: "all" }, publish: { prefix: "tiny" } },
    customMetadata: { keep: true },
  }));
  await writeFile(join(projectDirectory, ".pcbridge", "asset-index.json"), JSON.stringify({
    schemaVersion: 1,
    projectId: "44",
    branchId: "main-44",
    updatedAt: "2026-08-01T00:00:00.000Z",
    entries: {
      "101": {
        id: "101",
        name: "legacy.js",
        type: "script",
        remotePath: ["Scripts"],
        localPath: "Scripts/legacy.js",
        filename: "legacy.js",
        remoteFileHash: hash(scriptText),
        localHash: hash(scriptText, "sha256"),
        lastSyncedHash: hash(scriptText, "sha256"),
        downloaded: true,
        status: "synced",
      },
    },
  }));

  const methods = [];
  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method) => {
      methods.push(method);
      if (method === "bridge:workspaceSnapshot") {
        return {
          ok: true,
          data: {
            assets: [
              { id: 100, name: "Scripts", type: "folder", path: [] },
              {
                id: 101,
                name: "legacy.js",
                type: "script",
                path: [100],
                file: { filename: "legacy.js", hash: hash(scriptText), size: scriptText.length },
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());

  await manager.handleTarget({
    id: "tab:44",
    clientId: "client-44",
    tabId: 44,
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/440",
    projectId: "44",
    projectName: "Legacy Project",
    sceneId: "440",
    sceneName: "Main",
    branchId: "main-44",
    branchName: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  });

  assert.deepEqual(methods, ["bridge:workspaceSnapshot"]);
  const manifest = JSON.parse(await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.assets["101"].file.path, "assets/Scripts/legacy.js");
  assert.equal(manifest.assets["101"].file.hash.remote, hash(scriptText));
  assert.equal(manifest.assets["101"].file.hash.local, hash(scriptText));
  assert.equal(manifest.assets["101"].file.hash.base, hash(scriptText));
  assert.equal(manifest.assets["101"].file.hash.matches, true);
  assert.equal(manifest.settings.sync.contentMode, "all");
  assert.equal(manifest.settings.publish.prefix, "tiny");
  assert.equal(manifest.customMetadata.keep, true);
  await access(join(projectDirectory, ".pcbridge", "asset-index.v1.json"));
  await assert.rejects(access(join(projectDirectory, ".pcbridge", "asset-index.json")));
});

test("workspace names remove path separators and reserved characters", async () => {
  assert.equal(safeWorkspaceName("  Demo / Project:*  ", "project"), "Demo-Project");
  assert.equal(safeAssetName("Demo Folder / File.js", "asset"), "Demo Folder - File.js");
  assert.equal(safeWorkspaceName("...", "project"), "project");
  assert.equal(hash("same").length, 32);
});
