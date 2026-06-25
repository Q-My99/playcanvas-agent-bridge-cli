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
    folder: Array.isArray(path) && path.length ? path[path.length - 1] : null,
    tags: get("tags") || [],
    file: get("file") || null
  };
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
const mime = args.format === "png" ? "image/png" : "image/webp";
const dataUrl = dstCanvas.toDataURL(mime, Number(args.quality || 0.85));
return {
  mime,
  width: outWidth,
  height: outHeight,
  base64: dataUrl.split(",")[1]
};
`;
}
