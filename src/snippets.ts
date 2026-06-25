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
if (args.tag) {
  items = items.filter((entity) => (entity.get("tags") || []).includes(args.tag));
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

export function entityCreateManySnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entitiesApi = editor.api.globals.entities;
const definitions = Array.isArray(args.entities) && args.entities.length ? args.entities : [];
if (!definitions.length) {
  throw new Error("entities must be a non-empty array.");
}
const created = [];
for (const definition of definitions) {
  const data = { ...(definition.entity || definition) };
  const parentId = definition.parent || data.parent;
  if (!parentId) {
    data.parent = entitiesApi.root;
  } else if (typeof parentId === "string") {
    const parent = entitiesApi.get(parentId);
    if (!parent) {
      throw new Error("Parent entity not found: " + parentId);
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
  const entity = entitiesApi.create(data, { history: true, select: false });
  if (!entity) {
    throw new Error("PlayCanvas did not return a created entity.");
  }
  created.push(entity);
}
if (created.length) {
  editor.api.globals.selection.set(created, { history: true });
}
return {
  affected: created.length,
  entities: created.map(readEntity)
};
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

export function entityPatchManySnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entities = editor.api.globals.entities;
const edits = Array.isArray(args.edits) ? args.edits : [];
if (!edits.length) {
  throw new Error("edits must be a non-empty array.");
}
const changed = new Map();
const missing = [];
for (const edit of edits) {
  const entity = entities.get(edit.id);
  if (!entity) {
    missing.push(edit.id);
    continue;
  }
  entity.set(edit.path, edit.value);
  changed.set(edit.id, entity);
}
return {
  affected: changed.size,
  entities: Array.from(changed.values()).map(readEntity),
  missing
};
`;
}

export function entityDuplicateSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entitiesApi = editor.api.globals.entities;
const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : [args.id];
const entities = ids.map((id) => entitiesApi.get(id)).filter(Boolean);
const missing = ids.filter((id) => !entitiesApi.get(id));
if (!entities.length) {
  return { affected: 0, duplicated: [], missing };
}
const duplicatedResult = await entitiesApi.duplicate(entities);
const duplicated = Array.isArray(duplicatedResult)
  ? duplicatedResult.filter(Boolean)
  : duplicatedResult
    ? [duplicatedResult]
    : [];
return {
  affected: duplicated.length,
  duplicated: duplicated.map(readEntity),
  missing
};
`;
}

export function entityReparentSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entities = editor.api.globals.entities;
const entity = entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
const parent = entities.get(args.parent);
if (!parent) {
  throw new Error("Parent entity not found: " + args.parent);
}
if (typeof entity.reparent === "function") {
  entity.reparent(parent, args.index === undefined || args.index === null ? undefined : Number(args.index), {
    history: true,
    preserveTransform: args.preserveTransform !== false
  });
} else {
  await entities.reparent([{ entity, parent, index: args.index }], {
    history: true,
    preserveTransform: args.preserveTransform !== false
  });
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
  return { affected: 0, deleted: [], missing, fallback: null };
}
const deleted = found.map((entity) => ({
  resource_id: entity.get("resource_id"),
  name: entity.get("name")
}));
let fallback = null;
try {
  await entities.delete(found);
} catch (error) {
  fallback = error instanceof Error ? error.message : String(error);
  for (const item of deleted) {
    const entity = entities.get(item.resource_id);
    if (entity) {
      entities.remove(entity);
    }
  }
}
return {
  affected: found.length,
  deleted,
  missing,
  fallback
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

export function entityAddComponentsSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entity = editor.api.globals.entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
const components = args.components || {};
if (!components || typeof components !== "object" || Array.isArray(components)) {
  throw new Error("components must be a JSON object.");
}
for (const [name, data] of Object.entries(components)) {
  if (entity.get("components." + name)) {
    entity.set("components." + name, {
      ...(entity.get("components." + name) || {}),
      ...(data || {})
    });
  } else {
    entity.addComponent(name, data || {});
  }
}
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

export function entityRemoveComponentsSnippet(): string {
  return `
${entityReader}
const args = command.args || {};
const entity = editor.api.globals.entities.get(args.id);
if (!entity) {
  throw new Error("Entity not found: " + args.id);
}
const components = Array.isArray(args.components) ? args.components : [];
if (!components.length) {
  throw new Error("components must be a non-empty array.");
}
const removed = [];
for (const component of components) {
  if (entity.get("components." + component)) {
    entity.removeComponent(component);
    removed.push(component);
  }
}
return {
  affected: removed.length,
  removed,
  entity: readEntity(entity)
};
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
if (args.tag) {
  items = items.filter((asset) => (asset.get("tags") || []).includes(args.tag));
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

export function assetCreateManySnippet(): string {
  return `
${assetReader}
const args = command.args || {};
const assetsApi = editor.api.globals.assets;
const entitiesApi = editor.api.globals.entities;
const defs = Array.isArray(args.assets) && args.assets.length ? args.assets : [];
if (!defs.length) {
  throw new Error("assets must be a non-empty array.");
}
const created = [];
for (const definition of defs) {
  const type = definition.type;
  const options = { ...(definition.options || {}) };
  if (options.folder !== undefined && options.folder !== null && options.folder !== "") {
    const folder = assetsApi.get(Number(options.folder));
    if (!folder || folder.get("type") !== "folder") {
      throw new Error("Folder asset not found: " + options.folder);
    }
    options.folder = folder;
  }
  let templateSourceEntity = null;
  if (type === "template") {
    const entity = entitiesApi.get(options.entity);
    if (!entity) {
      throw new Error("Template source entity not found: " + options.entity);
    }
    templateSourceEntity = entity;
    options.entity = entity;
  }

  let asset = null;
  if (type === "material" && options.data && options.data.name && !options.name) {
    options.name = options.data.name;
  }
  if (type === "css") asset = await assetsApi.createCss(options);
  else if (type === "folder") asset = await assetsApi.createFolder(options);
  else if (type === "html") asset = await assetsApi.createHtml(options);
  else if (type === "material") asset = await assetsApi.createMaterial(options);
  else if (type === "script") asset = await assetsApi.createScript(options);
  else if (type === "shader") asset = await assetsApi.createShader(options);
  else if (type === "template") {
    asset = await assetsApi.createTemplate(options);
    if (!asset && templateSourceEntity) {
      const templateId = templateSourceEntity.get("template_id");
      asset = templateId ? assetsApi.get(Number(templateId)) : null;
    }
  }
  else if (type === "text") asset = await assetsApi.createText(options);
  else throw new Error("Unsupported asset type: " + type);

  if (!asset) {
    throw new Error("Failed to create asset of type: " + type);
  }
  created.push(asset);
}
return {
  affected: created.length,
  assets: created.map(readAsset)
};
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

export function assetInstantiateTemplateSnippet(): string {
  return `
${entityReader}
${assetReader}
const args = command.args || {};
const assetsApi = editor.api.globals.assets;
const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : [args.id];
const templates = [];
const missing = [];
for (const id of ids) {
  const asset = assetsApi.get(Number(id));
  if (!asset) {
    missing.push(id);
    continue;
  }
  if (asset.get("type") !== "template") {
    throw new Error("Asset is not a template: " + id);
  }
  templates.push(asset);
}
if (!templates.length) {
  return { affected: 0, entities: [], missing };
}
const entities = await assetsApi.instantiateTemplates(templates);
return {
  affected: entities.length,
  entities: entities.map(readEntity),
  templates: templates.map(readAsset),
  missing
};
`;
}

export function templateCreateSnippet(): string {
  return `
${entityReader}
${assetReader}
${assetFolderHelpers}
const args = command.args || {};
const assetsApi = editor.api.globals.assets;
const entitiesApi = editor.api.globals.entities;
const id = args.entityId || args.id;
if (!id) {
  throw new Error("entityId is required.");
}
const entity = entitiesApi.get(id);
if (!entity) {
  throw new Error("Template source entity not found: " + id);
}
const folderResult = await resolveFolder(assetsApi, args);
const name = args.name || entity.get("name") || "Template";
const beforeTemplateIds = new Set(
  assetsApi
    .list()
    .filter((asset) => asset.get("type") === "template")
    .map((asset) => asset.get("id"))
);

let asset = await assetsApi.createTemplate({
  name,
  entity,
  folder: folderResult.folder || undefined,
  preload: args.preload !== false
});

if (!asset) {
  const templateId = entity.get("template_id");
  asset = templateId ? assetsApi.get(Number(templateId)) : null;
}

if (!asset) {
  const createdTemplates = assetsApi
    .list()
    .filter((candidate) =>
      candidate.get("type") === "template" &&
      !beforeTemplateIds.has(candidate.get("id")) &&
      candidate.get("name") === name
    );
  asset = createdTemplates[createdTemplates.length - 1] || null;
}

if (!asset) {
  throw new Error("Failed to create template asset.");
}

return {
  template: readAsset(asset),
  sourceEntity: readEntity(entity),
  templateId: entity.get("template_id") || asset.get("id"),
  templateEntityIds: entity.get("template_ent_ids") || null,
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

export function materialPatchSnippet(): string {
  return `
${assetReader}
const args = command.args || {};
const asset = editor.api.globals.assets.get(Number(args.assetId));
if (!asset) {
  throw new Error("Asset not found: " + args.assetId);
}
if (asset.get("type") !== "material") {
  throw new Error("Asset is not a material: " + args.assetId);
}
const data = args.data || {};
for (const [key, value] of Object.entries(data)) {
  asset.set("data." + key, value);
}
for (const change of args.sets || []) {
  asset.set("data." + change.path, change.value);
}
return {
  asset: readAsset(asset),
  data: asset.get("data") || {}
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

export function sceneSettingsGetSnippet(): string {
  return `
return editor.api.globals.settings.scene.json();
`;
}

export function sceneSettingsPatchSnippet(): string {
  return `
const args = command.args || {};
const settings = args.settings || {};
const scene = editor.api.globals.settings.scene;
function iterate(value, prefix) {
  for (const [key, child] of Object.entries(value || {})) {
    const path = prefix ? prefix + "." + key : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      iterate(child, path);
    } else {
      scene.set(path, child);
    }
  }
}
iterate(settings, "");
for (const change of args.sets || []) {
  scene.set(change.path, change.value);
}
return scene.json();
`;
}

export function storeSearchSnippet(): string {
  return `
const args = command.args || {};
const params = new URLSearchParams();
if (args.search) params.set("search", String(args.search));
params.set("regexp", "true");
if (args.order) params.set("order", args.order === "desc" ? "-1" : "1");
if (args.skip !== undefined && args.skip !== null) params.set("skip", String(args.skip));
if (args.limit !== undefined && args.limit !== null) params.set("limit", String(args.limit));
const response = await fetch("/api/store?" + params.toString());
const body = await response.json().catch(() => ({}));
if (!response.ok || body.error) {
  throw new Error(body.error || "Failed to search PlayCanvas store.");
}
return body;
`;
}

export function storeGetSnippet(): string {
  return `
const args = command.args || {};
if (!args.id) {
  throw new Error("id is required.");
}
const response = await fetch("/api/store/" + encodeURIComponent(args.id));
const body = await response.json().catch(() => ({}));
if (!response.ok || body.error) {
  throw new Error(body.error || "Failed to get PlayCanvas store asset.");
}
return body;
`;
}

export function storeDownloadSnippet(): string {
  return `
const args = command.args || {};
if (!args.id || !args.name || !args.license) {
  throw new Error("id, name, and license are required.");
}
const response = await fetch("/api/store/" + encodeURIComponent(args.id) + "/clone", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    scope: {
      type: "project",
      id: window.config?.project?.id
    },
    name: args.name,
    store: "playcanvas",
    targetFolderId: args.folderId === undefined ? null : Number(args.folderId),
    license: args.license
  })
});
const body = await response.json().catch(() => ({}));
if (!response.ok || body.error) {
  throw new Error(body.error || "Failed to download PlayCanvas store asset.");
}
return body;
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
