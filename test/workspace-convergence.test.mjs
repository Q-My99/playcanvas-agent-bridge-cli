import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceManager } from "../dist/workspace/manager.js";

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function makeTarget(id, projectId, projectName, sceneId = "100", sceneName = "Main") {
  return {
    id: `tab:${id}`,
    clientId: `client-${id}`,
    tabId: Number(id) || 1,
    kind: "editor",
    url: `https://playcanvas.com/editor/scene/${sceneId}`,
    projectId: String(projectId),
    projectName,
    sceneId: String(sceneId),
    sceneName,
    branchId: "main",
    branchName: "main",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  };
}

test("workspace eagerly syncs small text types and respects the 1-10 MB slider threshold", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-threshold-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const settingsPath = join(root, "workspace-settings.json");
  let shaderText = "void main() { gl_FragColor = vec4(1.0); }\n";
  const largeJsonText = JSON.stringify({ payload: "x".repeat(1500 * 1024) }); // ~1.5 MB
  const textWrites = [];
  let textReads = 0;

  const snapshot = () => ({
    assets: [
      { id: 1, name: "Shaders", type: "folder", path: [] },
      {
        id: 2,
        name: "toon.glsl",
        type: "shader",
        path: [1],
        file: { filename: "toon.glsl", hash: md5(shaderText), size: Buffer.byteLength(shaderText) },
      },
      {
        id: 3,
        name: "level-table.json",
        type: "json",
        path: [],
        file: {
          filename: "level-table.json",
          hash: md5(largeJsonText),
          size: Buffer.byteLength(largeJsonText),
        },
      },
      {
        id: 4,
        name: "albedo",
        type: "texture",
        path: [],
        meta: { width: 2048, height: 1024, format: "png", srgb: true },
        file: { filename: "albedo.png", hash: md5("pngbytes"), size: 8 },
      },
    ],
  });

  const manager = new WorkspaceManager({
    rootDir: root,
    eagerMaxMb: 1,
    settingsPath,
    localChangeDebounceMs: 60000,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") return { ok: true, data: snapshot() };
      if (method === "bridge:readAssetText") {
        textReads += 1;
        const id = String(params.assetId);
        if (id === "2") return { ok: true, data: { assetId: "2", filename: "toon.glsl", text: shaderText } };
        if (id === "3") return { ok: true, data: { assetId: "3", filename: "level-table.json", text: largeJsonText } };
      }
      if (method === "bridge:writeAssetText") {
        shaderText = String(params.text);
        textWrites.push({ id: String(params.assetId), text: shaderText });
        return { ok: true, data: { assetId: String(params.assetId), parsed: false } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());

  const target = makeTarget(1, "101", "Threshold");
  await manager.handleTarget(target);

  const projectDir = join(root, "101-Threshold");
  const shaderPath = join(projectDir, "assets", "Shaders", "toon.glsl");
  const largeJsonPath = join(projectDir, "assets", "level-table.json");

  // Small shader (<= 1 MB) synced eagerly; 1.5 MB JSON stayed lazy at 1 MB limit.
  assert.equal(await readFile(shaderPath, "utf8"), shaderText);
  await assert.rejects(access(largeJsonPath));
  assert.equal(textReads, 1);

  // Texture meta summary is exposed in pcbridge.project.json without downloading texture bytes.
  const manifest = JSON.parse(await readFile(join(projectDir, "pcbridge.project.json"), "utf8"));
  assert.deepEqual(manifest.assets["4"].meta, { width: 2048, height: 1024, format: "png", srgb: true });
  assert.equal(manifest.settings.sync.eagerMaxMb, 1);

  // Editing non-script text asset syncs back via bridge:writeAssetText.
  await writeFile(shaderPath, "void main() { gl_FragColor = vec4(0.5); }\n");
  await manager.syncTarget(target);
  assert.equal(textWrites.length, 1);
  assert.equal(textWrites[0].id, "2");

  // Raising slider threshold to 2 MB persists setting and automatically downloads the 1.5 MB JSON.
  const updated = await manager.updateSettings({ eagerMaxMb: 2 });
  assert.equal(updated.eagerMaxMb, 2);
  assert.equal(await readFile(largeJsonPath, "utf8"), largeJsonText);
  const savedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(savedSettings.eagerMaxMb, 2);
});

test("workspace bidirectionally syncs structured JSON assets with path-level 3-way merge", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-json-assets-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const remoteAssets = new Map([
    ["10", { id: 10, name: "Materials", type: "folder", path: [] }],
    ["11", {
      id: 11,
      name: "Hero",
      type: "material",
      path: [10],
      preload: true,
      tags: ["character"],
      file: null,
      data: {
        diffuse: [0.8, 0.2, 0.2],
        gloss: 0.5,
        metalness: 0.1,
        revision: 99,
      },
    }],
    ["12", {
      id: 12,
      name: "ImportedMat",
      type: "material",
      source_asset_id: 900,
      path: [10],
      preload: true,
      tags: [],
      file: null,
      data: { diffuse: [0.5, 0.5, 0.5] },
    }],
  ]);
  let nextId = 50;
  const patches = [];
  const creates = [];

  const manager = new WorkspaceManager({
    rootDir: root,
    localChangeDebounceMs: 60000,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") {
        return { ok: true, data: { assets: [...remoteAssets.values()] } };
      }
      if (method === "bridge:patchAssetData") {
        patches.push(params);
        const asset = remoteAssets.get(String(params.assetId));
        if (params.name) asset.name = params.name;
        if (typeof params.preload === "boolean") asset.preload = params.preload;
        if (Array.isArray(params.tags)) asset.tags = params.tags;
        for (const path of params.unsets || []) delete asset.data[path];
        for (const change of params.sets || []) asset.data[change.path] = change.value;
        return { ok: true, data: { asset } };
      }
      if (method === "bridge:createDataAsset") {
        creates.push(params);
        const id = nextId++;
        const created = {
          id,
          name: params.name,
          type: params.type,
          path: params.folder === "Materials" ? [10] : [],
          preload: params.preload !== false,
          tags: params.tags || [],
          file: null,
          data: params.data || {},
        };
        remoteAssets.set(String(id), created);
        return { ok: true, data: { asset: created, createdFolders: [] } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());

  const target = makeTarget(2, "202", "JsonAssets");
  await manager.handleTarget(target);

  const projectDir = join(root, "202-JsonAssets");
  const heroPath = join(projectDir, "assets", "Materials", "Hero.material.json");
  const derivedMatPath = join(projectDir, "assets", "Materials", "ImportedMat.material.json");

  const heroJson = JSON.parse(await readFile(heroPath, "utf8"));
  assert.deepEqual(heroJson.$pcbridge, { id: "11", kind: "asset", type: "material" });
  assert.equal(heroJson.data.revision, undefined, "transient fields must be stripped");
  assert.deepEqual(heroJson.data.diffuse, [0.8, 0.2, 0.2]);

  // Derived material is projected eagerly as read-only for Agent inspection.
  const derivedJson = JSON.parse(await readFile(derivedMatPath, "utf8"));
  assert.equal(derivedJson.$pcbridge.readonly, undefined);
  assert.equal(derivedJson.$pcbridge.sourceAssetId, "900");
  assert.notEqual((await stat(derivedMatPath)).mode & 0o200, 0, "imported material must be writable");

  // Editing an imported material with source_asset_id syncs back to Editor while keeping sourceAssetId.
  derivedJson.data.diffuse = [0.25, 0.75, 0.5];
  await writeFile(derivedMatPath, JSON.stringify(derivedJson, null, 2));
  await manager.syncTarget(target);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].assetId, "12");
  assert.deepEqual(remoteAssets.get("12").data.diffuse, [0.25, 0.75, 0.5]);
  assert.equal(JSON.parse(await readFile(derivedMatPath, "utf8")).$pcbridge.sourceAssetId, "900");
  patches.length = 0;

  // Formatting-only edit causes 0 RPC patches and 0 conflicts.
  await writeFile(heroPath, JSON.stringify({
    tags: ["character"],
    name: "Hero",
    preload: true,
    $pcbridge: heroJson.$pcbridge,
    data: { metalness: 0.1, gloss: 0.5, diffuse: [0.8, 0.2, 0.2] },
  }));
  await manager.syncTarget(target);
  assert.equal(patches.length, 0);

  // Simultaneous non-overlapping edits: Local edits diffuse, Remote edits gloss -> clean 3-way merge!
  const localEdit = JSON.parse(await readFile(heroPath, "utf8"));
  localEdit.data.diffuse = [0.1, 0.9, 0.1];
  await writeFile(heroPath, JSON.stringify(localEdit, null, 2));
  remoteAssets.get("11").data.gloss = 0.95;

  await manager.syncTarget(target);
  assert.equal(manager.statusForTarget(target).state, "synced");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].sets, [{ path: "diffuse", value: [0.1, 0.9, 0.1] }]);
  const mergedOnDisk = JSON.parse(await readFile(heroPath, "utf8"));
  assert.deepEqual(mergedOnDisk.data.diffuse, [0.1, 0.9, 0.1]);
  assert.equal(mergedOnDisk.data.gloss, 0.95);

  // Creating a brand-new .material.json locally creates remote asset and writes back $pcbridge.id.
  const newMatPath = join(projectDir, "assets", "Materials", "Gold.material.json");
  await writeFile(newMatPath, JSON.stringify({
    name: "Gold",
    tags: ["shiny"],
    data: { diffuse: [1, 0.84, 0], metalness: 1 },
  }, null, 2));
  await manager.syncTarget(target);
  assert.equal(creates.length, 1);
  const goldOnDisk = JSON.parse(await readFile(newMatPath, "utf8"));
  assert.equal(goldOnDisk.$pcbridge.id, "50");
  assert.deepEqual(goldOnDisk.data.diffuse, [1, 0.84, 0]);

  // Simultaneous conflicting edits to the SAME leaf path (data.diffuse) isolate conflict without data loss.
  const conflictLocal = JSON.parse(await readFile(heroPath, "utf8"));
  conflictLocal.data.diffuse = [0, 0, 1];
  await writeFile(heroPath, JSON.stringify(conflictLocal, null, 2));
  remoteAssets.get("11").data.diffuse = [1, 1, 0];
  await manager.syncTarget(target);
  assert.equal(manager.statusForTarget(target).state, "conflict");
  const conflictMeta = JSON.parse(
    await readFile(
      join(projectDir, "tmp", "conflicts", "11-Hero.material.json.conflict.json"),
      "utf8",
    ),
  );
  assert.deepEqual(conflictMeta.conflictingPaths, ["data.diffuse"]);
});

test("workspace deletes remote Tier 1 assets on local delete while keeping Tier 2 deletes as cache eviction", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-delete-rename-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let scriptText = "const speed = 10;\n";
  const texBytes = Buffer.from([9, 8, 7, 6]);
  const remoteAssets = new Map([
    ["1", { id: 1, name: "Scripts", type: "folder", path: [] }],
    ["2", {
      id: 2,
      name: "mover.js",
      type: "script",
      path: [1],
      file: { filename: "mover.js", hash: md5(scriptText), size: scriptText.length },
    }],
    ["3", {
      id: 3,
      name: "obsolete.js",
      type: "script",
      path: [1],
      file: { filename: "obsolete.js", hash: md5("const old = 1;\n"), size: 15 },
    }],
    ["4", {
      id: 4,
      name: "Spark",
      type: "material",
      path: [],
      file: null,
      data: { diffuse: [1, 1, 1] },
    }],
    ["5", {
      id: 5,
      name: "sky",
      type: "texture",
      path: [],
      file: { filename: "sky.png", hash: md5(texBytes), size: texBytes.length },
    }],
  ]);
  const deletedRemoteIds = [];
  const renames = [];
  const scriptWrites = [];
  let uploads = 0;

  const manager = new WorkspaceManager({
    rootDir: root,
    localChangeDebounceMs: 60000,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") {
        return { ok: true, data: { assets: [...remoteAssets.values()] } };
      }
      if (method === "bridge:readAssetText") {
        const id = String(params.assetId);
        if (id === "2") return { ok: true, data: { assetId: "2", filename: "mover.js", text: scriptText } };
        return { ok: true, data: { assetId: "3", filename: "obsolete.js", text: "const old = 1;\n" } };
      }
      if (method === "bridge:readAssetFile") {
        return { ok: true, data: { assetId: "5", filename: "sky.png", base64: texBytes.toString("base64") } };
      }
      if (method === "bridge:deleteAssets") {
        for (const id of params.assetIds || []) {
          deletedRemoteIds.push(String(id));
          remoteAssets.delete(String(id));
        }
        return { ok: true, data: { deletedIds: params.assetIds } };
      }
      if (method === "bridge:renameAsset") {
        renames.push(params);
        const asset = remoteAssets.get(String(params.assetId));
        asset.name = String(params.name);
        return { ok: true, data: { asset } };
      }
      if (method === "bridge:writeScriptText") {
        scriptText = String(params.text);
        remoteAssets.get(String(params.assetId)).file.hash = md5(scriptText);
        scriptWrites.push(params);
        return { ok: true, data: { assetId: String(params.assetId), parsed: true } };
      }
      if (method === "bridge:uploadAsset") {
        uploads += 1;
        return { ok: true, data: {} };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());

  const target = makeTarget(3, "303", "DeleteAndRename");
  await manager.handleTarget(target);
  await manager.pullAsset(target, "5");

  const projectDir = join(root, "303-DeleteAndRename");

  // 1. Delete Tier 1 script + Tier 1 material + Tier 2 pulled texture locally.
  await unlink(join(projectDir, "assets", "Scripts", "obsolete.js"));
  await unlink(join(projectDir, "assets", "Spark.material.json"));
  await unlink(join(projectDir, "assets", "sky.png"));
  await manager.syncTarget(target);

  // Tier 1 script (3) and material (4) were deleted remotely AND backed up in tmp/trash/local; Tier 2 texture (5) was NOT deleted remotely!
  assert.deepEqual(deletedRemoteIds.sort(), ["3", "4"]);
  assert.equal(remoteAssets.has("5"), true);
  const localTrash = await readdir(join(projectDir, "tmp", "trash", "local"), { recursive: true });
  assert.ok(localTrash.some((item) => String(item).endsWith("3-obsolete.js")));
  assert.ok(localTrash.some((item) => String(item).endsWith("4-Spark.material.json")));

  // 2. Rename AND simultaneously edit mover.js -> player-mover.js (POSIX inode preserved, Asset ID 2 preserved!).
  const oldScriptPath = join(projectDir, "assets", "Scripts", "mover.js");
  const newScriptPath = join(projectDir, "assets", "Scripts", "player-mover.js");
  await rename(oldScriptPath, newScriptPath);
  await writeFile(newScriptPath, "const speed = 25;\n");
  await manager.syncTarget(target);

  assert.equal(uploads, 0, "rename + edit must not upload a duplicate asset");
  assert.equal(deletedRemoteIds.includes("2"), false, "rename + edit must not delete the original asset");
  assert.equal(renames.length, 1);
  assert.equal(renames[0].assetId, "2");
  assert.equal(renames[0].name, "player-mover.js");
  assert.equal(scriptWrites.length, 1);
  assert.equal(scriptWrites[0].assetId, "2");
  assert.equal(scriptWrites[0].text, "const speed = 25;\n");
});

test("workspace syncs active scene bidirectionally with entity 3-way merge and keeps inactive scenes read-only", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "workspace-scenes-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const activeScene = {
    id: "100",
    name: "Main",
    active: true,
    settings: { physics: { gravity: [0, -9.8, 0] }, render: { exposure: 1 } },
    entities: {
      "root-id": {
        resource_id: "root-id",
        name: "Root",
        enabled: true,
        parent: null,
        children: ["cam-id", "box-id"],
        tags: [],
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        components: {},
      },
      "box-id": {
        resource_id: "box-id",
        name: "Box",
        enabled: true,
        parent: "root-id",
        children: [],
        tags: [],
        position: [0, 1, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        components: { render: { type: "box" } },
      },
      "cam-id": {
        resource_id: "cam-id",
        name: "Camera",
        enabled: true,
        parent: "root-id",
        children: [],
        tags: [],
        position: [0, 2, 5],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        components: { camera: { fov: 45 } },
      },
    },
  };
  const inactiveScene = {
    id: "200",
    name: "Menu",
    active: false,
    modified: "2026-10-29T00:00:00.000Z",
    settings: { render: { exposure: 1 } },
    entities: {
      "menu-root": {
        resource_id: "menu-root",
        name: "MenuRoot",
        enabled: true,
        parent: null,
        children: [],
        tags: [],
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        components: {},
      },
    },
  };

  let inactiveReads = 0;
  const scenePatches = [];

  const manager = new WorkspaceManager({
    rootDir: root,
    localChangeDebounceMs: 60000,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:workspaceSnapshot") {
        return {
          ok: true,
          data: {
            assets: [],
            activeScene: structuredClone(activeScene),
            scenes: [
              { id: "100", name: activeScene.name, modified: "2026-10-29T00:00:00.000Z" },
              { id: "200", name: inactiveScene.name, modified: inactiveScene.modified },
            ],
          },
        };
      }
      if (method === "bridge:readScene") {
        if (String(params.sceneId) === "100") return { ok: true, data: structuredClone(activeScene) };
        inactiveReads += 1;
        return { ok: true, data: structuredClone(inactiveScene) };
      }
      if (method === "bridge:patchScene") {
        scenePatches.push(params);
        for (const item of params.creates || []) {
          assert.deepEqual(item.entity.children, [], "creates must pass empty children array to PlayCanvas");
          const ent = { ...item.entity, children: [] };
          activeScene.entities[ent.resource_id] = ent;
          const parent = activeScene.entities[ent.parent];
          if (parent && !parent.children.includes(ent.resource_id)) {
            parent.children.push(ent.resource_id);
          }
        }
        for (const upd of params.updates || []) {
          const ent = activeScene.entities[upd.id];
          for (const comp of upd.removedComponents || []) delete ent.components[comp];
          for (const [comp, val] of Object.entries(upd.addedComponents || {})) ent.components[comp] = val;
          for (const change of upd.sets || []) {
            const segs = change.path.split(".");
            let cur = ent;
            for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]];
            cur[segs.at(-1)] = change.value;
          }
        }
        for (const delId of params.deletes || []) {
          const ent = activeScene.entities[delId];
          if (ent?.parent && activeScene.entities[ent.parent]) {
            activeScene.entities[ent.parent].children = activeScene.entities[ent.parent].children.filter((c) => c !== delId);
          }
          delete activeScene.entities[delId];
        }
        for (const change of params.settingsSets || []) {
          const segs = change.path.split(".");
          let cur = activeScene.settings;
          for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]];
          cur[segs.at(-1)] = change.value;
        }
        return { ok: true, data: { scene: structuredClone(activeScene) } };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  });
  t.after(() => manager.close());

  const target = makeTarget(4, "404", "SceneProject", "100", "Main");
  await manager.handleTarget(target);

  const projectDir = join(root, "404-SceneProject");
  const mainScenePath = join(projectDir, "scenes", "Main.100.scene.json");
  const menuScenePath = join(projectDir, "scenes", "Menu.200.scene.json");

  // Entities are ordered by DFS pre-order following Root.children: ["root-id", "cam-id", "box-id"].
  const mainJson = JSON.parse(await readFile(mainScenePath, "utf8"));
  assert.deepEqual(mainJson.$pcbridge, { id: "100", kind: "scene", active: true });
  assert.deepEqual(Object.keys(mainJson.entities), ["root-id", "cam-id", "box-id"]);
  assert.notEqual((await stat(mainScenePath)).mode & 0o200, 0, "active scene must be writable");
  const menuJson = JSON.parse(await readFile(menuScenePath, "utf8"));
  assert.deepEqual(menuJson.$pcbridge, { id: "200", kind: "scene", active: false, readonly: true });
  assert.equal((await stat(menuScenePath)).mode & 0o222, 0, "inactive scene must be read-only");
  assert.equal(inactiveReads, 1);

  // Second sync with unchanged inactive modified timestamp performs 0 extra inactive scene reads.
  await manager.syncTarget(target);
  assert.equal(inactiveReads, 1);

  // Forced local edit on inactive scene is quarantined and restored.
  await chmod(menuScenePath, 0o644);
  await writeFile(menuScenePath, '{"tampered": true}\n');
  await manager.syncTarget(target);
  assert.match(manager.statusForTarget(target).lastWarning, /pcbridge scene open --id 200/);
  assert.equal(JSON.parse(await readFile(menuScenePath, "utf8")).name, "Menu");
  assert.equal((await stat(menuScenePath)).mode & 0o222, 0);

  // Simultaneous non-overlapping edits on active scene:
  // - Local adds "lamp-id" (setting only parent: "root-id" without updating root.children!) and updates box position.
  // - Remote simultaneously updates camera fov and adds "remote-light-id" under root-id!
  const editedLocal = JSON.parse(await readFile(mainScenePath, "utf8"));
  editedLocal.entities["box-id"].position = [3, 4, 5];
  editedLocal.entities["lamp-id"] = {
    name: "Lamp",
    parent: "root-id",
    position: [1, 5, 0],
    components: { light: { type: "point", intensity: 2 } },
  };
  await writeFile(mainScenePath, JSON.stringify(editedLocal, null, 2));

  activeScene.entities["cam-id"].components.camera.fov = 60;
  activeScene.entities["remote-light-id"] = {
    resource_id: "remote-light-id",
    name: "Sun",
    enabled: true,
    parent: "root-id",
    children: [],
    tags: [],
    position: [0, 10, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    components: { light: { type: "directional" } },
  };
  activeScene.entities["root-id"].children.push("remote-light-id");

  await manager.syncTarget(target);
  assert.equal(manager.statusForTarget(target).state, "synced");
  assert.equal(scenePatches.length, 1);
  assert.equal(scenePatches[0].creates.length, 1);
  assert.equal(scenePatches[0].creates[0].entity.resource_id, "lamp-id");

  const mergedScene = JSON.parse(await readFile(mainScenePath, "utf8"));
  assert.deepEqual(mergedScene.entities["box-id"].position, [3, 4, 5]);
  assert.equal(mergedScene.entities["cam-id"].components.camera.fov, 60);
  assert.ok(mergedScene.entities["lamp-id"]);
  assert.ok(mergedScene.entities["remote-light-id"]);
  assert.ok(mergedScene.entities["root-id"].children.includes("lamp-id"));
  assert.ok(mergedScene.entities["root-id"].children.includes("remote-light-id"));

  // Switching active scene in Editor flips $pcbridge.active / readonly and file permissions on both files.
  await manager.handleDelta(target, {
    activeScene: {
      ...structuredClone(inactiveScene),
      active: true,
    },
  });
  const demotedMain = JSON.parse(await readFile(mainScenePath, "utf8"));
  const promotedMenu = JSON.parse(await readFile(menuScenePath, "utf8"));
  assert.deepEqual(demotedMain.$pcbridge, { id: "100", kind: "scene", active: false, readonly: true });
  assert.equal((await stat(mainScenePath)).mode & 0o222, 0);
  assert.deepEqual(promotedMenu.$pcbridge, { id: "200", kind: "scene", active: true });
  assert.notEqual((await stat(menuScenePath)).mode & 0o200, 0);

  // Incremental WebSocket handleDelta updates active scene & material with ZERO full snapshot RPCs!
  let snapshotCalls = 0;
  const deltaManager = new WorkspaceManager({
    rootDir: root,
    localChangeDebounceMs: 30,
    requestTarget: async (_target, method) => {
      if (method === "bridge:workspaceSnapshot") {
        snapshotCalls += 1;
        return {
          ok: true,
          data: {
            assets: [{
              id: 77,
              name: " Body ",
              type: "material",
              path: [],
              file: null,
              data: { diffuse: [0.2, 0.2, 0.2] },
            }],
            activeScene: structuredClone(activeScene),
          },
        };
      }
      throw new Error(`Unexpected RPC during delta handling: ${method}`);
    },
  });
  t.after(() => deltaManager.close());
  const deltaTarget = makeTarget(5, "505", "DeltaZeroPoll", "100", "Main");
  await deltaManager.handleTarget(deltaTarget);
  assert.equal(snapshotCalls, 1);

  await deltaManager.handleDelta(deltaTarget, {
    upsertedAssets: [{
      id: 77,
      name: "Body",
      type: "material",
      path: [],
      file: null,
      data: { diffuse: [0.9, 0.1, 0.1] },
    }],
    sceneDelta: {
      sceneId: "100",
      sceneName: "Main",
      upsertedEntities: {
        "box-id": {
          ...activeScene.entities["box-id"],
          position: [9, 9, 9],
        },
      },
    },
  });

  // Wait past fs.watch debounce to confirm self-write echo suppression triggers 0 extra RPCs.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(snapshotCalls, 1, "delta updates and self-write echoes must trigger 0 snapshot RPCs");

  const deltaProjectDir = join(root, "505-DeltaZeroPoll");
  const mat77 = JSON.parse(await readFile(join(deltaProjectDir, "assets", "Body.material.json"), "utf8"));
  assert.deepEqual(mat77.data.diffuse, [0.9, 0.1, 0.1]);
  const scene505 = JSON.parse(await readFile(join(deltaProjectDir, "scenes", "Main.100.scene.json"), "utf8"));
  assert.deepEqual(scene505.entities["box-id"].position, [9, 9, 9]);
});
