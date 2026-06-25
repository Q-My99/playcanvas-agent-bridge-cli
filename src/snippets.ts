export const entityReader = `
function readEntity(entity) {
  const get = (path) => {
    try {
      return entity.get(path);
    } catch {
      return undefined;
    }
  };
  const components = get("components") || {};
  return {
    resource_id: get("resource_id"),
    name: get("name"),
    parent: get("parent"),
    enabled: get("enabled"),
    position: get("position"),
    rotation: get("rotation"),
    scale: get("scale"),
    tags: get("tags") || [],
    components: Object.keys(components || {})
  };
}
`;

export const assetReader = `
function readAsset(asset) {
  const get = (path) => {
    try {
      return asset.get(path);
    } catch {
      return undefined;
    }
  };
  const path = get("path") || [];
  return {
    id: get("id"),
    name: get("name"),
    type: get("type"),
    path,
    folder: Array.isArray(path) && path.length ? path[path.length - 1] : null,
    tags: get("tags") || [],
    file: get("file") || null
  };
}
`;

export const assetFolderHelpers = `
function splitAssetPath(path) {
  if (Array.isArray(path)) return path.map(String).map((part) => part.trim()).filter(Boolean);
  return String(path || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isChildFolder(asset, name, parent) {
  if (!asset || asset.get("type") !== "folder" || asset.get("name") !== name) return false;
  const path = asset.get("path") || [];
  if (!parent) return path.length === 0;
  return path[path.length - 1] === parent.get("id");
}

async function ensureFolderPath(assets, path) {
  const created = [];
  let parent = null;
  for (const name of splitAssetPath(path)) {
    let folder = assets.list().find((asset) => isChildFolder(asset, name, parent));
    if (!folder) {
      folder = await assets.createFolder({ name, folder: parent || undefined });
      created.push(folder);
    }
    parent = folder;
  }
  return { folder: parent, created };
}

async function resolveFolder(assets, args) {
  if (args.folderId !== undefined && args.folderId !== null && args.folderId !== "") {
    const folder = assets.get(Number(args.folderId));
    if (!folder || folder.get("type") !== "folder") {
      throw new Error("Folder asset not found: " + args.folderId);
    }
    return { folder, created: [] };
  }
  if (args.folder) {
    return ensureFolderPath(assets, args.folder);
  }
  return { folder: null, created: [] };
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
`;

export function entityListSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entities = editor.api.globals.entities;
let items = entities.list();
if (args.name) {
  const needle = String(args.name).toLowerCase();
  items = items.filter((entity) => String(entity.get("name") || "").toLowerCase().includes(needle));
}
if (args.component) {
  items = items.filter((entity) => Boolean(entity.get("components." + args.component)));
}
const total = items.length;
const offset = Math.max(0, Number(args.offset || 0));
const limit = Math.max(1, Math.min(Number(args.limit || 50), 500));
const page = items.slice(offset, offset + limit);
return {
  items: args.full ? page.map((entity) => entity.json()) : page.map(readEntity),
  total,
  offset,
  limit,
  hasMore: offset + page.length < total
};
`;
}

export function entityGetSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entity = editor.api.globals.entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
return args.full ? entity.jsonHierarchy() : readEntity(entity);
`;
}

export function entityCreateSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entities = editor.api.globals.entities;
const data = { ...(args.data || {}) };
if (!data.parent) {
  data.parent = entities.root;
} else if (typeof data.parent === "string") {
  const parent = entities.get(data.parent);
  if (!parent) {
    throw new Error("Parent entity not found: " + data.parent);
  }
  data.parent = parent;
}
data.position = data.position || [0, 0, 0];
data.rotation = data.rotation || [0, 0, 0];
data.scale = data.scale || [1, 1, 1];
data.enabled = data.enabled !== false;
data.components = data.components || {};
data.children = data.children || [];
data.tags = data.tags || [];
const entity = entities.create(data, { history: true, select: true });
if (!entity) {
  throw new Error("PlayCanvas did not return a created entity.");
}
return readEntity(entity);
`;
}

export function entityPatchSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entity = editor.api.globals.entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
for (const change of args.sets || []) {
  entity.set(change.path, change.value);
}
return readEntity(entity);
`;
}

export function entityDeleteSnippet(): string {
  return `
const args = command.args || {};
const entities = editor.api.globals.entities;
const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : [args.id];
const found = [];
const missing = [];
for (const id of ids) {
  const entity = entities.get(id);
  if (entity) found.push(entity);
  else missing.push(id);
}
if (!found.length) {
  return { affected: 0, deleted: [], missing };
}
await entities.delete(found, { history: true });
return {
  affected: found.length,
  deleted: found.map((entity) => ({
    resource_id: entity.get("resource_id"),
    name: entity.get("name")
  })),
  missing
};
`;
}

export function entityAddComponentSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entity = editor.api.globals.entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
if (!args.component) {
  throw new Error("component is required.");
}
entity.addComponent(args.component, args.data || {});
return readEntity(entity);
`;
}

export function entityRemoveComponentSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entity = editor.api.globals.entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
if (!args.component) {
  throw new Error("component is required.");
}
if (entity.get("components." + args.component)) {
  entity.removeComponent(args.component);
  return { affected: 1, entity: readEntity(entity) };
}
return { affected: 0, entity: readEntity(entity) };
`;
}

export function entitySetMaterialSnippet(): string {
  return `
${entityReader}
${assetReader}
const args = command.args || {};
const globals = editor.api.globals;
const entity = globals.entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
const material = globals.assets.get(Number(args.materialId));
if (!material || material.get("type") !== "material") {
  throw new Error("Material asset not found: " + args.materialId);
}
if (!entity.get("components.render")) {
  entity.addComponent("render", { type: args.renderType || "box" });
}
const slot = Math.max(0, Number(args.slot || 0));
const materialAssets = entity.get("components.render.materialAssets") || [];
while (materialAssets.length <= slot) {
  materialAssets.push(null);
}
materialAssets[slot] = material.get("id");
entity.set("components.render.materialAssets", materialAssets);
return {
  entity: readEntity(entity),
  material: readAsset(material),
  slot,
  materialAssets
};
`;
}

export function entityAddScriptSnippet(): string {
  return `
${entityReader}
${assetReader}
const args = command.args || {};
const globals = editor.api.globals;
const entity = globals.entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
let scriptName = args.scriptName;
let scriptAsset = null;
if (!scriptName && args.assetId !== undefined && args.assetId !== null) {
  scriptAsset = globals.assets.get(Number(args.assetId));
  if (!scriptAsset || scriptAsset.get("type") !== "script") {
    throw new Error("Script asset not found: " + args.assetId);
  }
  const scripts = Object.keys(scriptAsset.get("data.scripts") || {});
  if (scripts.length !== 1) {
    throw new Error("Use --script-name when the script asset has zero or multiple script definitions.");
  }
  scriptName = scripts[0];
}
if (!scriptName) {
  throw new Error("scriptName is required.");
}
if (!entity.get("components.script")) {
  entity.addComponent("script", { enabled: true, order: [], scripts: {} });
}
const attributes = args.attributes || {};
const existing = entity.get("components.script.scripts." + scriptName);
if (existing) {
  entity.set("components.script.scripts." + scriptName + ".enabled", args.enabled !== false);
  entity.set("components.script.scripts." + scriptName + ".attributes", {
    ...(existing.attributes || {}),
    ...attributes
  });
} else {
  entity.addScript(scriptName, {
    attributes,
    history: true
  });
}
const order = entity.get("components.script.order") || [];
if (!order.includes(scriptName)) {
  order.push(scriptName);
  entity.set("components.script.order", order);
}
return {
  entity: readEntity(entity),
  scriptName,
  scriptAsset: scriptAsset ? readAsset(scriptAsset) : null,
  script: entity.get("components.script.scripts." + scriptName)
};
`;
}

export function assetListSnippet(): string {
  return `
${assetReader}
const args = command.args || {};
const assets = editor.api.globals.assets;
let items = assets.list();
if (args.type) {
  items = items.filter((asset) => asset.get("type") === args.type);
}
if (args.name) {
  const needle = String(args.name).toLowerCase();
  items = items.filter((asset) => String(asset.get("name") || "").toLowerCase().includes(needle));
}
const total = items.length;
const offset = Math.max(0, Number(args.offset || 0));
const limit = Math.max(1, Math.min(Number(args.limit || 50), 500));
const page = items.slice(offset, offset + limit);
return {
  items: args.full ? page.map((asset) => asset.json()) : page.map(readAsset),
  total,
  offset,
  limit,
  hasMore: offset + page.length < total
};
`;
}

export function assetGetSnippet(): string {
  return `
${assetReader}
const args = command.args || {};
const asset = editor.api.globals.assets.get(Number(args.id));
if (!asset) {
  throw new Error("Asset not found: " + args.id);
}
return args.full ? asset.json() : readAsset(asset);
`;
}

export function assetFolderEnsureSnippet(): string {
  return `
${assetReader}
${assetFolderHelpers}
const args = command.args || {};
if (!args.path) {
  throw new Error("path is required.");
}
const assets = editor.api.globals.assets;
const result = await ensureFolderPath(assets, args.path);
return {
  folder: result.folder ? readAsset(result.folder) : null,
  created: result.created.map(readAsset)
};
`;
}

export function assetUploadSnippet(): string {
  return `
${assetReader}
${assetFolderHelpers}
const args = command.args || {};
if (!args.base64) {
  throw new Error("base64 file content is required.");
}
if (!args.name) {
  throw new Error("name is required.");
}
if (!args.type) {
  throw new Error("type is required.");
}
const assets = editor.api.globals.assets;
const folderResult = await resolveFolder(assets, args);
const blob = new Blob([bytesFromBase64(args.base64)], {
  type: args.mime || "application/octet-stream"
});
const asset = await assets.upload({
  name: args.name,
  type: args.type,
  folder: folderResult.folder || undefined,
  filename: args.filename || args.name,
  file: blob,
  preload: args.preload !== false
}, null);
return {
  asset: readAsset(asset),
  createdFolders: folderResult.created.map(readAsset)
};
`;
}

export function assetDeleteSnippet(): string {
  return `
${assetReader}
const args = command.args || {};
const assets = editor.api.globals.assets;
const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : [args.id];
const found = [];
const missing = [];
for (const id of ids) {
  const asset = assets.get(Number(id));
  if (asset) found.push(asset);
  else missing.push(id);
}
if (!found.length) {
  return { affected: 0, deleted: [], missing };
}
const deleted = found.map(readAsset);
await assets.delete(found);
return {
  affected: found.length,
  deleted,
  missing
};
`;
}

export function materialCreateSnippet(): string {
  return `
${assetReader}
${assetFolderHelpers}
const args = command.args || {};
if (!args.name) {
  throw new Error("name is required.");
}
const assets = editor.api.globals.assets;
const folderResult = await resolveFolder(assets, args);
const data = { ...(args.data || {}) };
if (args.diffuseMap !== undefined && args.diffuseMap !== null) {
  data.diffuseMap = Number(args.diffuseMap);
}
if (args.emissiveMap !== undefined && args.emissiveMap !== null) {
  data.emissiveMap = Number(args.emissiveMap);
}
if (args.normalMap !== undefined && args.normalMap !== null) {
  data.normalMap = Number(args.normalMap);
}
const material = await assets.createMaterial({
  name: args.name,
  folder: folderResult.folder || undefined,
  data,
  preload: args.preload !== false
});
for (const [key, value] of Object.entries(data)) {
  material.set("data." + key, value);
}
return {
  material: readAsset(material),
  data: {
    diffuseMap: material.get("data.diffuseMap"),
    emissiveMap: material.get("data.emissiveMap"),
    normalMap: material.get("data.normalMap")
  },
  createdFolders: folderResult.created.map(readAsset)
};
`;
}

export function scriptCreateSnippet(): string {
  return `
${assetReader}
${assetFolderHelpers}
const args = command.args || {};
if (!args.filename) {
  throw new Error("filename is required.");
}
const assets = editor.api.globals.assets;
const folderResult = await resolveFolder(assets, args);
const asset = await assets.createScript({
  filename: args.filename,
  text: String(args.text || ""),
  folder: folderResult.folder || undefined,
  preload: args.preload !== false
});
return {
  asset: readAsset(asset),
  scripts: asset.get("data.scripts") || {},
  createdFolders: folderResult.created.map(readAsset)
};
`;
}

export function scriptSetTextSnippet(): string {
  return `
${assetReader}
const args = command.args || {};
const globals = editor.api.globals;
const asset = globals.assets.get(Number(args.assetId));
if (!asset) {
  throw new Error("Asset not found: " + args.assetId);
}
if (asset.get("type") !== "script") {
  throw new Error("Asset is not a script: " + args.assetId);
}
const filename = asset.get("file.filename") || asset.get("name");
const form = new FormData();
form.append("filename", filename);
form.append("file", new Blob([String(args.text || "")], { type: "text/javascript" }), filename);
const branchId = window.config?.self?.branch?.id || window.config?.branch?.id;
if (branchId) {
  form.append("branchId", String(branchId));
}
const headers = {};
if (globals.accessToken) {
  headers.Authorization = "Bearer " + globals.accessToken;
}
const response = await fetch("/api/assets/" + asset.get("id"), {
  method: "PUT",
  headers,
  body: form
});
const body = await response.json().catch(() => ({}));
if (!response.ok || body.error) {
  throw new Error(body.error || "Failed to update script asset.");
}
return {
  asset: readAsset(asset),
  response: body
};
`;
}

export function scriptParseSnippet(): string {
  return `
${assetReader}
const args = command.args || {};
const asset = editor.api.globals.assets.get(Number(args.assetId));
if (!asset) {
  throw new Error("Asset not found: " + args.assetId);
}
const [error, data] = await new Promise((resolve) => {
  editor.call("scripts:parse", asset.observer, (...values) => resolve(values));
});
if (error) {
  throw new Error(String(error));
}
return {
  asset: readAsset(asset),
  scripts: data?.scripts || {}
};
`;
}

export function viewportCaptureSnippet(): string {
  return `
const args = command.args || {};
const app = editor.call("viewport:app");
if (!app) {
  throw new Error("Viewport app not found.");
}
const device = app.graphicsDevice;
const gl = device && device.gl;
if (!gl) {
  throw new Error("WebGL context not found.");
}
editor.call("viewport:render");
app.tick();
const width = device.width;
const height = device.height;
const pixels = new Uint8Array(width * height * 4);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
const flipped = new Uint8Array(width * height * 4);
const rowSize = width * 4;
for (let y = 0; y < height; y += 1) {
  flipped.set(
    pixels.subarray((height - 1 - y) * rowSize, (height - y) * rowSize),
    y * rowSize
  );
}
const srcCanvas = document.createElement("canvas");
srcCanvas.width = width;
srcCanvas.height = height;
srcCanvas.getContext("2d").putImageData(
  new ImageData(new Uint8ClampedArray(flipped.buffer), width, height),
  0,
  0
);
const maxWidth = Number(args.maxWidth || 1200);
let outWidth = width;
let outHeight = height;
if (maxWidth > 0 && width > maxWidth) {
  outWidth = maxWidth;
  outHeight = Math.round(height * (maxWidth / width));
}
const dstCanvas = document.createElement("canvas");
dstCanvas.width = outWidth;
dstCanvas.height = outHeight;
dstCanvas.getContext("2d").drawImage(srcCanvas, 0, 0, outWidth, outHeight);
const mime = args.format === "webp" ? "image/webp" : "image/png";
const dataUrl = dstCanvas.toDataURL(mime, Number(args.quality || 0.85));
return {
  mime,
  width: outWidth,
  height: outHeight,
  base64: dataUrl.split(",")[1]
};
`;
}
