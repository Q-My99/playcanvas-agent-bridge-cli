import type { JsonValue } from "../shared/protocol.js";

export type JsonObject = { [key: string]: JsonValue };

export const TEXT_FILE_TYPES = new Set([
  "script",
  "text",
  "json",
  "html",
  "css",
  "shader",
]);

export const DATA_JSON_TYPES = new Set([
  "material",
  "template",
  "cubemap",
  "sprite",
  "animstategraph",
  "bundle",
]);

export const MIN_EAGER_MAX_MB = 1;
export const MAX_EAGER_MAX_MB = 10;
export const DEFAULT_EAGER_MAX_MB = 2;

const ENTITY_KEY_ORDER = [
  "resource_id",
  "name",
  "enabled",
  "parent",
  "children",
  "tags",
  "position",
  "rotation",
  "scale",
  "template_id",
  "template_ent_ids",
  "components",
];

const TRANSIENT_ASSET_DATA_KEYS = new Set([
  "uniqueId",
  "createdAt",
  "modifiedAt",
  "revision",
  "user_id",
  "thumbnails",
  "has_thumbnail",
  "task",
  "region",
]);

export function clampEagerMaxMb(value: unknown, fallback = DEFAULT_EAGER_MAX_MB): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_EAGER_MAX_MB, Math.max(MIN_EAGER_MAX_MB, Math.round(parsed)));
}

export function eagerMaxBytesFromMb(mb: number): number {
  return clampEagerMaxMb(mb) * 1024 * 1024;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function canonicalizeValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      if (value[key] === undefined) continue;
      out[key] = canonicalizeValue(value[key]);
    }
    return out;
  }
  return String(value);
}

function canonicalizeEntityObject(id: string, raw: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  const priority = new Set(ENTITY_KEY_ORDER);
  const normalized: Record<string, unknown> = {
    ...raw,
    resource_id: id,
  };
  for (const key of ENTITY_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(normalized, key) && normalized[key] !== undefined) {
      out[key] = canonicalizeValue(normalized[key]);
    }
  }
  const rest = Object.keys(normalized)
    .filter((key) => !priority.has(key) && normalized[key] !== undefined)
    .sort((a, b) => a.localeCompare(b));
  for (const key of rest) {
    out[key] = canonicalizeValue(normalized[key]);
  }
  return out;
}

export function orderEntitiesDfs(entitiesRaw: Record<string, unknown>): JsonObject {
  const entries = Object.entries(entitiesRaw).filter(([, value]) => isPlainObject(value)) as Array<
    [string, Record<string, unknown>]
  >;
  const byId = new Map<string, Record<string, unknown>>(entries);
  const ordered: JsonObject = {};
  const visited = new Set<string>();

  const visit = (id: string) => {
    if (visited.has(id)) return;
    const entity = byId.get(id);
    if (!entity) return;
    visited.add(id);
    ordered[id] = canonicalizeEntityObject(id, entity);
    const children = Array.isArray(entity.children) ? entity.children : [];
    for (const childId of children) {
      if (typeof childId === "string" && byId.has(childId)) {
        visit(childId);
      }
    }
  };

  const roots = entries
    .filter(([, entity]) => !entity.parent || typeof entity.parent !== "string" || !byId.has(entity.parent))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
  for (const rootId of roots) visit(rootId);

  const remaining = entries
    .map(([id]) => id)
    .filter((id) => !visited.has(id))
    .sort((a, b) => a.localeCompare(b));
  for (const id of remaining) visit(id);

  return ordered;
}

export function canonicalizeAssetData(type: string, data: unknown): JsonObject {
  if (!isPlainObject(data)) return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (TRANSIENT_ASSET_DATA_KEYS.has(key) || value === undefined) continue;
    cleaned[key] = value;
  }
  if (type === "template" && isPlainObject(cleaned.entities)) {
    const rest = canonicalizeValue(cleaned) as JsonObject;
    rest.entities = orderEntitiesDfs(cleaned.entities);
    return rest;
  }
  return canonicalizeValue(cleaned) as JsonObject;
}

export function canonicalStringify(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function stripDataAssetSuffix(name: string, type: string): string {
  const suffix = `.${type}.json`;
  if (name.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase()) && name.length > suffix.length) {
    return name.slice(0, -suffix.length);
  }
  return name;
}

export function dataAssetFilename(name: string, type: string): string {
  const stem = stripDataAssetSuffix(name || type, type);
  return `${stem}.${type}.json`;
}

export function parseDataAssetFilename(filename: string): { stem: string; type: string } | null {
  const match = filename.match(/^(.+)\.(material|template|cubemap|sprite|animstategraph|bundle)\.json$/i);
  if (!match) return null;
  return {
    stem: match[1],
    type: match[2].toLocaleLowerCase(),
  };
}

export type CanonicalAssetDoc = {
  name: string;
  preload: boolean;
  tags: string[];
  data: JsonObject;
};

export function buildAssetProjection(input: {
  id: string;
  name: string;
  type: string;
  preload?: boolean;
  tags?: unknown;
  data?: unknown;
  role?: "source" | "derived" | "standalone";
  sourceAssetId?: string | null;
  writable?: boolean;
}): { doc: CanonicalAssetDoc; json: JsonObject; text: string } {
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const doc: CanonicalAssetDoc = {
    name: stripDataAssetSuffix(input.name, input.type),
    preload: input.preload !== false,
    tags,
    data: canonicalizeAssetData(input.type, input.data),
  };
  const header: JsonObject = {
    id: String(input.id),
    kind: "asset",
    type: input.type,
  };
  if (input.sourceAssetId) {
    header.sourceAssetId = String(input.sourceAssetId);
  }
  if (input.writable === false) {
    header.readonly = true;
  }
  const json: JsonObject = {
    $pcbridge: header,
    name: doc.name,
    preload: doc.preload,
    tags: doc.tags,
    data: doc.data,
  };
  return { doc, json, text: canonicalStringify(json) };
}

export function parseAssetProjection(
  rawText: string,
  fallback: { name: string; type: string },
): {
  embeddedId: string | null;
  embeddedType: string;
  doc: CanonicalAssetDoc;
} {
  const parsed = JSON.parse(rawText) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Structured asset projection must be a JSON object.");
  }
  const header = isPlainObject(parsed.$pcbridge) ? parsed.$pcbridge : null;
  const embeddedId = header && (typeof header.id === "string" || typeof header.id === "number")
    ? String(header.id).trim() || null
    : null;
  const embeddedType = header && typeof header.type === "string" && DATA_JSON_TYPES.has(header.type)
    ? header.type
    : fallback.type;
  const rawName = typeof parsed.name === "string" && parsed.name.trim()
    ? parsed.name.trim()
    : fallback.name;
  const preload = parsed.preload !== false;
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  let rawData: unknown = isPlainObject(parsed.data) ? parsed.data : {};
  if (embeddedType === "template" && isPlainObject(rawData) && isPlainObject(rawData.entities)) {
    rawData = {
      ...rawData,
      entities: reconcileEntityHierarchy(rawData.entities),
    };
  }
  return {
    embeddedId,
    embeddedType,
    doc: {
      name: stripDataAssetSuffix(rawName, embeddedType),
      preload,
      tags,
      data: canonicalizeAssetData(embeddedType, rawData),
    },
  };
}

export function parseSceneFilename(filename: string): { stem: string; sceneId: string } | null {
  const match = filename.match(/^(.+)\.([0-9]+)\.scene\.json$/i);
  if (!match) return null;
  return {
    stem: match[1],
    sceneId: match[2],
  };
}

export type CanonicalSceneDoc = {
  name: string;
  settings: JsonObject;
  entities: JsonObject;
};

export function reconcileEntityHierarchy(
  rawEntities: Record<string, unknown>,
  baseEntities?: Record<string, unknown>,
): JsonObject {
  const map = new Map<string, Record<string, unknown>>();
  for (const [id, raw] of Object.entries(rawEntities)) {
    if (!id || !isPlainObject(raw)) continue;
    const parent = raw.parent === null || raw.parent === undefined || raw.parent === ""
      ? null
      : String(raw.parent);
    const children = Array.isArray(raw.children)
      ? raw.children.filter((item): item is string => typeof item === "string")
      : [];
    map.set(id, {
      ...raw,
      resource_id: id,
      name: typeof raw.name === "string" ? raw.name : "New Entity",
      enabled: raw.enabled !== false,
      parent,
      children: [...new Set(children)],
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
      position: Array.isArray(raw.position) && raw.position.length === 3 ? raw.position : [0, 0, 0],
      rotation: Array.isArray(raw.rotation) && raw.rotation.length === 3 ? raw.rotation : [0, 0, 0],
      scale: Array.isArray(raw.scale) && raw.scale.length === 3 ? raw.scale : [1, 1, 1],
      components: isPlainObject(raw.components) ? raw.components : {},
    });
  }

  if (!map.size) {
    throw new Error("Scene or Template entities map cannot be empty.");
  }

  // Reconcile parent <-> children edits when one side was updated by an Agent or tool.
  for (const [parentId, entity] of map) {
    const baseParent = isPlainObject(baseEntities?.[parentId])
      ? baseEntities![parentId] as Record<string, unknown>
      : null;
    const baseChildren = new Set<string>(
      Array.isArray(baseParent?.children)
        ? (baseParent!.children as unknown[]).filter((item): item is string => typeof item === "string")
        : [],
    );
    const children = entity.children as string[];
    for (const childId of children) {
      const child = map.get(childId);
      if (!child) continue;
      const baseChild = isPlainObject(baseEntities?.[childId])
        ? baseEntities![childId] as Record<string, unknown>
        : null;
      const baseChildParent = typeof baseChild?.parent === "string" ? baseChild.parent : null;
      const childParentChanged = baseChild !== null && child.parent !== baseChildParent;
      if (!childParentChanged && !baseChildren.has(childId) && child.parent !== parentId) {
        child.parent = parentId;
      }
    }
  }

  // Filter children lists to existing entities whose parent actually points to parentId.
  for (const [parentId, entity] of map) {
    entity.children = (entity.children as string[]).filter((childId) => {
      const child = map.get(childId);
      return Boolean(child && child.parent === parentId);
    });
  }

  // Ensure every non-root entity appears in its declared parent's children list.
  const roots: string[] = [];
  for (const [id, entity] of map) {
    const parentId = entity.parent as string | null;
    if (parentId === null) {
      roots.push(id);
      continue;
    }
    const parent = map.get(parentId);
    if (!parent) {
      throw new Error(`Entity ${id} references missing parent ${parentId}.`);
    }
    const list = parent.children as string[];
    if (!list.includes(id)) list.push(id);
  }

  if (roots.length !== 1) {
    throw new Error(`Expected exactly 1 root entity, found ${roots.length}.`);
  }

  // Verify acyclic reachability of all entities from the single root.
  const visited = new Set<string>();
  const activeStack = new Set<string>();
  const walk = (id: string) => {
    if (activeStack.has(id)) {
      throw new Error(`Entity hierarchy cycle detected at ${id}.`);
    }
    if (visited.has(id)) return;
    activeStack.add(id);
    visited.add(id);
    const entity = map.get(id)!;
    for (const childId of entity.children as string[]) {
      walk(childId);
    }
    activeStack.delete(id);
  };
  walk(roots[0]);
  if (visited.size !== map.size) {
    throw new Error("Entity hierarchy contains unreachable/cyclic entities.");
  }

  return orderEntitiesDfs(Object.fromEntries(map));
}

export function buildSceneProjection(input: {
  id: string;
  name: string;
  active?: boolean;
  settings?: unknown;
  entities?: Record<string, unknown>;
}): { doc: CanonicalSceneDoc; json: JsonObject; text: string } {
  const settings = isPlainObject(input.settings)
    ? (canonicalizeValue(input.settings) as JsonObject)
    : {};
  const entities = isPlainObject(input.entities)
    ? orderEntitiesDfs(input.entities)
    : {};
  const doc: CanonicalSceneDoc = {
    name: input.name || `Scene ${input.id}`,
    settings,
    entities,
  };
  const active = input.active !== false;
  const header: JsonObject = {
    id: String(input.id),
    kind: "scene",
    active,
    ...(active ? {} : { readonly: true }),
  };
  const json: JsonObject = {
    $pcbridge: header,
    name: doc.name,
    settings: doc.settings,
    entities: doc.entities,
  };
  return { doc, json, text: canonicalStringify(json) };
}

export function parseSceneProjection(
  rawText: string,
  fallback: { id: string; name: string },
  baseEntities?: Record<string, unknown>,
): { embeddedId: string; doc: CanonicalSceneDoc } {
  const parsed = JSON.parse(rawText) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Scene projection must be a JSON object.");
  }
  const header = isPlainObject(parsed.$pcbridge) ? parsed.$pcbridge : null;
  const embeddedId = header && (typeof header.id === "string" || typeof header.id === "number")
    ? String(header.id)
    : fallback.id;
  if (!isPlainObject(parsed.entities)) {
    throw new Error("Scene projection must contain an entities object.");
  }
  const name = typeof parsed.name === "string" && parsed.name.trim()
    ? parsed.name.trim()
    : fallback.name;
  const settings = isPlainObject(parsed.settings)
    ? (canonicalizeValue(parsed.settings) as JsonObject)
    : {};
  const entities = reconcileEntityHierarchy(parsed.entities, baseEntities);
  return {
    embeddedId,
    doc: {
      name,
      settings,
      entities,
    },
  };
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function isMergeContainer(value: JsonValue | undefined): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  // If any child key contains '.', Observer dot-paths cannot address deeper children individually.
  if (keys.some((key) => key.includes("."))) return false;
  return keys.length > 0;
}

function mergeObjectTree(
  base: JsonValue | undefined,
  local: JsonValue | undefined,
  remote: JsonValue | undefined,
  pathPrefix: string,
  conflicts: string[],
): JsonValue | undefined {
  if (jsonEqual(local, remote)) return local;
  if (jsonEqual(local, base)) return remote;
  if (jsonEqual(remote, base)) return local;

  const baseObj = isMergeContainer(base) ? base : null;
  const localObj = isMergeContainer(local) ? local : null;
  const remoteObj = isMergeContainer(remote) ? remote : null;
  const allObjectsOrEmpty =
    (base === undefined || (base !== null && typeof base === "object" && !Array.isArray(base))) &&
    local !== undefined && local !== null && typeof local === "object" && !Array.isArray(local) &&
    remote !== undefined && remote !== null && typeof remote === "object" && !Array.isArray(remote);
  const hasDottedKeys =
    (allObjectsOrEmpty && Object.keys(local as JsonObject).some((k) => k.includes("."))) ||
    (allObjectsOrEmpty && Object.keys(remote as JsonObject).some((k) => k.includes("."))) ||
    (baseObj && Object.keys(baseObj).some((k) => k.includes(".")));

  if (allObjectsOrEmpty && !hasDottedKeys && (baseObj || localObj || remoteObj)) {
    const b = (base as JsonObject | undefined) || {};
    const l = local as JsonObject;
    const r = remote as JsonObject;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].sort();
    const merged: JsonObject = {};
    for (const key of keys) {
      const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      const hasB = Object.prototype.hasOwnProperty.call(b, key);
      const hasL = Object.prototype.hasOwnProperty.call(l, key);
      const hasR = Object.prototype.hasOwnProperty.call(r, key);
      const next = mergeObjectTree(
        hasB ? b[key] : undefined,
        hasL ? l[key] : undefined,
        hasR ? r[key] : undefined,
        childPath,
        conflicts,
      );
      if (next !== undefined) merged[key] = next;
    }
    return merged;
  }

  conflicts.push(pathPrefix || "$root");
  return remote;
}

function mergeChildrenOrder(
  baseChildren: string[],
  localChildren: string[],
  remoteChildren: string[],
  survivingIds: Set<string>,
  expectedParentId: string,
  mergedParentOf: Map<string, string | null>,
  conflictPath: string,
  conflicts: string[],
): string[] {
  const validForParent = (id: string) => survivingIds.has(id) && mergedParentOf.get(id) === expectedParentId;
  const baseFiltered = baseChildren.filter(validForParent);
  const localFiltered = localChildren.filter(validForParent);
  const remoteFiltered = remoteChildren.filter(validForParent);

  const commonSurviving = baseFiltered.filter(
    (id) => localFiltered.includes(id) && remoteFiltered.includes(id),
  );
  const localCommonOrder = localFiltered.filter((id) => commonSurviving.includes(id));
  const remoteCommonOrder = remoteFiltered.filter((id) => commonSurviving.includes(id));
  const localReordered = !jsonEqual(localCommonOrder, commonSurviving);
  const remoteReordered = !jsonEqual(remoteCommonOrder, commonSurviving);
  if (localReordered && remoteReordered && !jsonEqual(localCommonOrder, remoteCommonOrder)) {
    conflicts.push(conflictPath);
  }

  const result: string[] = [];
  const push = (id: string) => {
    if (validForParent(id) && !result.includes(id)) result.push(id);
  };

  if (localReordered && !remoteReordered) {
    for (const id of localFiltered) push(id);
    for (const id of remoteFiltered) push(id);
  } else {
    for (const id of remoteFiltered) push(id);
    for (const id of localFiltered) push(id);
  }
  for (const [id, parentId] of mergedParentOf) {
    if (parentId === expectedParentId) push(id);
  }
  return result;
}

function mergeEntitiesMap(
  baseEntities: JsonObject,
  localEntities: JsonObject,
  remoteEntities: JsonObject,
  pathPrefix: string,
  conflicts: string[],
): JsonObject {
  const allIds = [
    ...new Set([
      ...Object.keys(baseEntities),
      ...Object.keys(localEntities),
      ...Object.keys(remoteEntities),
    ]),
  ];
  const rawMerged = new Map<string, JsonObject>();

  for (const id of allIds) {
    const b = isPlainObject(baseEntities[id]) ? (baseEntities[id] as JsonObject) : undefined;
    const l = isPlainObject(localEntities[id]) ? (localEntities[id] as JsonObject) : undefined;
    const r = isPlainObject(remoteEntities[id]) ? (remoteEntities[id] as JsonObject) : undefined;
    const entityPath = `${pathPrefix}.${id}`;

    if (!b) {
      if (l && !r) {
        rawMerged.set(id, structuredClone(l));
      } else if (!l && r) {
        rawMerged.set(id, structuredClone(r));
      } else if (l && r) {
        if (!jsonEqual(l, r)) conflicts.push(entityPath);
        rawMerged.set(id, structuredClone(r));
      }
      continue;
    }

    if (!l && !r) continue;
    if (!l && r) {
      // Ignore mere child-array mutations caused by unrelated sibling additions when checking if entity was modified.
      const bNoChildren = { ...b, children: [] };
      const rNoChildren = { ...r, children: [] };
      if (!jsonEqual(bNoChildren, rNoChildren)) {
        conflicts.push(entityPath);
        rawMerged.set(id, structuredClone(r));
      }
      continue;
    }
    if (l && !r) {
      const bNoChildren = { ...b, children: [] };
      const lNoChildren = { ...l, children: [] };
      if (!jsonEqual(bNoChildren, lNoChildren)) {
        conflicts.push(entityPath);
        rawMerged.set(id, structuredClone(l));
      }
      continue;
    }

    // Present in base, local, and remote: merge all fields except `children` first.
    const bRest: JsonObject = { ...b };
    const lRest: JsonObject = { ...l! };
    const rRest: JsonObject = { ...r! };
    delete bRest.children;
    delete lRest.children;
    delete rRest.children;
    const mergedFields = mergeObjectTree(bRest, lRest, rRest, entityPath, conflicts) as JsonObject;
    mergedFields.children = [];
    rawMerged.set(id, mergedFields);
  }

  const survivingIds = new Set(rawMerged.keys());
  const mergedParentOf = new Map<string, string | null>();
  for (const [id, entity] of rawMerged) {
    const parent = typeof entity.parent === "string" ? entity.parent : null;
    if (parent !== null && !survivingIds.has(parent)) {
      conflicts.push(`${pathPrefix}.${id}.parent`);
    }
    mergedParentOf.set(id, parent);
  }

  for (const [id, entity] of rawMerged) {
    const bChildren = Array.isArray((baseEntities[id] as JsonObject | undefined)?.children)
      ? ((baseEntities[id] as JsonObject).children as string[])
      : [];
    const lChildren = Array.isArray((localEntities[id] as JsonObject | undefined)?.children)
      ? ((localEntities[id] as JsonObject).children as string[])
      : [];
    const rChildren = Array.isArray((remoteEntities[id] as JsonObject | undefined)?.children)
      ? ((remoteEntities[id] as JsonObject).children as string[])
      : [];
    entity.children = mergeChildrenOrder(
      bChildren,
      lChildren,
      Object.prototype.hasOwnProperty.call(remoteEntities, id) ? rChildren : [],
      survivingIds,
      id,
      mergedParentOf,
      `${pathPrefix}.${id}.children`,
      conflicts,
    );
  }

  if (!conflicts.length) {
    try {
      return reconcileEntityHierarchy(Object.fromEntries(rawMerged));
    } catch (error) {
      conflicts.push(`${pathPrefix}.$hierarchy(${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return orderEntitiesDfs(Object.fromEntries(rawMerged));
}

export function threeWayMergeAssetJson(
  type: string,
  base: CanonicalAssetDoc,
  local: CanonicalAssetDoc,
  remote: CanonicalAssetDoc,
): { merged: CanonicalAssetDoc; conflicts: string[] } {
  const conflicts: string[] = [];
  const name = mergeObjectTree(base.name, local.name, remote.name, "name", conflicts) as string;
  const preload = mergeObjectTree(base.preload, local.preload, remote.preload, "preload", conflicts) as boolean;
  const tags = mergeObjectTree(base.tags, local.tags, remote.tags, "tags", conflicts) as string[];

  let data: JsonObject;
  if (
    type === "template" &&
    isPlainObject(base.data.entities) &&
    isPlainObject(local.data.entities) &&
    isPlainObject(remote.data.entities)
  ) {
    const bRest = { ...base.data };
    const lRest = { ...local.data };
    const rRest = { ...remote.data };
    delete bRest.entities;
    delete lRest.entities;
    delete rRest.entities;
    data = (mergeObjectTree(bRest, lRest, rRest, "data", conflicts) as JsonObject) || {};
    data.entities = mergeEntitiesMap(
      base.data.entities as JsonObject,
      local.data.entities as JsonObject,
      remote.data.entities as JsonObject,
      "data.entities",
      conflicts,
    );
  } else {
    data = (mergeObjectTree(base.data, local.data, remote.data, "data", conflicts) as JsonObject) || {};
  }

  return {
    merged: {
      name,
      preload,
      tags,
      data: canonicalizeAssetData(type, data),
    },
    conflicts,
  };
}

export function threeWayMergeSceneJson(
  base: CanonicalSceneDoc,
  local: CanonicalSceneDoc,
  remote: CanonicalSceneDoc,
): { merged: CanonicalSceneDoc; conflicts: string[] } {
  const conflicts: string[] = [];
  const name = mergeObjectTree(base.name, local.name, remote.name, "name", conflicts) as string;
  const settings = (mergeObjectTree(
    base.settings,
    local.settings,
    remote.settings,
    "settings",
    conflicts,
  ) as JsonObject) || {};
  const entities = mergeEntitiesMap(
    base.entities,
    local.entities,
    remote.entities,
    "entities",
    conflicts,
  );
  return {
    merged: { name, settings, entities },
    conflicts,
  };
}

export type PathPatchOps = {
  sets: Array<{ path: string; value: JsonValue }>;
  unsets: string[];
};

export function diffObjectPaths(
  current: JsonObject,
  target: JsonObject,
  prefix = "",
): PathPatchOps {
  const sets: Array<{ path: string; value: JsonValue }> = [];
  const unsets: string[] = [];

  const walk = (cur: JsonObject, tgt: JsonObject, basePrefix: string) => {
    const curKeys = Object.keys(cur);
    const tgtKeys = Object.keys(tgt);
    if (curKeys.some((k) => k.includes(".")) || tgtKeys.some((k) => k.includes("."))) {
      if (!jsonEqual(cur, tgt) && basePrefix) {
        sets.push({ path: basePrefix, value: tgt });
      }
      return;
    }
    for (const key of curKeys) {
      if (!Object.prototype.hasOwnProperty.call(tgt, key)) {
        const path = basePrefix ? `${basePrefix}.${key}` : key;
        unsets.push(path);
      }
    }
    for (const key of tgtKeys) {
      const path = basePrefix ? `${basePrefix}.${key}` : key;
      if (!Object.prototype.hasOwnProperty.call(cur, key)) {
        sets.push({ path, value: tgt[key] });
        continue;
      }
      const curVal = cur[key];
      const tgtVal = tgt[key];
      if (jsonEqual(curVal, tgtVal)) continue;
      if (
        curVal && typeof curVal === "object" && !Array.isArray(curVal) &&
        tgtVal && typeof tgtVal === "object" && !Array.isArray(tgtVal)
      ) {
        const curChildKeys = Object.keys(curVal);
        const tgtChildKeys = Object.keys(tgtVal);
        if (
          (curChildKeys.length === 0 && tgtChildKeys.length === 0) ||
          curChildKeys.some((k) => k.includes(".")) ||
          tgtChildKeys.some((k) => k.includes("."))
        ) {
          sets.push({ path, value: tgtVal });
        } else {
          walk(curVal as JsonObject, tgtVal as JsonObject, path);
        }
      } else {
        sets.push({ path, value: tgtVal });
      }
    }
  };

  walk(current, target, prefix);
  return { sets, unsets };
}

export type AssetPatchPayload = {
  name?: string;
  preload?: boolean;
  tags?: string[];
  sets: Array<{ path: string; value: JsonValue }>;
  unsets: string[];
};

export function diffAssetPatchOps(
  current: CanonicalAssetDoc,
  target: CanonicalAssetDoc,
): AssetPatchPayload | null {
  const dataOps = diffObjectPaths(current.data, target.data);
  const nameChanged = current.name !== target.name;
  const preloadChanged = current.preload !== target.preload;
  const tagsChanged = !jsonEqual(current.tags, target.tags);
  if (!nameChanged && !preloadChanged && !tagsChanged && !dataOps.sets.length && !dataOps.unsets.length) {
    return null;
  }
  const patch: AssetPatchPayload = {
    sets: dataOps.sets,
    unsets: dataOps.unsets,
  };
  if (nameChanged) patch.name = target.name;
  if (preloadChanged) patch.preload = target.preload;
  if (tagsChanged) patch.tags = target.tags;
  return patch;
}

export type SceneEntityUpdateOp = {
  id: string;
  addedComponents: Record<string, JsonValue>;
  removedComponents: string[];
  sets: Array<{ path: string; value: JsonValue }>;
  unsets: string[];
};

export type ScenePatchPayload = {
  name?: string;
  creates: Array<{ entity: JsonObject; index?: number }>;
  reparents: Array<{ id: string; parent: string; index: number }>;
  updates: SceneEntityUpdateOp[];
  deletes: string[];
  settingsSets: Array<{ path: string; value: JsonValue }>;
  settingsUnsets: string[];
};

export function diffScenePatchOps(
  current: CanonicalSceneDoc,
  target: CanonicalSceneDoc,
): ScenePatchPayload | null {
  const nameChanged = current.name !== target.name;
  const settingsDiff = diffObjectPaths(current.settings, target.settings);
  const curEntities = current.entities;
  const tgtEntities = target.entities;

  const createdIds = new Set(
    Object.keys(tgtEntities).filter((id) => !Object.prototype.hasOwnProperty.call(curEntities, id)),
  );
  const deletedAll = new Set(
    Object.keys(curEntities).filter((id) => !Object.prototype.hasOwnProperty.call(tgtEntities, id)),
  );
  // Only delete top-most deleted ancestors; PlayCanvas entities.delete cascades to children.
  const deletes = [...deletedAll].filter((id) => {
    const entity = curEntities[id] as JsonObject | undefined;
    let parent = typeof entity?.parent === "string" ? entity.parent : null;
    while (parent) {
      if (deletedAll.has(parent)) return false;
      const parentEntity = curEntities[parent] as JsonObject | undefined;
      parent = typeof parentEntity?.parent === "string" ? parentEntity.parent : null;
    }
    return true;
  });

  // Because orderEntitiesDfs visits parents before children, iterating Object.keys(tgtEntities)
  // naturally yields created entities in topological parent-before-child order.
  const creates: Array<{ entity: JsonObject; index?: number }> = [];
  for (const id of Object.keys(tgtEntities)) {
    if (!createdIds.has(id)) continue;
    const entity = structuredClone(tgtEntities[id] as JsonObject);
    const parentId = typeof entity.parent === "string" ? entity.parent : null;
    const parent = parentId ? (tgtEntities[parentId] as JsonObject | undefined) : undefined;
    const siblings = Array.isArray(parent?.children) ? (parent!.children as string[]) : [];
    const index = siblings.indexOf(id);
    entity.children = [];
    creates.push({ entity, ...(index >= 0 ? { index } : {}) });
  }

  const reparents: Array<{ id: string; parent: string; index: number }> = [];
  const updates: SceneEntityUpdateOp[] = [];

  for (const id of Object.keys(tgtEntities)) {
    if (createdIds.has(id)) continue;
    const cur = curEntities[id] as JsonObject;
    const tgt = tgtEntities[id] as JsonObject;

    const curParent = typeof cur.parent === "string" ? cur.parent : null;
    const tgtParent = typeof tgt.parent === "string" ? tgt.parent : null;
    if (tgtParent !== null) {
      const tgtParentObj = tgtEntities[tgtParent] as JsonObject | undefined;
      const tgtSiblings = Array.isArray(tgtParentObj?.children) ? (tgtParentObj!.children as string[]) : [];
      const tgtIndex = tgtSiblings.indexOf(id);
      if (curParent !== tgtParent) {
        reparents.push({ id, parent: tgtParent, index: Math.max(0, tgtIndex) });
      } else {
        const curParentObj = curEntities[curParent] as JsonObject | undefined;
        const curSiblings = (Array.isArray(curParentObj?.children) ? (curParentObj!.children as string[]) : [])
          .filter((childId) => !deletedAll.has(childId));
        const existingTgtSiblings = tgtSiblings.filter((childId) => !createdIds.has(childId) && curEntities[childId] && (curEntities[childId] as JsonObject).parent === tgtParent);
        if (curSiblings.indexOf(id) !== existingTgtSiblings.indexOf(id)) {
          reparents.push({ id, parent: tgtParent, index: Math.max(0, tgtIndex) });
        }
      }
    }

    const sets: Array<{ path: string; value: JsonValue }> = [];
    const unsets: string[] = [];
    for (const field of ["name", "enabled", "tags", "position", "rotation", "scale", "template_id", "template_ent_ids"]) {
      const hasCur = Object.prototype.hasOwnProperty.call(cur, field);
      const hasTgt = Object.prototype.hasOwnProperty.call(tgt, field);
      if (hasCur && !hasTgt) unsets.push(field);
      else if (hasTgt && !jsonEqual(cur[field], tgt[field])) sets.push({ path: field, value: tgt[field] });
    }

    const curComps = isPlainObject(cur.components) ? (cur.components as JsonObject) : {};
    const tgtComps = isPlainObject(tgt.components) ? (tgt.components as JsonObject) : {};
    const addedComponents: Record<string, JsonValue> = {};
    const removedComponents: string[] = [];

    for (const comp of Object.keys(curComps)) {
      if (!Object.prototype.hasOwnProperty.call(tgtComps, comp)) {
        removedComponents.push(comp);
      }
    }
    for (const comp of Object.keys(tgtComps)) {
      if (!Object.prototype.hasOwnProperty.call(curComps, comp)) {
        addedComponents[comp] = tgtComps[comp];
        continue;
      }
      const curCompVal = curComps[comp];
      const tgtCompVal = tgtComps[comp];
      if (isPlainObject(curCompVal) && isPlainObject(tgtCompVal)) {
        const compDiff = diffObjectPaths(curCompVal as JsonObject, tgtCompVal as JsonObject, `components.${comp}`);
        sets.push(...compDiff.sets);
        unsets.push(...compDiff.unsets);
      } else if (!jsonEqual(curCompVal, tgtCompVal)) {
        sets.push({ path: `components.${comp}`, value: tgtCompVal });
      }
    }

    if (
      Object.keys(addedComponents).length ||
      removedComponents.length ||
      sets.length ||
      unsets.length
    ) {
      updates.push({
        id,
        addedComponents,
        removedComponents,
        sets,
        unsets,
      });
    }
  }

  if (
    !nameChanged &&
    !creates.length &&
    !reparents.length &&
    !updates.length &&
    !deletes.length &&
    !settingsDiff.sets.length &&
    !settingsDiff.unsets.length
  ) {
    return null;
  }

  return {
    ...(nameChanged ? { name: target.name } : {}),
    creates,
    reparents,
    updates,
    deletes,
    settingsSets: settingsDiff.sets,
    settingsUnsets: settingsDiff.unsets,
  };
}
