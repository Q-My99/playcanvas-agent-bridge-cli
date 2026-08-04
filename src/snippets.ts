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
  await entity.addScript(scriptName, {
    attributes,
    history: true
  });
}
const order = entity.get("components.script.order") || [];
if (!order.includes(scriptName)) {
  order.push(scriptName);
  entity.set("components.script.order", order);
}
const installed = entity.get("components.script.scripts." + scriptName);
if (!installed) {
  throw new Error("Script was not attached: " + scriptName);
}
return {
  entity: readEntity(entity),
  scriptName,
  scriptAsset: scriptAsset ? readAsset(scriptAsset) : null,
  script: installed
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

const templateApplyHelpers = `
function templateError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details || {};
  return error;
}

function templateObserver(entity) {
  return entity.observer || entity;
}

function templateOverrides(entity) {
  const value = editor.call("templates:computeFilteredOverrides", templateObserver(entity));
  if (Array.isArray(value)) return { count: value.length, value };
  if (value && typeof value === "object") {
    const parts = ["conflicts", "addedEntities", "deletedEntities"];
    const componentCount = parts.reduce(
      (total, key) => total + (Array.isArray(value[key]) ? value[key].length : 0),
      0
    );
    if (Number.isFinite(Number(value.totalOverrides))) {
      if (Number(value.totalOverrides) !== componentCount) {
        throw templateError(
          "TEMPLATE_OVERRIDE_COUNT_MISMATCH",
          "Template override total does not match its component arrays for entity " +
            entity.get("resource_id") + ".",
          { totalOverrides: Number(value.totalOverrides), componentCount }
        );
      }
      return {
        count: Number(value.totalOverrides),
        value,
        componentCount,
        countMismatch: false
      };
    }
    if (parts.some((key) => Array.isArray(value[key]))) {
      return { count: componentCount, value, componentCount, countMismatch: false };
    }
  }
  if (value && Array.isArray(value.overrides)) {
    return { count: value.overrides.length, value: value.overrides };
  }
  if (value && Number.isFinite(Number(value.length))) {
    return { count: Number(value.length), value };
  }
  throw templateError(
    "TEMPLATE_OVERRIDES_UNREADABLE",
    "Editor returned an unsupported Template overrides shape for entity " +
      entity.get("resource_id") + ".",
    { value: serialize(value, { maxDepth: 3, maxArray: 20, maxKeys: 30 }) }
  );
}

function templateReadback(entity) {
  const templateId = entity.get("template_id");
  const asset = templateId
    ? editor.api.globals.assets.get(Number(templateId))
    : null;
  if (!asset || asset.get("type") !== "template") {
    throw new Error("Template asset not found for entity: " + entity.get("resource_id"));
  }

  const entities = asset.get("data.entities") || {};
  const entries = Array.isArray(entities)
    ? entities.map((value, index) => [String(index), value])
    : Object.entries(entities);
  const entityIds = new Set(entries.map(([id]) => String(id)));
  const rootEntry = entries.find(([, value]) => {
    const parent = value && typeof value === "object" ? value.parent : null;
    return parent === null || parent === undefined || !entityIds.has(String(parent));
  });

  return {
    templateId: asset.get("id"),
    templateName: asset.get("name"),
    templateRootId: rootEntry ? rootEntry[0] : null,
    storedRootEnabled: rootEntry && rootEntry[1] && typeof rootEntry[1] === "object"
      ? rootEntry[1].enabled ?? null
      : null,
    sourceEnabled: entity.get("enabled")
  };
}

async function waitForTemplateOverrides(entity, deadline, intervalMs) {
  let last = templateOverrides(entity);
  while (Date.now() <= deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const waitMs = Math.min(intervalMs, remainingMs);
    if (last.count === 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const confirmed = templateOverrides(entity);
      if (confirmed.count === 0) return confirmed;
      last = confirmed;
    } else {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      last = templateOverrides(entity);
    }
  }
  throw templateError(
    "TEMPLATE_OBSERVER_NOT_CONVERGED",
    "Template pipeline completed, but overrides did not converge for entity " +
      entity.get("resource_id") + " (remaining: " + last.count + ").",
    { entityId: entity.get("resource_id"), remainingOverrides: last.count }
  );
}

async function waitForTemplateCallback(promise, entity, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw templateError(
      "TEMPLATE_CALLBACK_TIMEOUT",
      "Timed out waiting for Template pipeline callback for entity " + entity.get("resource_id") + ".",
      { entityId: entity.get("resource_id"), stateUnknown: true }
    );
  }
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(templateError(
          "TEMPLATE_CALLBACK_TIMEOUT",
          "Timed out waiting for Template pipeline callback for entity " +
            entity.get("resource_id") + ".",
          { entityId: entity.get("resource_id"), stateUnknown: true }
        )), remainingMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function applyTemplate(entity, deadline, intervalMs) {
  const startedAt = Date.now();
  const beforeReadback = templateReadback(entity);
  const beforeState = templateOverrides(entity);
  const enabledOverride = JSON.stringify(
    serialize(beforeState.value, { maxDepth: 4, maxArray: 100, maxKeys: 100 })
  ).includes("enabled");
  let callback = null;
  let callResult = null;

  if (beforeState.count > 0) {
    let resolveCallback;
    const callbackPromise = new Promise((resolve) => {
      resolveCallback = resolve;
    });
    callResult = editor.call(
      "templates:apply",
      templateObserver(entity),
      (...values) => resolveCallback(values)
    );
    if (callResult !== true) {
      throw templateError(
        "TEMPLATE_APPLY_REJECTED",
        "Editor rejected Template apply for entity " + entity.get("resource_id") + ".",
        { entityId: entity.get("resource_id"), accepted: false }
      );
    }
    const callbackValues = await waitForTemplateCallback(callbackPromise, entity, deadline);
    callback = serialize(callbackValues, { maxDepth: 3, maxArray: 20, maxKeys: 30 });
  }

  const afterState = beforeState.count > 0
    ? await waitForTemplateOverrides(entity, deadline, intervalMs)
    : beforeState;
  const readback = templateReadback(entity);
  if (String(readback.templateId) !== String(beforeReadback.templateId)) {
    throw templateError(
      "TEMPLATE_ID_CHANGED",
      "Template id changed while applying entity " + entity.get("resource_id") + ".",
      { beforeTemplateId: beforeReadback.templateId, afterTemplateId: readback.templateId }
    );
  }
  return {
    entityId: entity.get("resource_id"),
    templateId: readback.templateId,
    templateName: readback.templateName,
    before: beforeState.count,
    after: afterState.count,
    applied: beforeState.count > 0,
    accepted: beforeState.count > 0 ? true : null,
    callbackReceived: beforeState.count > 0,
    observerVerified: afterState.count === 0,
    verified: afterState.count === 0,
    completionSignal: beforeState.count > 0 ? "pipeline-callback-and-overrides" : "no-overrides",
    verificationScope: "current-editor-observer",
    reloadPersistenceChecked: false,
    durationMs: Date.now() - startedAt,
    sourceEnabled: readback.sourceEnabled,
    storedRootEnabled: readback.storedRootEnabled,
    templateRootId: readback.templateRootId,
    enabledOverride,
    warnings: enabledOverride
      ? ["The applied overrides include enabled state; confirm this was not temporary preview state."]
      : [],
    callResult: serialize(callResult, { maxDepth: 2, maxArray: 10, maxKeys: 20 }),
    callback
  };
}
`;

export function templateOverridesSnippet(): string {
  return `
${templateApplyHelpers}
const args = command.args || {};
const entity = editor.api.globals.entities.get(args.entityId || args.id);
if (!entity) {
  throw new Error("Template source entity not found: " + (args.entityId || args.id));
}
const state = templateOverrides(entity);
const readback = templateReadback(entity);
return {
  entityId: entity.get("resource_id"),
  templateId: readback.templateId,
  templateName: readback.templateName,
  count: state.count,
  sourceEnabled: readback.sourceEnabled,
  storedRootEnabled: readback.storedRootEnabled,
  templateRootId: readback.templateRootId,
  overrides: serialize(state.value, { maxDepth: 5, maxArray: 200, maxKeys: 200 })
};
`;
}

export function templateApplySnippet(): string {
  return `
${templateApplyHelpers}
const args = command.args || {};
const totalTimeoutMs = Number(args.waitTimeoutMs || command.timeoutMs || 15000);
const deadline = Date.now() + Math.max(100, totalTimeoutMs - 500);
const ids = Array.isArray(args.entityIds) && args.entityIds.length
  ? args.entityIds
  : [args.entityId || args.id];
const entitiesApi = editor.api.globals.entities;
if (editor.call("permissions:write") === false) {
  throw templateError("WRITE_DENIED", "PlayCanvas Editor write permission is required.");
}
const entities = ids.map((id) => {
  const entity = entitiesApi.get(id);
  if (!entity) throw new Error("Template source entity not found: " + id);
  templateReadback(entity);
  templateOverrides(entity);
  return entity;
});
const intervalMs = Math.max(10, Number(args.pollIntervalMs || 200));
const items = [];
for (const entity of entities) {
  try {
    items.push(await applyTemplate(entity, deadline, intervalMs));
  } catch (error) {
    const completedEntityIds = items.map((item) => item.entityId);
    if (error && typeof error === "object") {
      error.details = { ...(error.details || {}), completedEntityIds };
      throw error;
    }
    throw templateError(
      "TEMPLATE_APPLY_FAILED",
      String(error),
      { completedEntityIds }
    );
  }
}
return {
  affected: items.filter((item) => item.applied).length,
  verified: items.every((item) => item.verified),
  verificationScope: "current-editor-observer",
  reloadPersistenceChecked: false,
  items
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

const scriptUpdateHelpers = `
function scriptError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details || {};
  return error;
}

async function withScriptDeadline(promise, deadline, code, message, details) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw scriptError(code, message, details);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(scriptError(code, message, details)), remainingMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function scriptBranchId() {
  return window.config?.self?.branch?.id || window.config?.branch?.id || null;
}

function scriptFileSnapshot(asset) {
  const file = asset.get("file") || null;
  return {
    filename: asset.get("file.filename") || asset.get("name") || null,
    hash: asset.get("file.hash") || null,
    size: asset.get("file.size") || null,
    file
  };
}

function scriptFileSignature(snapshot) {
  return JSON.stringify([snapshot?.filename || null, snapshot?.hash || null, snapshot?.size ?? null]);
}

async function putScriptText(globals, asset, text, fallbackFilename, deadline) {
  const filename = asset.get("file.filename") || fallbackFilename || asset.get("name");
  const form = new FormData();
  form.append("filename", filename);
  form.append("file", new Blob([String(text || "")], { type: "text/javascript" }), filename);
  const branchId = scriptBranchId();
  if (branchId) form.append("branchId", String(branchId));
  const headers = {};
  if (globals.accessToken) headers.Authorization = "Bearer " + globals.accessToken;
  const response = await withScriptDeadline(
    fetch("/api/assets/" + asset.get("id"), { method: "PUT", headers, body: form }),
    deadline,
    "SCRIPT_UPDATE_TIMEOUT",
    "Timed out updating script asset " + asset.get("id") + ".",
    { assetId: String(asset.get("id")), stateUnknown: true }
  );
  const body = await withScriptDeadline(
    response.json().catch(() => ({})),
    deadline,
    "SCRIPT_UPDATE_TIMEOUT",
    "Timed out reading the update response for script asset " + asset.get("id") + ".",
    { assetId: String(asset.get("id")), stateUnknown: true }
  );
  if (!response.ok || body.error) {
    throw new Error(body.error || "Failed to update script asset.");
  }
  return body;
}

async function readRemoteScriptText(globals, asset, filename, deadline) {
  const branchId = scriptBranchId();
  const params = new URLSearchParams();
  if (branchId) params.set("branchId", String(branchId));
  params.set("pcbridge", String(Date.now()));
  const headers = { "Cache-Control": "no-cache" };
  if (globals.accessToken) headers.Authorization = "Bearer " + globals.accessToken;
  const response = await withScriptDeadline(
    fetch(
      "/api/assets/" + encodeURIComponent(String(asset.get("id"))) +
        "/file/" + encodeURIComponent(String(filename)) + "?" + params.toString(),
      { headers, cache: "no-store" }
    ),
    deadline,
    "SCRIPT_READBACK_TIMEOUT",
    "Timed out reading script asset " + asset.get("id") + ".",
    { assetId: String(asset.get("id")) }
  );
  if (!response.ok) return null;
  return withScriptDeadline(
    response.text(),
    deadline,
    "SCRIPT_READBACK_TIMEOUT",
    "Timed out reading script content for asset " + asset.get("id") + ".",
    { assetId: String(asset.get("id")) }
  );
}

async function waitForScriptFile(
  globals,
  asset,
  expectedText,
  fallbackFilename,
  beforeSignature,
  allowUnchangedSignature,
  deadline,
  intervalMs
) {
  let stableCount = 0;
  let previousSignature = null;
  let verifiedSignature = null;
  let last = scriptFileSnapshot(asset);
  while (Date.now() <= deadline) {
    last = scriptFileSnapshot(asset);
    const filename = last.file ? last.filename : fallbackFilename || last.filename;
    const signature = scriptFileSignature(last);
    const mutationObserved = allowUnchangedSignature || signature !== beforeSignature;
    if (
      mutationObserved &&
      last.file &&
      last.filename &&
      last.hash &&
      verifiedSignature !== signature &&
      filename
    ) {
      const remoteText = await readRemoteScriptText(globals, asset, filename, deadline).catch(() => null);
      if (remoteText === String(expectedText || "")) verifiedSignature = signature;
    }
    if (
      mutationObserved &&
      last.file &&
      last.filename &&
      last.hash &&
      verifiedSignature === signature
    ) {
      stableCount = signature === previousSignature ? stableCount + 1 : 1;
      if (stableCount >= 2) return { ...last, remoteContentVerified: true };
    } else {
      stableCount = 0;
    }
    previousSignature = signature;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  }
  throw scriptError(
    "SCRIPT_FILE_NOT_CONVERGED",
    "Timed out waiting for script file metadata and remote content for asset " + asset.get("id") + ".",
    {
      assetId: String(asset.get("id")),
      beforeSignature,
      actualSignature: scriptFileSignature(last),
      remoteContentVerified: verifiedSignature === scriptFileSignature(last)
    }
  );
}

async function parseScriptAsset(asset, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    const timeoutError = new Error("Timed out before parsing script asset " + asset.get("id") + ".");
    timeoutError.code = "SCRIPT_PARSE_CALLBACK_TIMEOUT";
    timeoutError.details = { assetId: String(asset.get("id")), parserCompleted: false };
    throw timeoutError;
  }
  let timer;
  const [error, data] = await new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new Error("Timed out parsing script asset " + asset.get("id") + ".");
      timeoutError.code = "SCRIPT_PARSE_CALLBACK_TIMEOUT";
      timeoutError.details = { assetId: String(asset.get("id")), parserCompleted: false };
      reject(timeoutError);
    }, remainingMs);
    editor.call("scripts:parse", asset.observer, (...values) => {
      clearTimeout(timer);
      resolve(values);
    });
  });
  if (error) {
    const parseError = new Error(String(error));
    parseError.code = "SCRIPT_PARSE_FAILED";
    parseError.details = { assetId: String(asset.get("id")), parserCompleted: true };
    throw parseError;
  }
  return data || {};
}

function stableScriptValue(value) {
  if (Array.isArray(value)) return value.map(stableScriptValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableScriptValue(value[key])])
    );
  }
  return value;
}

function normalizedScriptMetadata(scripts) {
  return Object.keys(scripts || {}).sort().map((name) => {
    const definition = scripts[name] || {};
    return [name, {
      attributesOrder: Array.isArray(definition.attributesOrder)
        ? definition.attributesOrder.map(String)
        : [],
      attributes: stableScriptValue(definition.attributes || {})
    }];
  });
}

function scriptParseFailures(diagnostics) {
  const scriptsInvalid = Array.isArray(diagnostics?.scriptsInvalid)
    ? diagnostics.scriptsInvalid
    : [];
  const attributesInvalid = Object.entries(diagnostics?.scripts || {}).flatMap(
    ([name, definition]) => Array.isArray(definition?.attributesInvalid) && definition.attributesInvalid.length
      ? [{ name, errors: definition.attributesInvalid }]
      : []
  );
  return { scriptsInvalid, attributesInvalid };
}

function throwIfScriptParseInvalid(diagnostics, fileUpdated) {
  const failures = scriptParseFailures(diagnostics);
  if (!failures.scriptsInvalid.length && !failures.attributesInvalid.length) {
    if (diagnostics?.scripts && Object.keys(diagnostics.scripts).length > 0) return;
    throw scriptError(
      "SCRIPT_NO_DECLARATIONS",
      "Script parser returned no declarations.",
      {
        fileUpdated: Boolean(fileUpdated),
        parserCompleted: true,
        metadataApplied: false
      }
    );
  }
  const error = new Error("Script parse returned invalid scripts or attributes.");
  error.code = "SCRIPT_PARSE_INVALID";
  error.details = {
    ...failures,
    fileUpdated: Boolean(fileUpdated),
    parserCompleted: true,
    metadataApplied: false
  };
  throw error;
}

async function waitForScriptMetadata(asset, expectedScripts, deadline, intervalMs) {
  const expected = JSON.stringify(normalizedScriptMetadata(expectedScripts || {}));
  let stableCount = 0;
  let last = asset.get("data.scripts") || {};
  while (Date.now() <= deadline) {
    last = asset.get("data.scripts") || {};
    if (JSON.stringify(normalizedScriptMetadata(last)) === expected) {
      stableCount += 1;
      if (stableCount >= 2) return last;
    } else {
      stableCount = 0;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  }
  const error = new Error(
    "Parsed script metadata did not converge for asset " + asset.get("id") + "."
  );
  error.code = "SCRIPT_METADATA_NOT_CONVERGED";
  error.details = {
    assetId: String(asset.get("id")),
    expected: normalizedScriptMetadata(expectedScripts || {}),
    actual: normalizedScriptMetadata(last || {})
  };
  throw error;
}

function readScriptMetadata(scripts) {
  return Object.fromEntries(Object.entries(scripts || {}).map(([name, definition]) => [name, {
    attributesOrder: definition?.attributesOrder || null,
    attributesInvalid: definition?.attributesInvalid || null
  }]));
}

async function finishScriptUpdate(globals, asset, text, fallbackFilename, args) {
  const startedAt = Number(args.updateStartedAt || Date.now());
  const timeoutMs = Math.max(100, Number(args.waitTimeoutMs || command.timeoutMs || 60000) - 500);
  const deadline = Number(args.updateDeadline || startedAt + timeoutMs);
  const intervalMs = Math.max(50, Number(args.pollIntervalMs || 500));
  let file = scriptFileSnapshot(asset);
  if (args.wait) {
    file = await waitForScriptFile(
      globals,
      asset,
      text,
      fallbackFilename,
      args.beforeFileSignature || null,
      Boolean(args.allowUnchangedFileSignature),
      deadline,
      intervalMs
    );
  }

  let diagnostics = null;
  let scripts = asset.get("data.scripts") || {};
  if (args.parse) {
    diagnostics = await parseScriptAsset(asset, deadline);
    throwIfScriptParseInvalid(diagnostics, true);
    const parsedScripts = diagnostics.scripts || {};
    if (args.wait) {
      scripts = await waitForScriptMetadata(
        asset,
        parsedScripts,
        deadline,
        intervalMs
      );
    } else {
      scripts = parsedScripts;
    }
  }

  return {
    asset: readAsset(asset),
    file,
    scripts,
    scriptMetadata: readScriptMetadata(scripts),
    parseDiagnostics: diagnostics
      ? Object.fromEntries(Object.entries(diagnostics).filter(([key]) => key !== "scripts"))
      : null,
    parsed: Boolean(args.parse),
    waited: Boolean(args.wait),
    durationMs: Date.now() - startedAt
  };
}
`;

export function scriptSetTextSnippet(): string {
  return `
${assetReader}
${scriptUpdateHelpers}
const args = command.args || {};
const globals = editor.api.globals;
const asset = globals.assets.get(Number(args.assetId));
if (!asset) {
  throw new Error("Asset not found: " + args.assetId);
}
if (asset.get("type") !== "script") {
  throw new Error("Asset is not a script: " + args.assetId);
}
const updateStartedAt = Date.now();
const updateTimeoutMs = Math.max(
  100,
  Number(args.waitTimeoutMs || command.timeoutMs || 60000) - 500
);
const updateArgs = {
  ...args,
  updateStartedAt,
  updateDeadline: updateStartedAt + updateTimeoutMs
};
const filename = asset.get("file.filename") || args.filename || asset.get("name");
const beforeFile = scriptFileSnapshot(asset);
let beforeRemoteText = null;
if (args.wait && beforeFile.file && filename) {
  beforeRemoteText = await readRemoteScriptText(
    globals,
    asset,
    filename,
    updateArgs.updateDeadline
  ).catch(() => null);
}
updateArgs.beforeFileSignature = scriptFileSignature(beforeFile);
updateArgs.allowUnchangedFileSignature = beforeRemoteText === String(args.text || "");
const body = await putScriptText(
  globals,
  asset,
  args.text,
  filename,
  updateArgs.updateDeadline
);
const result = await finishScriptUpdate(globals, asset, args.text, filename, updateArgs);
return {
  ...result,
  response: body
};
`;
}

export function scriptUpsertSnippet(): string {
  return `
${assetReader}
${assetFolderHelpers}
${scriptUpdateHelpers}
const args = command.args || {};
const globals = editor.api.globals;
const assets = globals.assets;
if (!args.filename) {
  throw new Error("filename is required.");
}
const updateStartedAt = Date.now();
const updateTimeoutMs = Math.max(
  100,
  Number(args.waitTimeoutMs || command.timeoutMs || 60000) - 500
);
const updateArgs = {
  ...args,
  updateStartedAt,
  updateDeadline: updateStartedAt + updateTimeoutMs
};
const folderResult = await resolveFolder(assets, args);
const folderId = folderResult.folder ? folderResult.folder.get("id") : null;
function isInTargetFolder(asset) {
  if (!folderId) return true;
  const path = asset.get("path") || [];
  return path[path.length - 1] === folderId;
}
const matches = assets.list().filter((candidate) =>
  candidate.get("type") === "script" &&
  isInTargetFolder(candidate) &&
  (
    candidate.get("file.filename") === args.filename ||
    candidate.get("name") === args.filename
  )
);
if (!folderId && !args.folder && matches.length > 1) {
  throw new Error(
    "Multiple script assets match " + args.filename + ": " +
    matches.map((candidate) => candidate.get("id") + "@" + (candidate.get("path") || []).join("/")).join(", ") +
    ". Specify --folder or --folder-id."
  );
}
let asset = matches[0] || null;
let action = "updated";
let responseBody = null;
if (!asset) {
  asset = await withScriptDeadline(
    assets.createScript({
      filename: args.filename,
      text: String(args.text || ""),
      folder: folderResult.folder || undefined,
      preload: args.preload !== false
    }),
    updateArgs.updateDeadline,
    "SCRIPT_CREATE_TIMEOUT",
    "Timed out creating script asset " + args.filename + ".",
    { filename: args.filename, stateUnknown: true }
  );
  action = "created";
  updateArgs.beforeFileSignature = null;
  updateArgs.allowUnchangedFileSignature = false;
} else {
  const filename = asset.get("file.filename") || args.filename || asset.get("name");
  const beforeFile = scriptFileSnapshot(asset);
  let beforeRemoteText = null;
  if (args.wait && beforeFile.file && filename) {
    beforeRemoteText = await readRemoteScriptText(
      globals,
      asset,
      filename,
      updateArgs.updateDeadline
    ).catch(() => null);
  }
  updateArgs.beforeFileSignature = scriptFileSignature(beforeFile);
  updateArgs.allowUnchangedFileSignature = beforeRemoteText === String(args.text || "");
  responseBody = await putScriptText(
    globals,
    asset,
    args.text,
    filename,
    updateArgs.updateDeadline
  );
}

const result = await finishScriptUpdate(globals, asset, args.text, args.filename, updateArgs);

return {
  action,
  ...result,
  response: responseBody,
  createdFolders: folderResult.created.map(readAsset)
};
`;
}

export function scriptParseSnippet(): string {
  return `
${assetReader}
${scriptUpdateHelpers}
const args = command.args || {};
const asset = editor.api.globals.assets.get(Number(args.assetId));
if (!asset) {
  throw new Error("Asset not found: " + args.assetId);
}
if (asset.get("type") !== "script") {
  throw new Error("Asset is not a script: " + args.assetId);
}
const startedAt = Date.now();
const timeoutMs = Math.max(100, Number(args.waitTimeoutMs || command.timeoutMs || 60000) - 500);
const deadline = startedAt + timeoutMs;
const intervalMs = Math.max(50, Number(args.pollIntervalMs || 500));
const diagnostics = await parseScriptAsset(asset, deadline);
throwIfScriptParseInvalid(diagnostics, false);
const scripts = await waitForScriptMetadata(
  asset,
  diagnostics.scripts || {},
  deadline,
  intervalMs
);
return {
  asset: readAsset(asset),
  scripts,
  scriptMetadata: readScriptMetadata(scripts),
  parseDiagnostics: Object.fromEntries(
    Object.entries(diagnostics).filter(([key]) => key !== "scripts")
  ),
  parsed: true,
  observerVerified: true,
  durationMs: Date.now() - startedAt
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
