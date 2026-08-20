import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.project.id, "1552681");
  assert.equal(manifest.activeBranch.id, "99");
  assert.equal(manifest.assets["11"].local.path, "assets/Scripts/controller.js");
  assert.equal(manifest.assets["11"].local.hash.algorithm, "md5");
  assert.equal(manifest.assets["11"].local.hash.matchesRemote, true);
  assert.equal(manifest.assets["21"].local.present, false);
  assert.equal(manifest.assets["21"].local.hash.matchesRemote, null);
  assert.equal(binaryReads, 0);

  await writeFile(scriptPath, "const version = 2;\n");
  await manager.syncTarget(target);
  assert.equal(writes.at(-1), "const version = 2;\n");
  assert.equal(manager.statusForTarget(target).state, "local-change");
  const pendingManifest = JSON.parse(
    await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"),
  );
  assert.equal(pendingManifest.assets["11"].state, "local-change");
  assert.equal(pendingManifest.assets["11"].local.hash.matchesRemote, false);
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
  assert.equal(pulledManifest.assets["21"].local.hash.matchesRemote, true);
  assert.equal(pulledManifest.assets["21"].local.present, true);

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
  assert.equal(manifest.assets["11"].local.hash.base, hash(remoteEditedText));
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

test("workspace projects GLB-derived Assets with stable read-only collision names", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-glb-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const content = Buffer.from("glTF-test");
  let uploaded = false;
  let processed = false;
  let uploadCount = 0;
  let renameCount = 0;
  let binaryWriteCount = 0;
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
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") return { ok: true, data: snapshot() };
      if (method === "bridge:uploadAsset") {
        uploadCount += 1;
        uploaded = true;
        return { ok: true, data: { asset: snapshot().assets.find((asset) => asset.id === 11) } };
      }
      if (method === "bridge:renameAsset") {
        renameCount += 1;
        return { ok: true, data: {} };
      }
      if (method === "bridge:writeAssetFile") {
        binaryWriteCount += 1;
        return { ok: true, data: {} };
      }
      if (method === "bridge:readAssetFile") {
        binaryReads += 1;
        const id = String(params.assetId || "");
        const body = id === "12" ? Buffer.from("processed") : Buffer.from("model");
        return { ok: true, data: { assetId: id, filename: "scene.glb", base64: body.toString("base64") } };
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
  assert.equal(manifest.assets["11"].origin.role, "source");
  assert.equal(manifest.assets["11"].local.path, "assets/Models/scene.glb");
  assert.equal(manifest.assets["12"].origin.role, "derived");
  assert.equal(manifest.assets["12"].origin.sourceAssetId, "11");
  assert.equal(manifest.assets["12"].remoteFile.filename, "scene.glb");
  assert.equal(manifest.assets["12"].local.path, "assets/Models/scene.__pc_container_12.glb");
  assert.equal(manifest.assets["12"].local.present, false);
  assert.equal(manifest.assets["12"].local.writable, false);
  assert.equal(manifest.assets["13"].local.path, "assets/Models/scene.__pc_model_13.glb");

  const pulled = await manager.pullAsset(target, "12");
  assert.equal(pulled.hash, hash("processed"));
  assert.equal(binaryReads, 1);
  assert.equal(
    await readFile(join(root, "4-GLB", "assets", "Models", "scene.__pc_container_12.glb"), "utf8"),
    "processed",
  );
  await manager.syncTarget(target);
  assert.equal(uploadCount, 1, "derived projections must never be uploaded");

  const derivedPath = join(root, "4-GLB", "assets", "Models", "scene.__pc_container_12.glb");
  const movedDerivedPath = join(root, "4-GLB", "assets", "Models", "renamed-derived.glb");
  await rename(derivedPath, movedDerivedPath);
  await manager.syncTarget(target);
  assert.equal(await readFile(derivedPath, "utf8"), "processed");
  await assert.rejects(access(movedDerivedPath));
  await access(join(root, "4-GLB", "tmp", "conflicts", "12-renamed-derived.glb.derived-local"));
  assert.equal(uploadCount, 1);
  assert.equal(renameCount, 0);
  assert.equal(binaryWriteCount, 0);
});

test("workspace accepts stable downloaded content when PlayCanvas file metadata is stale", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-stale-metadata-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const content = Buffer.from("generated-font-atlas");
  const sourceContent = Buffer.from("font-source");
  const actualHash = hash(content);
  const staleHash = hash("previous-font-atlas");
  let reads = 0;
  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method) => {
      if (method === "bridge:workspaceSnapshot") {
        return {
          ok: true,
          data: {
            assets: [
              {
                id: 21,
                name: "font.ttf",
                type: "font",
                source: true,
                path: [],
                file: { filename: "font.ttf", hash: hash(sourceContent), size: sourceContent.length },
              },
              {
                id: 22,
                name: "font.ttf",
                type: "font",
                source: false,
                source_asset_id: 21,
                path: [],
                file: { filename: "font.png", hash: staleHash, size: content.length + 10 },
              },
            ],
          },
        };
      }
      if (method === "bridge:readAssetFile") {
        reads += 1;
        return { ok: true, data: { assetId: "22", filename: "font.png", base64: content.toString("base64") } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  const target = {
    id: "tab:font",
    clientId: "client-font",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/5",
    projectId: "5",
    projectName: "Font",
    sceneId: "5",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };

  await manager.handleTarget(target);
  const prepared = await manager.prepareAssetFiles(target, [22]);
  assert.equal(reads, 2);
  assert.equal(prepared.assets[0].hash, actualHash);
  assert.deepEqual(await readFile(prepared.assets[0].path), content);
  assert.match(manager.statusForTarget(target).lastWarning, /stale PlayCanvas file metadata/);
  const projectDirectory = join(root, "5-Font");
  const manifest = JSON.parse(await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"));
  assert.equal(manifest.assets["21"].origin.role, "source");
  assert.equal(manifest.assets["21"].local.path, "assets/font.ttf");
  assert.equal(manifest.assets["22"].origin.role, "derived");
  assert.equal(manifest.assets["22"].local.path, "assets/font.png");
  assert.equal(manifest.assets["22"].remoteFile.hash.advertised, staleHash);
  assert.equal(manifest.assets["22"].remoteFile.hash.observed, actualHash);
  assert.equal(manifest.assets["22"].remoteFile.size.effective, content.length);
  await access(join(projectDirectory, ".pcbridge", "objects", "22", actualHash, "font.png"));
  assert.equal((await stat(prepared.assets[0].path)).mode & 0o222, 0);

  await manager.prepareAssetFiles(target, [22]);
  assert.equal(reads, 2, "the observed hash should reuse the persistent object cache");
  await chmod(prepared.assets[0].path, 0o644);
  await writeFile(prepared.assets[0].path, "local derived edit");
  await manager.syncTarget(target);
  assert.deepEqual(await readFile(prepared.assets[0].path), content);
  assert.equal(reads, 2, "restoring a derived file should reuse the object cache");
  assert.match(manager.statusForTarget(target).lastWarning, /Ignored a local edit to derived Asset 22/);
  await access(join(projectDirectory, "tmp", "conflicts", "22-font.png.derived-local"));
});

test("workspace quarantines a deleted derivative before projecting its replacement", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-derived-reprocess-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceContent = Buffer.from("font-source");
  let derivedId = "92";
  let derivedContent = Buffer.from("atlas-v1");
  let reads = 0;
  let writes = 0;
  const snapshot = () => ({
    assets: [
      {
        id: 91,
        name: "font.ttf",
        type: "font",
        source: true,
        path: [],
        file: { filename: "font.ttf", hash: hash(sourceContent), size: sourceContent.length },
      },
      ...(derivedId ? [{
        id: Number(derivedId),
        name: "font.ttf",
        type: "font",
        source_asset_id: 91,
        path: [],
        file: { filename: "font.png", hash: hash(derivedContent), size: derivedContent.length },
      }] : []),
    ],
  });
  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") return { ok: true, data: snapshot() };
      if (method === "bridge:readAssetFile") {
        reads += 1;
        return {
          ok: true,
          data: {
            assetId: String(params.assetId),
            filename: "font.png",
            base64: derivedContent.toString("base64"),
          },
        };
      }
      if (method === "bridge:uploadAsset" || method === "bridge:writeAssetFile" || method === "bridge:renameAsset") {
        writes += 1;
        return { ok: true, data: {} };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  const target = {
    id: "tab:reprocess",
    clientId: "client-reprocess",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/9",
    projectId: "9",
    projectName: "Reprocess",
    sceneId: "9",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };
  const projectDirectory = join(root, "9-Reprocess");
  const projectionPath = join(projectDirectory, "assets", "font.png");

  await manager.handleTarget(target);
  await manager.pullAsset(target, derivedId);
  assert.equal(await readFile(projectionPath, "utf8"), "atlas-v1");

  derivedId = "";
  await manager.syncTarget(target);
  await manager.syncTarget(target);
  await assert.rejects(access(projectionPath));
  const trashEntries = await readdir(join(projectDirectory, "tmp", "trash", "remote"), { recursive: true });
  assert.ok(trashEntries.some((entry) => String(entry).endsWith("92-font.png")));

  derivedId = "93";
  derivedContent = Buffer.from("atlas-v2");
  await manager.syncTarget(target);
  let manifest = JSON.parse(await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"));
  assert.equal(manifest.assets["92"], undefined);
  assert.equal(manifest.assets["93"].projectionPath, "assets/font.png");
  assert.equal(manifest.assets["93"].local.present, false);
  await manager.pullAsset(target, derivedId);
  assert.equal(await readFile(projectionPath, "utf8"), "atlas-v2");
  manifest = JSON.parse(await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"));
  assert.equal(manifest.assets["93"].origin.sourceAssetId, "91");
  assert.equal(reads, 2);
  assert.equal(writes, 0);
});

test("workspace materializes managed build resources under assets", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-build-resource-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const mainContent = Buffer.from("texture-main");
  let remoteResource = Buffer.from("variant-v1");
  let mainReads = 0;
  let resourceReads = 0;
  let remoteWrites = 0;
  let manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") {
        return {
          ok: true,
          data: {
            assets: [
              { id: 100, name: "Textures", type: "folder", path: [] },
              {
                id: 101,
                name: "texture.png",
                type: "texture",
                path: [100],
                file: { filename: "texture.png", hash: hash(mainContent), size: mainContent.length },
              },
            ],
          },
        };
      }
      if (method === "bridge:readAssetResource") {
        resourceReads += 1;
        assert.equal(String(params.assetId), "101");
        assert.equal(params.url, "/texture-dxt");
        return {
          ok: true,
          data: {
            assetId: "101",
            filename: "texture-dxt.dds",
            base64: remoteResource.toString("base64"),
          },
        };
      }
      if (method === "bridge:readAssetFile") {
        mainReads += 1;
        return {
          ok: true,
          data: {
            assetId: "101",
            filename: "texture.png",
            base64: mainContent.toString("base64"),
          },
        };
      }
      if (method === "bridge:uploadAsset" || method === "bridge:writeAssetFile" || method === "bridge:renameAsset") {
        remoteWrites += 1;
        return { ok: true, data: {} };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  const target = {
    id: "tab:resource",
    clientId: "client-resource",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/10",
    projectId: "10",
    projectName: "Resources",
    sceneId: "10",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };

  await manager.handleTarget(target);
  const projectDirectory = join(root, "10-Resources");
  const legacyMainPath = join(projectDirectory, "tmp", "cache", "assets", "101", "texture.png");
  const legacyPath = join(projectDirectory, "tmp", "cache", "assets", "101", "texture-dxt.dds");
  await mkdir(join(legacyPath, ".."), { recursive: true });
  await writeFile(legacyMainPath, mainContent);
  await writeFile(legacyPath, remoteResource);

  const preparedAssets = await manager.prepareAssetFiles(target, [101]);
  assert.deepEqual(await readFile(preparedAssets.assets[0].path), mainContent);
  assert.equal(mainReads, 0, "the old primary cache should migrate without downloading again");
  await assert.rejects(access(legacyMainPath));
  await mkdir(join(legacyMainPath, ".."), { recursive: true });
  await writeFile(legacyMainPath, mainContent);
  await manager.prepareAssetFiles(target, [101]);
  await assert.rejects(access(legacyMainPath));
  assert.equal(mainReads, 0, "an existing assets projection should still clean an old primary cache");

  const request = () => [{
    assetId: 101,
    filename: "texture-dxt.dds",
    url: "/texture-dxt",
    hash: hash(remoteResource),
  }];
  let prepared = await manager.prepareAssetResources(target, request());
  const resourcePath = join(projectDirectory, "assets", "Textures", "texture-dxt.dds");
  assert.equal(prepared[0].path, resourcePath);
  assert.deepEqual(await readFile(resourcePath), remoteResource);
  assert.equal(resourceReads, 0, "the old tmp cache should migrate without downloading again");
  await assert.rejects(access(legacyPath));
  assert.equal((await stat(resourcePath)).mode & 0o222, 0);

  remoteResource = Buffer.from("variant-v2");
  prepared = await manager.prepareAssetResources(target, request());
  assert.deepEqual(await readFile(resourcePath), remoteResource);
  assert.equal(prepared[0].hash, hash(remoteResource));
  assert.equal(resourceReads, 1, "a changed remote hash should refresh the assets projection");

  await chmod(resourcePath, 0o644);
  await writeFile(resourcePath, "local resource edit");
  prepared = await manager.prepareAssetResources(target, request());
  assert.deepEqual(await readFile(resourcePath), remoteResource);
  assert.equal(resourceReads, 1, "a local edit should restore from the object cache");
  await access(join(projectDirectory, "tmp", "conflicts", "101-texture-dxt.dds.resource-local"));
  assert.match(manager.statusForTarget(target).lastWarning, /managed build resource/);

  const manifest = JSON.parse(await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"));
  assert.deepEqual(manifest.assets["101"].local.resources, [{
    filename: "texture-dxt.dds",
    url: "/texture-dxt",
    path: "assets/Textures/texture-dxt.dds",
    present: true,
    writable: false,
    size: remoteResource.length,
    hash: {
      algorithm: "md5",
      advertised: hash(remoteResource),
      observed: null,
      effective: hash(remoteResource),
      current: hash(remoteResource),
    },
  }]);

  await manager.syncTarget(target);
  assert.equal(remoteWrites, 0, "managed build resources must not be uploaded as new Assets");

  manager.close();
  manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method) => {
      if (method === "bridge:workspaceSnapshot") {
        return {
          ok: true,
          data: {
            assets: [
              { id: 100, name: "Textures", type: "folder", path: [] },
              {
                id: 101,
                name: "texture.png",
                type: "texture",
                path: [100],
                file: { filename: "texture.png", hash: hash(mainContent), size: mainContent.length },
              },
            ],
          },
        };
      }
      if (method === "bridge:uploadAsset" || method === "bridge:writeAssetFile" || method === "bridge:renameAsset") {
        remoteWrites += 1;
        return { ok: true, data: {} };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  await manager.handleTarget(target);
  await manager.syncTarget(target);
  assert.equal(remoteWrites, 0, "managed resources must remain indexed after a daemon restart");
  assert.deepEqual(await readFile(resourcePath), remoteResource);
});

test("workspace prepares lazy build dependencies concurrently", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-concurrent-build-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const contents = new Map(Array.from({ length: 4 }, (_, index) => {
    const id = String(index + 1);
    return [id, Buffer.from(`asset-${id}`)];
  }));
  let activeReads = 0;
  let maxActiveReads = 0;
  const manager = new WorkspaceManager({
    rootDir: root,
    refreshIntervalMs: 0,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") {
        return {
          ok: true,
          data: {
            assets: [...contents].map(([id, content]) => ({
              id,
              name: `${id}.bin`,
              type: "binary",
              source: false,
              source_asset_id: `source-${id}`,
              path: [],
              file: { filename: `${id}.bin`, hash: hash(content), size: content.length },
            })),
          },
        };
      }
      if (method === "bridge:readAssetFile") {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeReads -= 1;
        const id = String(params.assetId);
        return { ok: true, data: { assetId: id, filename: `${id}.bin`, base64: contents.get(id).toString("base64") } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  const target = {
    id: "tab:parallel",
    clientId: "client-parallel",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/6",
    projectId: "6",
    projectName: "Parallel",
    sceneId: "6",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };

  await manager.handleTarget(target);
  const prepared = await manager.prepareAssetFiles(target, [...contents.keys()]);
  assert.equal(prepared.assets.length, contents.size);
  assert.equal(maxActiveReads, 4);
});

test("workspace keeps duplicate remote names stable across refreshes and restarts", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-collision-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let reverseSnapshot = false;
  const assets = [
    { id: 20, name: "Shared", type: "folder", path: [] },
    { id: 10, name: "Shared", type: "folder", path: [] },
    {
      id: 30,
      name: "item.bin",
      type: "binary",
      source: true,
      path: [20],
      file: { filename: "item.bin", hash: hash("source"), size: 6 },
    },
    {
      id: 29,
      name: "item.__pc_model_32.bin",
      type: "binary",
      path: [20],
      file: { filename: "item.__pc_model_32.bin", hash: hash("natural"), size: 7 },
    },
    {
      id: 31,
      name: "item.bin",
      type: "binary",
      path: [20],
      file: { filename: "item.bin", hash: hash("standalone"), size: 10 },
    },
    {
      id: 32,
      name: "item.bin",
      type: "model",
      source_asset_id: 30,
      path: [20],
      file: { filename: "item.bin", hash: hash("derived"), size: 7 },
    },
    {
      id: 40,
      name: "item.bin",
      type: "binary",
      path: [10],
      file: { filename: "item.bin", hash: hash("other-folder"), size: 12 },
    },
  ];
  const requestTarget = async (_target, method) => {
    if (method !== "bridge:workspaceSnapshot") throw new Error(`Unexpected method ${method}`);
    return {
      ok: true,
      data: { assets: reverseSnapshot ? [...assets].reverse() : assets },
    };
  };
  const target = {
    id: "tab:collision",
    clientId: "client-collision",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/7",
    projectId: "7",
    projectName: "Collision",
    sceneId: "7",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };
  const manifestPath = join(root, "7-Collision", "pcbridge.project.json");
  const projectionPaths = async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    return Object.fromEntries(Object.entries(manifest.assets).map(([id, asset]) => [id, asset.projectionPath]));
  };

  let manager = new WorkspaceManager({ rootDir: root, refreshIntervalMs: 0, requestTarget });
  t.after(() => manager.close());
  await manager.handleTarget(target);
  const initialPaths = await projectionPaths();
  assert.equal(initialPaths["10"], "assets/Shared");
  assert.equal(initialPaths["20"], "assets/Shared.__pc_folder_20");
  assert.equal(initialPaths["30"], "assets/Shared.__pc_folder_20/item.bin");
  assert.equal(initialPaths["29"], "assets/Shared.__pc_folder_20/item.__pc_model_32.bin");
  assert.equal(initialPaths["31"], "assets/Shared.__pc_folder_20/item.__pc_binary_31.bin");
  assert.equal(initialPaths["32"], "assets/Shared.__pc_folder_20/item.__pc_model_32_2.bin");
  assert.equal(initialPaths["40"], "assets/Shared/item.bin");
  const firstManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(firstManifest.assets["30"].folder, "Shared");
  assert.equal(firstManifest.assets["40"].folder, "Shared");

  reverseSnapshot = true;
  await manager.syncTarget(target);
  assert.deepEqual(await projectionPaths(), initialPaths);

  manager.close();
  manager = new WorkspaceManager({ rootDir: root, refreshIntervalMs: 0, requestTarget });
  await manager.handleTarget(target);
  assert.deepEqual(await projectionPaths(), initialPaths);
});

test("workspace migrates a schema v2 manifest to schema v3", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-v2-migration-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectDirectory = join(root, "8-V2");
  const content = Buffer.from("v2-root-binary");
  const contentHash = hash(content);
  await mkdir(join(projectDirectory, "assets"), { recursive: true });
  await writeFile(join(projectDirectory, "assets", "root.bin"), content);
  await writeFile(join(projectDirectory, "pcbridge.project.json"), JSON.stringify({
    schemaVersion: 2,
    project: { id: "8", name: "V2" },
    activeBranch: { id: "main", name: "main" },
    scenes: [],
    workspace: {
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      lastSuccessfulSyncAt: "2026-08-01T00:00:00.000Z",
    },
    settings: { sync: { contentMode: "all" } },
    customMetadata: { keep: true },
    assets: {
      "81": {
        id: "81",
        name: "root.bin",
        type: "binary",
        folder: "",
        file: {
          filename: "root.bin",
          path: "assets/root.bin",
          size: content.length,
          present: true,
          hash: {
            algorithm: "md5",
            remote: contentHash,
            local: contentHash,
            base: contentHash,
            matches: true,
          },
        },
        state: "synced",
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
            assets: [{
              id: 81,
              name: "root.bin",
              type: "binary",
              path: [],
              file: { filename: "root.bin", hash: contentHash, size: content.length },
            }],
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());
  await manager.handleTarget({
    id: "tab:v2",
    clientId: "client-v2",
    kind: "editor",
    url: "https://playcanvas.com/editor/scene/8",
    projectId: "8",
    projectName: "V2",
    sceneId: "8",
    branchId: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  });

  assert.deepEqual(methods, ["bridge:workspaceSnapshot"]);
  const manifest = JSON.parse(await readFile(join(projectDirectory, "pcbridge.project.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.assets["81"].projectionPath, "assets/root.bin");
  assert.equal(manifest.assets["81"].local.path, "assets/root.bin");
  assert.equal(manifest.assets["81"].origin.role, "standalone");
  assert.equal(manifest.assets["81"].local.hash.current, contentHash);
  assert.equal(manifest.assets["81"].local.hash.base, contentHash);
  assert.equal(manifest.customMetadata.keep, true);
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
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.assets["101"].local.path, "assets/Scripts/legacy.js");
  assert.equal(manifest.assets["101"].remoteFile.hash.effective, hash(scriptText));
  assert.equal(manifest.assets["101"].local.hash.current, hash(scriptText));
  assert.equal(manifest.assets["101"].local.hash.base, hash(scriptText));
  assert.equal(manifest.assets["101"].local.hash.matchesRemote, true);
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
