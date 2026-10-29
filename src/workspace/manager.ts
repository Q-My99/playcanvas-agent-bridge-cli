import { createHash, randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Envelope, JsonValue, TargetInfo } from "../shared/protocol.js";
import {
  DATA_JSON_TYPES,
  DEFAULT_EAGER_MAX_MB,
  TEXT_FILE_TYPES,
  buildAssetProjection,
  buildSceneProjection,
  clampEagerMaxMb,
  dataAssetFilename,
  diffAssetPatchOps,
  diffScenePatchOps,
  eagerMaxBytesFromMb,
  parseAssetProjection,
  parseDataAssetFilename,
  parseSceneFilename,
  parseSceneProjection,
  stripDataAssetSuffix,
  threeWayMergeAssetJson,
  threeWayMergeSceneJson,
  type CanonicalAssetDoc,
  type CanonicalSceneDoc,
  type JsonObject,
} from "./json-sync.js";

const PROJECT_FILE = "pcbridge.project.json";
const LEGACY_INDEX_FILE = join(".pcbridge", "asset-index.json");
const LEGACY_INDEX_BACKUP_FILE = join(".pcbridge", "asset-index.v1.json");
const SYNC_STATE_FILE = join(".pcbridge", "sync-state.json");
const BASELINES_DIR = join(".pcbridge", "baselines");
const DEFAULT_REFRESH_INTERVAL_MS = 0;
const DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS = 300;
const SELF_WRITE_TTL_MS = 5000;

type RemoteFile = {
  filename?: string;
  hash?: string;
  size?: number;
};

type RemoteAsset = {
  id: string | number;
  name: string;
  type: string;
  path?: Array<string | number>;
  file?: RemoteFile | null;
  source?: boolean;
  source_asset_id?: string | number | null;
  preload?: boolean;
  tags?: string[];
  data?: Record<string, unknown> | null;
  meta?: Record<string, JsonValue> | null;
};

type RemoteSceneSummary = {
  id: string | number;
  uniqueId?: string | number;
  name: string;
  modified?: string | null;
};

type RemoteScenePayload = {
  id: string | number;
  name: string;
  active?: boolean;
  modified?: string | null;
  settings?: Record<string, unknown>;
  entities?: Record<string, unknown>;
};

export type WorkspaceSceneDelta = {
  sceneId: string | number;
  sceneName?: string;
  settings?: Record<string, unknown>;
  upsertedEntities?: Record<string, unknown>;
  removedEntityIds?: Array<string | number>;
};

export type WorkspaceDelta = {
  upsertedAssets?: RemoteAsset[];
  removedAssetIds?: Array<string | number>;
  activeScene?: RemoteScenePayload;
  sceneDelta?: WorkspaceSceneDelta;
};

export type WorkspaceSettings = {
  eagerMaxMb: number;
  eagerMaxBytes: number;
};

type AssetRole = "source" | "derived" | "standalone";
type SyncTierMode =
  | "folder"
  | "eager-text"
  | "lazy-text"
  | "eager-json"
  | "lazy-json"
  | "derived-json"
  | "lazy-binary"
  | "derived-file";

type AssetResourceEntry = {
  filename: string;
  url: string;
  localPath: string;
  advertisedRemoteHash: string | null;
  observedRemoteHash: string | null;
  remoteHash: string | null;
  remoteFileSize: number | null;
  localHash: string | null;
};

type AssetIndexEntry = {
  id: string;
  name: string;
  type: string;
  role: AssetRole;
  sourceAssetId: string | null;
  writable: boolean;
  preload?: boolean;
  tags?: string[];
  meta?: Record<string, JsonValue> | null;
  remotePath: string[];
  localFolderPath: string[];
  localPath: string | null;
  filename: string | null;
  advertisedRemoteFileSize: number | null;
  advertisedRemoteFileHash: string | null;
  observedRemoteFileSize: number | null;
  observedRemoteFileHash: number | string | null;
  remoteFileSize: number | null;
  remoteFileHash: string | null;
  localHash: string | null;
  lastSyncedHash: string | null;
  legacyLastSyncedSha256?: string;
  pendingRemoteHash?: string;
  localFileSize?: number;
  localMtimeMs?: number;
  localIno?: number;
  localDev?: number;
  resources: Record<string, AssetResourceEntry>;
  downloaded: boolean;
  status: "indexed" | "synced" | "local-change" | "remote-change" | "conflict" | "error";
  error?: string;
};

type SceneIndexEntry = {
  id: string;
  name: string;
  active: boolean;
  writable: boolean;
  localPath: string;
  modified: string | null;
  entityCount: number;
  remoteHash: string | null;
  localHash: string | null;
  lastSyncedHash: string | null;
  localFileSize?: number;
  localMtimeMs?: number;
  status: "synced" | "conflict" | "error";
  error?: string;
};

type AssetIndex = {
  schemaVersion: 3;
  projectId: string;
  branchId: string | null;
  updatedAt: string;
  entries: Record<string, AssetIndexEntry>;
};

type LegacyAssetIndexEntry = Omit<AssetIndexEntry, "remoteFileSize"> & {
  remoteFileSize?: number | null;
};

type LegacyAssetIndex = {
  schemaVersion: 1;
  projectId: string;
  branchId: string | null;
  updatedAt: string;
  entries: Record<string, LegacyAssetIndexEntry>;
};

type ManifestAssetV2 = {
  id: string;
  name: string;
  type: string;
  folder: string;
  file: null | {
    filename: string;
    path: string;
    size: number | null;
    present: boolean;
    hash: {
      algorithm: "md5";
      remote: string | null;
      local: string | null;
      base: string | null;
      matches: boolean | null;
    };
  };
  state: "indexed" | "remote-only" | "synced" | "local-change" | "remote-change" | "conflict" | "error";
  error?: string;
};

type ManifestAsset = {
  id: string;
  name: string;
  type: string;
  folder: string;
  projectionPath: string | null;
  origin: {
    role: AssetRole;
    sourceAssetId: string | null;
  };
  meta?: Record<string, JsonValue>;
  remoteFile: null | {
    filename: string;
    size: {
      advertised: number | null;
      observed: number | null;
      effective: number | null;
    };
    hash: {
      algorithm: "md5";
      advertised: string | null;
      observed: string | null;
      effective: string | null;
    };
  };
  local: null | {
    path: string;
    present: boolean;
    writable: boolean;
    size: number | null;
    hash: {
      algorithm: "md5";
      current: string | null;
      base: string | null;
      matchesRemote: boolean | null;
    };
    resources?: Array<{
      filename: string;
      url: string;
      path: string;
      present: boolean;
      writable: false;
      size: number | null;
      hash: {
        algorithm: "md5";
        advertised: string | null;
        observed: string | null;
        effective: string | null;
        current: string | null;
      };
    }>;
  };
  state: "indexed" | "remote-only" | "synced" | "local-change" | "remote-change" | "conflict" | "error";
  error?: string;
};

type ManifestScene = {
  id: string;
  name: string | null;
  active?: boolean;
  writable?: boolean;
  path?: string;
  entityCount?: number;
  state?: "synced" | "conflict" | "error";
  error?: string;
};

type ProjectManifest = Record<string, unknown> & {
  schemaVersion?: number;
  project?: { id: string; name: string };
  activeBranch?: { id: string | null; name: string | null };
  scenes?: ManifestScene[];
  workspace?: Record<string, unknown> & {
    createdAt?: string;
    updatedAt?: string;
    lastSuccessfulSyncAt?: string | null;
  };
  settings?: Record<string, unknown>;
  assets?: Record<string, ManifestAsset | ManifestAssetV2>;
};

type SyncState = {
  schemaVersion: 1;
  projectId: string;
  branchId: string | null;
  updatedAt: string;
  lastSuccessfulSyncAt?: string | null;
  entries: Record<string, {
    legacyLastSyncedSha256?: string;
    pendingRemoteHash?: string;
    localFileSize?: number;
    localMtimeMs?: number;
    localIno?: number;
    localDev?: number;
    preload?: boolean;
    tags?: string[];
    meta?: Record<string, JsonValue> | null;
  }>;
  scenes?: Record<string, SceneIndexEntry>;
};

export type PreparedWorkspaceAsset = {
  id: string;
  name: string;
  type: string;
  filename: string | null;
  path: string | null;
  hash: string | null;
};

export type PreparedWorkspaceAssets = {
  projectDirectory: string;
  tmpDirectory: string;
  assets: PreparedWorkspaceAsset[];
};

export type WorkspaceResourceRequest = {
  assetId: string | number;
  filename: string;
  url: string;
  hash?: string | null;
};

export type PreparedWorkspaceResource = {
  assetId: string;
  filename: string;
  url: string;
  path: string;
  hash: string;
};

type SelfWriteFingerprint = {
  size: number;
  mtimeMs: number;
  hash: string;
  expiresAt: number;
  deleted?: boolean;
};

type ProjectRecord = {
  projectId: string;
  projectName: string;
  branchId: string | null;
  branchName: string | null;
  directory: string;
  assetsDirectory: string;
  scenesDirectory: string;
  tmpDirectory: string;
  objectsDirectory: string;
  baselinesDirectory: string;
  targetId: string;
  targetInfo: TargetInfo;
  connected: boolean;
  state: "initializing" | "syncing" | "synced" | "local-change" | "remote-change" | "conflict" | "error";
  lastSyncedAt: string | null;
  lastError: string | null;
  lastWarning: string | null;
  syncStartedAt: string | null;
  syncPhase: "snapshot" | "reconciling" | "persisting" | null;
  syncProgress: {
    completed: number;
    total: number;
    assetId: string | null;
    action: "comparing" | "downloading" | "uploading" | "conflict";
  } | null;
  pendingShrinkDigest: string | null;
  pendingShrinkCount: number;
  legacyIndexPath: string | null;
  index: AssetIndex;
  scenes: Record<string, SceneIndexEntry>;
  remoteAssetsCache: Map<string, RemoteAsset>;
  activeSceneMemory: RemoteScenePayload | null;
  lastSavedSyncStateComparable: string | null;
  recentSelfWrites: Map<string, SelfWriteFingerprint>;
  drainPromise: Promise<void> | null;
  dirtyFullSnapshot: boolean;
  dirtyForce: boolean;
  dirtyLocalAssetPaths: Set<string>;
  dirtyLocalScenePaths: Set<string>;
  dirtyRemoteDeltas: WorkspaceDelta[];
};

type TargetRequest = (
  target: string,
  method: string,
  params?: Record<string, JsonValue>,
  timeoutMs?: number,
) => Promise<Envelope>;

export type WorkspaceManagerOptions = {
  rootDir: string;
  requestTarget: TargetRequest;
  refreshIntervalMs?: number;
  localChangeDebounceMs?: number;
  eagerMaxMb?: number;
  settingsPath?: string | null;
};

function hashContent(value: string | Buffer): string {
  return createHash("md5").update(value).digest("hex");
}

function hashLegacyContent(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function manifestLocalPath(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split("/");
  if (parts[0] !== "assets" || parts.length < 2) return null;
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    return null;
  }
  return join(...parts.slice(1));
}

function localFolderParts(localPath: string | null): string[] {
  if (!localPath) return [];
  const parent = dirname(localPath);
  return parent === "." ? [] : parent.split(sep).filter(Boolean);
}

export function safeWorkspaceName(value: string, fallback: string): string {
  const safe = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 80);
  return safe || fallback;
}

export function safeAssetName(value: string, fallback: string): string {
  const safe = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/^[.]+$/g, "")
    .slice(0, 120);
  return safe || fallback;
}

function collisionName(filename: string, type: string, id: string): string {
  const parsedData = parseDataAssetFilename(filename);
  if (parsedData) {
    const safeType = safeAssetName(type, "asset").replaceAll(" ", "-").toLocaleLowerCase();
    return `${parsedData.stem}.__pc_${safeType}_${id}.${parsedData.type}.json`;
  }
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const safeType = safeAssetName(type, "asset").replaceAll(" ", "-").toLocaleLowerCase();
  return `${stem}.__pc_${safeType}_${id}${extension}`;
}

function stripCollisionTag(filename: string): string {
  return filename.replace(/\.__pc_[a-z0-9_-]+(?=\.[^.]+(?:\.json)?$|$)/i, "");
}

function pathNameKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function resourceKey(filename: string): string {
  return pathNameKey(filename);
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid workspace response from PlayCanvas target.");
  }
  return value as Record<string, JsonValue>;
}

function isDerivedAsset(asset: RemoteAsset): boolean {
  return asset.source_asset_id !== undefined &&
    asset.source_asset_id !== null &&
    asset.source_asset_id !== "";
}

function assetRole(asset: RemoteAsset): AssetRole {
  if (isDerivedAsset(asset)) return "derived";
  return asset.source ? "source" : "standalone";
}

function desiredLocalFilename(asset: RemoteAsset, role: AssetRole): string | null {
  if (asset.type === "folder") return null;
  if (DATA_JSON_TYPES.has(asset.type) && !asset.file?.filename) {
    return dataAssetFilename(asset.name || `${asset.type}-${asset.id}`, asset.type);
  }
  if (role === "derived" && asset.file?.filename) {
    return asset.file.filename;
  }
  if (asset.file?.filename) {
    const fileExt = extname(asset.file.filename);
    const rawName = (asset.name || "").trim();
    if (!rawName) return asset.file.filename;
    const nameExt = extname(rawName);
    if (nameExt && /^\.[a-z][a-z0-9]*$/i.test(nameExt)) {
      return rawName;
    }
    if (fileExt) {
      return `${rawName}${fileExt}`;
    }
    return rawName;
  }
  if (TEXT_FILE_TYPES.has(asset.type)) {
    return asset.name || null;
  }
  return null;
}

function sceneLocalFilename(name: string, id: string): string {
  const safe = safeAssetName(name || `Scene-${id}`, `Scene-${id}`);
  return `${safe}.${id}.scene.json`;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!values.length) return [];
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function atomicWrite(path: string, value: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, value);
  await rename(temporary, path);
}

async function ensureFileMode(path: string, writable: boolean): Promise<void> {
  try {
    const info = await stat(path);
    const isWritable = (info.mode & 0o200) !== 0;
    if (isWritable !== writable) {
      await chmod(path, writable ? 0o644 : 0o444);
    }
  } catch {
    // Ignore unsupported chmod platforms or vanished files.
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

export class WorkspaceManager {
  readonly rootDir: string;
  #requestTarget: TargetRequest;
  #records = new Map<string, ProjectRecord>();
  #refreshTimer: NodeJS.Timeout | null = null;
  #watchers = new Map<string, Set<FSWatcher>>();
  #watchTimers = new Map<string, NodeJS.Timeout>();
  #localChangeDebounceMs: number;
  #eagerMaxMb: number;
  #settingsPath: string | null;
  #settingsLoaded = false;

  constructor(options: WorkspaceManagerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.#requestTarget = options.requestTarget;
    const interval = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.#localChangeDebounceMs = options.localChangeDebounceMs ?? DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS;
    this.#eagerMaxMb = clampEagerMaxMb(options.eagerMaxMb, DEFAULT_EAGER_MAX_MB);
    this.#settingsPath = options.settingsPath ? resolve(options.settingsPath) : null;
    if (interval > 0) {
      this.#refreshTimer = setInterval(() => {
        for (const record of this.#records.values()) {
          if (record.connected) {
            void this.#enqueueSync(record, { fullSnapshot: true, force: false });
          }
        }
      }, interval);
      this.#refreshTimer.unref();
    }
  }

  async #ensureSettingsLoaded(): Promise<void> {
    if (this.#settingsLoaded) return;
    this.#settingsLoaded = true;
    if (!this.#settingsPath) return;
    const stored = await readJson<{ eagerMaxMb?: unknown }>(this.#settingsPath);
    if (stored && stored.eagerMaxMb !== undefined) {
      this.#eagerMaxMb = clampEagerMaxMb(stored.eagerMaxMb, this.#eagerMaxMb);
    }
  }

  getSettings(): WorkspaceSettings {
    return {
      eagerMaxMb: this.#eagerMaxMb,
      eagerMaxBytes: eagerMaxBytesFromMb(this.#eagerMaxMb),
    };
  }

  async updateSettings(input: { eagerMaxMb?: unknown }): Promise<WorkspaceSettings> {
    await this.#ensureSettingsLoaded();
    this.#eagerMaxMb = clampEagerMaxMb(input.eagerMaxMb, this.#eagerMaxMb);
    if (this.#settingsPath) {
      await atomicWrite(
        this.#settingsPath,
        `${JSON.stringify({
          schemaVersion: 1,
          eagerMaxMb: this.#eagerMaxMb,
          updatedAt: new Date().toISOString(),
        }, null, 2)}\n`,
      );
    }
    const syncs: Array<Promise<void>> = [];
    for (const record of this.#records.values()) {
      if (record.connected) {
        syncs.push(this.#enqueueSync(record, { fullSnapshot: true, force: false }));
      }
    }
    await Promise.allSettled(syncs);
    return this.getSettings();
  }

  async close(): Promise<void> {
    if (this.#refreshTimer) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    for (const timer of this.#watchTimers.values()) clearTimeout(timer);
    this.#watchTimers.clear();
    for (const watchers of this.#watchers.values()) {
      for (const watcher of watchers) watcher.close();
    }
    this.#watchers.clear();
    await Promise.all(
      Array.from(this.#records.values(), (record) => record.drainPromise).filter(Boolean),
    );
  }

  async handleTarget(info: TargetInfo): Promise<void> {
    await this.#ensureSettingsLoaded();
    if (
      info.kind !== "editor" ||
      !info.ready ||
      !info.projectId ||
      !info.projectName
    ) {
      return;
    }

    const existing = this.#records.get(info.projectId);
    if (existing && existing.branchId && info.branchId && existing.branchId !== info.branchId) {
      existing.state = "conflict";
      existing.lastError = `Branch ${info.branchId} cannot sync into workspace branch ${existing.branchId}.`;
      return;
    }

    const record = existing || await this.#createRecord(info);
    record.targetId = info.id;
    record.targetInfo = info;
    record.connected = true;
    record.projectName = info.projectName;
    record.branchName = info.branchName || record.branchName;
    await this.#writeManifest(record);
    this.#ensureWatcher(record);
    await this.#enqueueSync(record, { fullSnapshot: true, force: false });
  }

  async handleDelta(info: TargetInfo, delta: WorkspaceDelta): Promise<void> {
    await this.#ensureSettingsLoaded();
    if (info.kind !== "editor" || !info.ready || !info.projectId) return;
    const record = this.#records.get(info.projectId);
    if (!record) {
      if (info.projectName) await this.handleTarget(info);
      return;
    }
    if (record.branchId && info.branchId && record.branchId !== info.branchId) return;
    record.targetId = info.id;
    record.targetInfo = info;
    record.connected = true;
    record.dirtyRemoteDeltas.push(delta);
    await this.#drainQueue(record);
  }

  markDisconnected(info: TargetInfo): void {
    if (!info.projectId) return;
    const record = this.#records.get(info.projectId);
    if (record?.targetId === info.id) record.connected = false;
  }

  statusForTarget(info?: TargetInfo): JsonValue {
    const settings = this.getSettings();
    if (!info?.projectId) {
      return {
        available: false,
        state: "unavailable",
        rootDirectory: this.rootDir,
        eagerMaxMb: settings.eagerMaxMb,
        eagerMaxBytes: settings.eagerMaxBytes,
      };
    }
    const record = this.#records.get(info.projectId);
    if (!record) {
      return {
        available: false,
        state: info.kind === "editor" ? "initializing" : "unavailable",
        rootDirectory: this.rootDir,
        projectId: info.projectId,
        eagerMaxMb: settings.eagerMaxMb,
        eagerMaxBytes: settings.eagerMaxBytes,
      };
    }
    if (record.branchId && info.branchId && record.branchId !== info.branchId) {
      return {
        ...this.#status(record),
        state: "conflict",
        branchConflict: {
          workspaceBranchId: record.branchId,
          targetBranchId: info.branchId,
        },
      };
    }
    return this.#status(record);
  }

  async syncTarget(info: TargetInfo): Promise<JsonValue> {
    await this.#ensureSettingsLoaded();
    if (!info.projectId) throw new Error("The selected target has no project metadata.");
    const record = this.#records.get(info.projectId);
    if (!record) throw new Error("The selected project workspace has not been initialized.");
    if (record.branchId && info.branchId && record.branchId !== info.branchId) {
      throw new Error(`Workspace is bound to branch ${record.branchId}, not ${info.branchId}.`);
    }
    record.targetId = info.id;
    record.targetInfo = info;
    record.connected = true;
    await this.#enqueueSync(record, { fullSnapshot: true, force: false });
    return this.#status(record);
  }

  async prepareAssetFiles(
    info: TargetInfo,
    assetIds: Array<string | number>,
  ): Promise<PreparedWorkspaceAssets> {
    await this.#ensureSettingsLoaded();
    if (!info.projectId) throw new Error("The selected target has no project metadata.");
    const record = this.#records.get(info.projectId);
    if (!record) throw new Error("The selected project workspace has not been initialized.");
    record.targetId = info.id;
    record.targetInfo = info;
    record.connected = true;
    await this.#enqueueSync(record, { fullSnapshot: true, force: true });

    const ids = [...new Set(assetIds.map(String))];
    const assets = await mapWithConcurrency(ids, 4, async (id): Promise<PreparedWorkspaceAsset> => {
      const entry = record.index.entries[id];
      if (!entry) throw new Error(`Asset ${id} is not present in the workspace catalog.`);
      if (entry.status === "conflict" || entry.status === "error") {
        throw new Error(`Asset ${id} cannot be built while its workspace state is ${entry.status}.`);
      }
      if (entry.localPath && !DATA_JSON_TYPES.has(entry.type) && !existsSync(this.#assetPath(record, entry.localPath))) {
        if (TEXT_FILE_TYPES.has(entry.type) && entry.writable) {
          await this.#downloadTextAsset(record, entry);
        } else {
          await this.#downloadAsset(record, entry);
        }
      }
      const preparedPath = entry.localPath && !DATA_JSON_TYPES.has(entry.type)
        ? this.#assetPath(record, entry.localPath)
        : null;
      const preparedHash = entry.localHash;
      if (!preparedPath && entry.filename) {
        throw new Error(`Asset ${id} has a remote file but no local assets projection.`);
      }
      if (preparedPath && entry.filename) {
        await this.#removeLegacyResource(
          this.#legacyCachedFilePath(record, entry.id, entry.filename),
        );
      }
      return {
        id,
        name: entry.name,
        type: entry.type,
        filename: entry.filename,
        path: preparedPath,
        hash: preparedHash,
      };
    });
    await this.#persist(record);
    return {
      projectDirectory: record.directory,
      tmpDirectory: record.tmpDirectory,
      assets,
    };
  }

  async prepareAssetResources(
    info: TargetInfo,
    requests: WorkspaceResourceRequest[],
  ): Promise<PreparedWorkspaceResource[]> {
    await this.#ensureSettingsLoaded();
    if (!info.projectId) throw new Error("The selected target has no project metadata.");
    const record = this.#records.get(info.projectId);
    if (!record) throw new Error("The selected project workspace has not been initialized.");
    record.targetId = info.id;
    record.targetInfo = info;
    record.connected = true;

    const unique = new Map<string, WorkspaceResourceRequest & { assetId: string }>();
    for (const request of requests) {
      const assetId = String(request.assetId);
      const key = `${assetId}\0${resourceKey(request.filename)}`;
      const existing = unique.get(key);
      if (existing && existing.url !== request.url) {
        throw new Error(
          `Asset ${assetId} resource ${request.filename} has multiple remote URLs in one build.`,
        );
      }
      unique.set(key, { ...request, assetId });
    }
    if (!unique.size) return [];

    const usedPaths = new Set<string>();
    for (const entry of Object.values(record.index.entries)) {
      if (entry.localPath) usedPaths.add(pathNameKey(toPosixPath(entry.localPath)));
      for (const resource of Object.values(entry.resources)) {
        usedPaths.add(pathNameKey(toPosixPath(resource.localPath)));
      }
    }

    const preparedEntries: Array<{ entry: AssetIndexEntry; resource: AssetResourceEntry }> = [];
    const sorted = [...unique.values()].sort((left, right) => {
      const assetDifference = left.assetId.localeCompare(right.assetId, undefined, { numeric: true });
      return assetDifference || left.filename.localeCompare(right.filename);
    });
    for (const request of sorted) {
      const entry = record.index.entries[request.assetId];
      if (!entry) throw new Error(`Asset ${request.assetId} is not present in the workspace catalog.`);
      const key = resourceKey(request.filename);
      const old = entry.resources[key];
      if (old) usedPaths.delete(pathNameKey(toPosixPath(old.localPath)));

      const safeFilename = safeAssetName(request.filename, `resource-${entry.id}`);
      const allocate = (filename: string) => join(...entry.localFolderPath, filename);
      const occupied = (localPath: string) => {
        const pathKey = pathNameKey(toPosixPath(localPath));
        return usedPaths.has(pathKey) ||
          (localPath !== old?.localPath && existsSync(this.#assetPath(record, localPath)));
      };
      let localPath = allocate(safeFilename);
      if (occupied(localPath)) localPath = allocate(collisionName(safeFilename, "resource", entry.id));
      let suffix = 2;
      while (occupied(localPath)) {
        localPath = allocate(collisionName(safeFilename, "resource", `${entry.id}_${suffix}`));
        suffix += 1;
      }
      usedPaths.add(pathNameKey(toPosixPath(localPath)));

      if (old?.localPath && old.localPath !== localPath && existsSync(this.#assetPath(record, old.localPath))) {
        const oldPath = this.#assetPath(record, old.localPath);
        const nextPath = this.#assetPath(record, localPath);
        await mkdir(dirname(nextPath), { recursive: true });
        await chmod(oldPath, 0o644).catch(() => undefined);
        await rename(oldPath, nextPath);
        this.#markSelfDeleted(record, oldPath);
      }

      const advertisedRemoteHash = request.hash || null;
      const metadataUnchanged = old?.url === request.url &&
        old.advertisedRemoteHash === advertisedRemoteHash;
      const observedRemoteHash = metadataUnchanged ? old?.observedRemoteHash ?? null : null;
      const resource: AssetResourceEntry = {
        filename: request.filename,
        url: request.url,
        localPath,
        advertisedRemoteHash,
        observedRemoteHash,
        remoteHash: observedRemoteHash || advertisedRemoteHash ||
          (metadataUnchanged ? old?.remoteHash ?? null : null),
        remoteFileSize: metadataUnchanged ? old?.remoteFileSize ?? null : null,
        localHash: old?.localHash || null,
      };
      entry.resources[key] = resource;
      preparedEntries.push({ entry, resource });
    }

    const prepared = await mapWithConcurrency(preparedEntries, 4, ({ entry, resource }) =>
      this.#prepareAssetResourceContent(record, entry, resource));
    await this.#persist(record);
    const preparedByKey = new Map(prepared.map((resource) => [
      `${resource.assetId}\0${resourceKey(resource.filename)}`,
      resource,
    ]));
    return requests.map((request) => {
      const preparedResource = preparedByKey.get(
        `${String(request.assetId)}\0${resourceKey(request.filename)}`,
      );
      if (!preparedResource) {
        throw new Error(`Asset ${request.assetId} resource ${request.filename} was not prepared.`);
      }
      return preparedResource;
    });
  }

  async pullAsset(info: TargetInfo, assetId: string): Promise<JsonValue> {
    await this.#ensureSettingsLoaded();
    if (!info.projectId) throw new Error("The selected target has no project metadata.");
    const record = this.#records.get(info.projectId);
    if (!record) throw new Error("The selected project workspace has not been initialized.");
    const entry = record.index.entries[String(assetId)];
    if (!entry) throw new Error(`Asset ${assetId} is not present in the workspace index.`);
    if (!entry.localPath) throw new Error(`Asset ${assetId} has no downloadable file.`);

    let result: { path: string; size: number; hash: string };
    if (DATA_JSON_TYPES.has(entry.type)) {
      const remoteAsset = record.remoteAssetsCache.get(entry.id);
      if (!remoteAsset) {
        await this.#enqueueSync(record, { fullSnapshot: true, force: false });
      }
      const cachedAsset = record.remoteAssetsCache.get(entry.id);
      const projection = buildAssetProjection({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        preload: cachedAsset?.preload ?? entry.preload,
        tags: cachedAsset?.tags ?? entry.tags,
        data: cachedAsset?.data ?? {},
        role: entry.role,
        sourceAssetId: entry.sourceAssetId,
        writable: entry.writable,
      });
      const bytes = Buffer.from(projection.text, "utf8");
      const hash = hashContent(bytes);
      const path = await this.#writeManagedAssetFile(record, entry, bytes, hash);
      await this.#saveAssetBaseline(record, entry.id, projection.doc);
      entry.remoteFileHash = hash;
      entry.remoteFileSize = bytes.byteLength;
      entry.lastSyncedHash = hash;
      entry.status = "synced";
      delete entry.error;
      result = { path, size: bytes.byteLength, hash };
    } else if (TEXT_FILE_TYPES.has(entry.type) && entry.writable) {
      result = await this.#downloadTextAsset(record, entry);
    } else {
      result = await this.#downloadAsset(record, entry);
    }

    await this.#persist(record);
    return {
      assetId,
      path: result.path,
      size: result.size,
      hash: result.hash,
      hashAlgorithm: "md5",
    };
  }

  async #createRecord(info: TargetInfo): Promise<ProjectRecord> {
    await mkdir(this.rootDir, { recursive: true });
    const existingDirectory = await this.#findProjectDirectory(info.projectId || "");
    const directoryName = `${info.projectId}-${safeWorkspaceName(info.projectName || "project", "project")}`;
    const directory = existingDirectory || this.#withinRoot(join(this.rootDir, directoryName));
    if (await isSymbolicLink(directory)) {
      throw new Error(`Workspace project directory cannot be a symbolic link: ${directory}`);
    }
    const assetsDirectory = join(directory, "assets");
    const scenesDirectory = join(directory, "scenes");
    const tmpDirectory = join(directory, "tmp");
    const objectsDirectory = join(directory, ".pcbridge", "objects");
    const baselinesDirectory = join(directory, BASELINES_DIR);
    await mkdir(assetsDirectory, { recursive: true });
    await mkdir(join(tmpDirectory, "scripts"), { recursive: true });
    await mkdir(join(tmpDirectory, "captures"), { recursive: true });
    await mkdir(join(tmpDirectory, "conflicts"), { recursive: true });
    await mkdir(join(tmpDirectory, "trash", "remote"), { recursive: true });
    await mkdir(join(tmpDirectory, "trash", "local"), { recursive: true });
    await mkdir(join(directory, ".pcbridge"), { recursive: true });
    await mkdir(objectsDirectory, { recursive: true });
    await mkdir(baselinesDirectory, { recursive: true });

    const manifest = await readJson<ProjectManifest>(join(directory, PROJECT_FILE));
    const syncState = await readJson<SyncState>(join(directory, SYNC_STATE_FILE));
    const legacyPrimaryPath = join(directory, LEGACY_INDEX_FILE);
    const legacyBackupPath = join(directory, LEGACY_INDEX_BACKUP_FILE);
    const legacyPrimary = await readJson<LegacyAssetIndex>(legacyPrimaryPath);
    const legacyBackup = legacyPrimary ? null : await readJson<LegacyAssetIndex>(legacyBackupPath);
    const legacy = legacyPrimary?.schemaVersion === 1
      ? legacyPrimary
      : legacyBackup?.schemaVersion === 1 ? legacyBackup : null;
    const index = (manifest?.schemaVersion === 2 || manifest?.schemaVersion === 3) && manifest.assets
      ? this.#indexFromManifest(manifest, syncState, info)
      : await this.#indexFromLegacy(directory, legacy, info);
    const record: ProjectRecord = {
      projectId: info.projectId || "",
      projectName: info.projectName || "Project",
      branchId: info.branchId || index.branchId || null,
      branchName: info.branchName || null,
      directory,
      assetsDirectory,
      scenesDirectory,
      tmpDirectory,
      objectsDirectory,
      baselinesDirectory,
      targetId: info.id,
      targetInfo: info,
      connected: true,
      state: "initializing",
      lastSyncedAt: typeof syncState?.lastSuccessfulSyncAt === "string"
        ? syncState.lastSuccessfulSyncAt
        : typeof manifest?.workspace?.lastSuccessfulSyncAt === "string"
          ? manifest.workspace.lastSuccessfulSyncAt
          : null,
      lastError: null,
      lastWarning: null,
      syncStartedAt: null,
      syncPhase: null,
      syncProgress: null,
      pendingShrinkDigest: null,
      pendingShrinkCount: 0,
      legacyIndexPath: legacyPrimary?.schemaVersion === 1 ? legacyPrimaryPath : null,
      index,
      scenes: syncState?.scenes ? { ...syncState.scenes } : {},
      remoteAssetsCache: new Map(),
      activeSceneMemory: null,
      lastSavedSyncStateComparable: null,
      recentSelfWrites: new Map(),
      drainPromise: null,
      dirtyFullSnapshot: false,
      dirtyForce: false,
      dirtyLocalAssetPaths: new Set(),
      dirtyLocalScenePaths: new Set(),
      dirtyRemoteDeltas: [],
    };
    this.#records.set(record.projectId, record);
    return record;
  }

  #pruneSelfWrites(record: ProjectRecord): void {
    const now = Date.now();
    for (const [path, fp] of record.recentSelfWrites) {
      if (fp.expiresAt <= now) record.recentSelfWrites.delete(path);
    }
  }

  #markSelfDeleted(record: ProjectRecord, absPath: string): void {
    record.recentSelfWrites.set(absPath, {
      size: 0,
      mtimeMs: 0,
      hash: "",
      deleted: true,
      expiresAt: Date.now() + SELF_WRITE_TTL_MS,
    });
  }

  async #isSelfWriteEcho(record: ProjectRecord, absPath: string): Promise<boolean> {
    this.#pruneSelfWrites(record);
    const fp = record.recentSelfWrites.get(absPath);
    if (!fp) return false;
    if (fp.deleted) return !existsSync(absPath);
    if (!existsSync(absPath)) return false;
    try {
      const info = await stat(absPath);
      if (info.size === fp.size && Math.abs(info.mtimeMs - fp.mtimeMs) < 2) {
        return true;
      }
      if (info.size === fp.size && hashContent(await readFile(absPath)) === fp.hash) {
        record.recentSelfWrites.set(absPath, {
          ...fp,
          mtimeMs: info.mtimeMs,
        });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  #ensureWatcher(record: ProjectRecord): void {
    if (this.#watchers.has(record.projectId)) return;
    const watchers = new Set<FSWatcher>();
    this.#watchers.set(record.projectId, watchers);

    const scheduleFlush = () => {
      const existing = this.#watchTimers.get(record.projectId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.#watchTimers.delete(record.projectId);
        if (record.connected) void this.#drainQueue(record);
      }, this.#localChangeDebounceMs);
      timer.unref();
      this.#watchTimers.set(record.projectId, timer);
    };

    const onAssetEvent = (filename: string | Buffer | null | undefined) => {
      if (!filename) return;
      const relativeName = toPosixPath(String(filename));
      if (
        !relativeName ||
        basename(relativeName).startsWith(".") ||
        relativeName.startsWith(".pcbridge/") ||
        relativeName.startsWith("tmp/") ||
        relativeName.includes("/tmp/")
      ) {
        return;
      }
      record.dirtyLocalAssetPaths.add(relativeName);
      scheduleFlush();
    };

    const onSceneEvent = (filename: string | Buffer | null | undefined) => {
      if (!filename) return;
      const relativeName = toPosixPath(String(filename));
      if (!relativeName || basename(relativeName).startsWith(".") || !relativeName.endsWith(".scene.json")) {
        return;
      }
      record.dirtyLocalScenePaths.add(relativeName);
      scheduleFlush();
    };

    const watchTree = (targetDirectory: string, handler: (filename: string | Buffer | null | undefined) => void) => {
      if (!existsSync(targetDirectory)) return;
      try {
        const watcher = watch(targetDirectory, { recursive: true }, (_event, filename) => {
          handler(filename);
        });
        watcher.on("error", (error) => {
          record.lastWarning = `Local workspace watcher stopped: ${String(error)}`;
        });
        watchers.add(watcher);
      } catch (error) {
        const attach = async (directory: string, prefix = ""): Promise<void> => {
          let watcher: FSWatcher;
          try {
            watcher = watch(directory, (_event, filename) => {
              if (!filename) return;
              handler(prefix ? `${prefix}/${String(filename)}` : filename);
            });
          } catch {
            return;
          }
          watchers.add(watcher);
          let children;
          try {
            children = await readdir(directory, { withFileTypes: true });
          } catch {
            return;
          }
          await Promise.all(
            children
              .filter((child) => child.isDirectory())
              .map((child) => attach(join(directory, child.name), prefix ? `${prefix}/${child.name}` : child.name)),
          );
        };
        void attach(targetDirectory);
        record.lastWarning = `Recursive local watcher unavailable; using directory watchers (${String(error)})`;
      }
    };

    watchTree(record.assetsDirectory, onAssetEvent);
    if (existsSync(record.scenesDirectory)) {
      (record as ProjectRecord & { _scenesWatched?: boolean })._scenesWatched = true;
      watchTree(record.scenesDirectory, onSceneEvent);
    }
  }

  #ensureScenesWatcher(record: ProjectRecord): void {
    const watchers = this.#watchers.get(record.projectId);
    if (!watchers || !existsSync(record.scenesDirectory)) return;
    if ((record as ProjectRecord & { _scenesWatched?: boolean })._scenesWatched) return;
    (record as ProjectRecord & { _scenesWatched?: boolean })._scenesWatched = true;
    try {
      const watcher = watch(record.scenesDirectory, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const relativeName = toPosixPath(String(filename));
        if (!relativeName || basename(relativeName).startsWith(".") || !relativeName.endsWith(".scene.json")) {
          return;
        }
        record.dirtyLocalScenePaths.add(relativeName);
        const existing = this.#watchTimers.get(record.projectId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.#watchTimers.delete(record.projectId);
          if (record.connected) void this.#drainQueue(record);
        }, this.#localChangeDebounceMs);
        timer.unref();
        this.#watchTimers.set(record.projectId, timer);
      });
      watcher.on("error", () => undefined);
      watchers.add(watcher);
    } catch {
      // Directory-level fallback is handled on manual sync if recursive watch is unavailable.
    }
  }

  async #findProjectDirectory(projectId: string): Promise<string | null> {
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = this.#withinRoot(join(this.rootDir, entry.name));
      const manifest = await readJson<ProjectManifest>(join(directory, PROJECT_FILE));
      if (manifest?.project?.id === projectId) return directory;
    }
    return null;
  }

  #withinRoot(path: string): string {
    const resolved = resolve(path);
    if (resolved !== this.rootDir && !resolved.startsWith(`${this.rootDir}${sep}`)) {
      throw new Error(`Workspace path escapes daemon root: ${path}`);
    }
    return resolved;
  }

  #assetPath(record: ProjectRecord, localPath: string): string {
    const path = this.#withinRoot(join(record.assetsDirectory, localPath));
    if (path !== record.assetsDirectory && !path.startsWith(`${record.assetsDirectory}${sep}`)) {
      throw new Error(`Asset path escapes project assets directory: ${localPath}`);
    }
    return path;
  }

  #scenePath(record: ProjectRecord, localPath: string): string {
    const path = this.#withinRoot(join(record.scenesDirectory, localPath));
    if (path !== record.scenesDirectory && !path.startsWith(`${record.scenesDirectory}${sep}`)) {
      throw new Error(`Scene path escapes project scenes directory: ${localPath}`);
    }
    return path;
  }

  #assetBaselinePath(record: ProjectRecord, assetId: string): string {
    return this.#withinRoot(join(record.baselinesDirectory, `asset-${safeAssetName(assetId, "asset")}.json`));
  }

  #sceneBaselinePath(record: ProjectRecord, sceneId: string): string {
    return this.#withinRoot(join(record.baselinesDirectory, `scene-${safeAssetName(sceneId, "scene")}.json`));
  }

  async #loadAssetBaseline(record: ProjectRecord, assetId: string): Promise<CanonicalAssetDoc | null> {
    return readJson<CanonicalAssetDoc>(this.#assetBaselinePath(record, assetId));
  }

  async #saveAssetBaseline(record: ProjectRecord, assetId: string, doc: CanonicalAssetDoc): Promise<void> {
    await atomicWrite(this.#assetBaselinePath(record, assetId), `${JSON.stringify(doc, null, 2)}\n`);
  }

  async #deleteAssetBaseline(record: ProjectRecord, assetId: string): Promise<void> {
    await rm(this.#assetBaselinePath(record, assetId), { force: true }).catch(() => undefined);
  }

  async #loadSceneBaseline(record: ProjectRecord, sceneId: string): Promise<CanonicalSceneDoc | null> {
    return readJson<CanonicalSceneDoc>(this.#sceneBaselinePath(record, sceneId));
  }

  async #saveSceneBaseline(record: ProjectRecord, sceneId: string, doc: CanonicalSceneDoc): Promise<void> {
    await atomicWrite(this.#sceneBaselinePath(record, sceneId), `${JSON.stringify(doc, null, 2)}\n`);
  }

  async #deleteSceneBaseline(record: ProjectRecord, sceneId: string): Promise<void> {
    await rm(this.#sceneBaselinePath(record, sceneId), { force: true }).catch(() => undefined);
  }

  #syncTierForAsset(entry: AssetIndexEntry, estimatedBytes?: number | null): SyncTierMode {
    if (entry.type === "folder") return "folder";
    const eagerMaxBytes = eagerMaxBytesFromMb(this.#eagerMaxMb);
    if (DATA_JSON_TYPES.has(entry.type) && !entry.filename) {
      if (!entry.writable) return "derived-json";
      const size = estimatedBytes ?? entry.remoteFileSize ?? 0;
      return size <= eagerMaxBytes ? "eager-json" : "lazy-json";
    }
    if (entry.role === "derived") return "derived-file";
    if (TEXT_FILE_TYPES.has(entry.type)) {
      const size = estimatedBytes ?? entry.remoteFileSize ?? 0;
      return size <= eagerMaxBytes ? "eager-text" : "lazy-text";
    }
    return "lazy-binary";
  }

  #isTier1EagerWritable(entry: AssetIndexEntry): boolean {
    if (!entry.writable) return false;
    const tier = this.#syncTierForAsset(entry);
    return tier === "eager-text" || tier === "eager-json";
  }

  #indexFromManifest(
    manifest: ProjectManifest,
    syncState: SyncState | null,
    info: TargetInfo,
  ): AssetIndex {
    const entries: Record<string, AssetIndexEntry> = {};
    for (const [id, rawAsset] of Object.entries(manifest.assets || {})) {
      if (
        manifest.schemaVersion === 3 &&
        rawAsset &&
        typeof rawAsset === "object" &&
        "remoteFile" in rawAsset &&
        "origin" in rawAsset
      ) {
        const asset = rawAsset as ManifestAsset;
        const localPath = manifestLocalPath(asset.local?.path);
        const projectionPath = manifestLocalPath(asset.projectionPath || undefined);
        const present = Boolean(localPath && asset.local?.present);
        const state = asset.state === "remote-only" ? "indexed" : asset.state;
        const advertisedSize = asset.remoteFile?.size.advertised ?? null;
        const advertisedHash = asset.remoteFile?.hash.advertised || null;
        const observedSize = asset.remoteFile?.size.observed ?? null;
        const observedHash = asset.remoteFile?.hash.observed || null;
        const stateExtra = syncState?.entries?.[id];
        const resources = Object.fromEntries((asset.local?.resources || []).flatMap((resource) => {
          const resourcePath = manifestLocalPath(resource.path);
          if (!resourcePath) return [];
          return [[resourceKey(resource.filename), {
            filename: resource.filename,
            url: resource.url,
            localPath: resourcePath,
            advertisedRemoteHash: resource.hash.advertised,
            observedRemoteHash: resource.hash.observed,
            remoteHash: resource.hash.effective,
            remoteFileSize: resource.size,
            localHash: resource.present ? resource.hash.current : null,
          } satisfies AssetResourceEntry]];
        }));
        entries[id] = {
          id,
          name: asset.name,
          type: asset.type,
          role: asset.origin.role,
          sourceAssetId: asset.origin.sourceAssetId,
          writable: (DATA_JSON_TYPES.has(asset.type) && !asset.remoteFile?.filename)
            ? true
            : (asset.local?.writable ?? asset.origin.role !== "derived"),
          preload: stateExtra?.preload,
          tags: stateExtra?.tags,
          meta: asset.meta ?? stateExtra?.meta ?? null,
          remotePath: asset.folder ? asset.folder.split("/").filter(Boolean) : [],
          localFolderPath: asset.type === "folder"
            ? projectionPath?.split(sep).filter(Boolean) || []
            : localFolderParts(localPath),
          localPath,
          filename: asset.remoteFile?.filename || null,
          advertisedRemoteFileSize: advertisedSize,
          advertisedRemoteFileHash: advertisedHash,
          observedRemoteFileSize: observedSize,
          observedRemoteFileHash: observedHash,
          remoteFileSize: asset.remoteFile?.size.effective ?? observedSize ?? advertisedSize,
          remoteFileHash: asset.remoteFile?.hash.effective || observedHash || advertisedHash,
          localHash: asset.local?.hash.current || null,
          lastSyncedHash: asset.local?.hash.base || null,
          legacyLastSyncedSha256: stateExtra?.legacyLastSyncedSha256,
          pendingRemoteHash: stateExtra?.pendingRemoteHash,
          localFileSize: stateExtra?.localFileSize ?? asset.local?.size ?? undefined,
          localMtimeMs: stateExtra?.localMtimeMs,
          localIno: stateExtra?.localIno,
          localDev: stateExtra?.localDev,
          resources,
          downloaded: present,
          status: state,
          error: asset.error,
        };
        continue;
      }
      const asset = rawAsset as ManifestAssetV2;
      const localPath = manifestLocalPath(asset.file?.path);
      const present = Boolean(localPath && asset.file?.present);
      const state = asset.state === "remote-only" ? "indexed" : asset.state;
      const remoteFileSize = asset.file?.size ?? null;
      const remoteFileHash = asset.file?.hash.remote || null;
      const stateExtra = syncState?.entries?.[id];
      entries[id] = {
        id,
        name: asset.name,
        type: asset.type,
        role: "standalone",
        sourceAssetId: null,
        writable: true,
        remotePath: asset.folder ? asset.folder.split("/").filter(Boolean) : [],
        localFolderPath: localFolderParts(localPath),
        localPath,
        filename: asset.file?.filename || null,
        advertisedRemoteFileSize: remoteFileSize,
        advertisedRemoteFileHash: remoteFileHash,
        observedRemoteFileSize: null,
        observedRemoteFileHash: null,
        remoteFileSize,
        remoteFileHash,
        localHash: asset.file?.hash.local || null,
        lastSyncedHash: asset.file?.hash.base || null,
        legacyLastSyncedSha256: stateExtra?.legacyLastSyncedSha256,
        pendingRemoteHash: stateExtra?.pendingRemoteHash,
        localFileSize: stateExtra?.localFileSize,
        localMtimeMs: stateExtra?.localMtimeMs,
        localIno: stateExtra?.localIno,
        localDev: stateExtra?.localDev,
        resources: {},
        downloaded: present,
        status: state,
        error: asset.error,
      };
    }
    return {
      schemaVersion: 3,
      projectId: info.projectId || manifest.project?.id || "",
      branchId: info.branchId || manifest.activeBranch?.id || null,
      updatedAt: manifest.workspace?.updatedAt || new Date().toISOString(),
      entries,
    };
  }

  async #indexFromLegacy(
    directory: string,
    legacy: LegacyAssetIndex | null,
    info: TargetInfo,
  ): Promise<AssetIndex> {
    const entries: Record<string, AssetIndexEntry> = {};
    for (const [id, old] of Object.entries(legacy?.entries || {})) {
      const localPath = old.localPath || null;
      const assetsDirectory = resolve(directory, "assets");
      const candidate = localPath ? resolve(assetsDirectory, localPath) : null;
      const path = candidate && candidate.startsWith(`${assetsDirectory}${sep}`) ? candidate : null;
      const localContent = path && existsSync(path) ? await readFile(path) : null;
      const localHash = localContent ? hashContent(localContent) : null;
      const localSha256 = localContent ? hashLegacyContent(localContent) : null;
      const migratedBase = old.lastSyncedHash && localSha256 === old.lastSyncedHash
        ? old.remoteFileHash || null
        : null;
      entries[id] = {
        id,
        name: old.name,
        type: old.type,
        role: "standalone",
        sourceAssetId: null,
        writable: true,
        remotePath: old.remotePath || [],
        localFolderPath: localPath ? localFolderParts(localPath) : old.remotePath || [],
        localPath,
        filename: old.filename || null,
        advertisedRemoteFileSize: old.remoteFileSize ?? null,
        advertisedRemoteFileHash: old.remoteFileHash || null,
        observedRemoteFileSize: null,
        observedRemoteFileHash: null,
        remoteFileSize: old.remoteFileSize ?? null,
        remoteFileHash: old.remoteFileHash || null,
        localHash,
        lastSyncedHash: migratedBase,
        legacyLastSyncedSha256: migratedBase ? undefined : old.lastSyncedHash || undefined,
        pendingRemoteHash: old.pendingRemoteHash,
        localFileSize: old.localFileSize,
        localMtimeMs: old.localMtimeMs,
        resources: old.resources || {},
        downloaded: Boolean(localContent),
        status: old.status,
        error: old.error,
      };
    }
    return {
      schemaVersion: 3,
      projectId: info.projectId || legacy?.projectId || "",
      branchId: info.branchId || legacy?.branchId || null,
      updatedAt: legacy?.updatedAt || new Date().toISOString(),
      entries,
    };
  }

  #manifestAssets(record: ProjectRecord): Record<string, ManifestAsset> {
    const assets: Record<string, ManifestAsset> = {};
    const sorted = Object.values(record.index.entries)
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
    for (const entry of sorted) {
      const present = Boolean(
        entry.localPath && entry.downloaded && existsSync(this.#assetPath(record, entry.localPath)),
      );
      const publicState = entry.status === "indexed" && entry.localPath && !present
        ? "remote-only"
        : entry.status;
      const resources = Object.values(entry.resources)
        .sort((left, right) => left.localPath.localeCompare(right.localPath))
        .map((resource) => {
          const resourcePresent = existsSync(this.#assetPath(record, resource.localPath));
          return {
            filename: resource.filename,
            url: resource.url,
            path: `assets/${toPosixPath(resource.localPath)}`,
            present: resourcePresent,
            writable: false as const,
            size: resourcePresent ? resource.remoteFileSize : null,
            hash: {
              algorithm: "md5" as const,
              advertised: resource.advertisedRemoteHash,
              observed: resource.observedRemoteHash,
              effective: resource.remoteHash,
              current: resourcePresent ? resource.localHash : null,
            },
          };
        });
      const observedHashStr = typeof entry.observedRemoteFileHash === "string"
        ? entry.observedRemoteFileHash
        : null;
      const asset: ManifestAsset = {
        id: entry.id,
        name: entry.name,
        type: entry.type,
        folder: toPosixPath(entry.remotePath.join("/")),
        projectionPath: entry.type === "folder"
          ? entry.localFolderPath.length ? `assets/${toPosixPath(entry.localFolderPath.join("/"))}` : "assets"
          : entry.localPath ? `assets/${toPosixPath(entry.localPath)}` : null,
        origin: {
          role: entry.role,
          sourceAssetId: entry.sourceAssetId,
        },
        ...(entry.meta && Object.keys(entry.meta).length ? { meta: entry.meta } : {}),
        remoteFile: entry.filename
          ? {
              filename: entry.filename,
              size: {
                advertised: entry.advertisedRemoteFileSize,
                observed: entry.observedRemoteFileSize,
                effective: entry.remoteFileSize,
              },
              hash: {
                algorithm: "md5",
                advertised: entry.advertisedRemoteFileHash,
                observed: observedHashStr,
                effective: entry.remoteFileHash,
              },
            }
          : null,
        local: entry.localPath
          ? {
              path: `assets/${toPosixPath(entry.localPath)}`,
              present,
              writable: entry.writable,
              size: entry.localFileSize ?? null,
              hash: {
                algorithm: "md5",
                current: entry.localHash,
                base: entry.lastSyncedHash,
                matchesRemote: entry.remoteFileHash && present && entry.localHash
                  ? entry.remoteFileHash === entry.localHash
                  : null,
              },
              ...(resources.length ? { resources } : {}),
            }
          : null,
        state: publicState,
      };
      if (entry.error) asset.error = entry.error;
      assets[entry.id] = asset;
    }
    return assets;
  }

  #manifestScenes(record: ProjectRecord, existingScenes?: ManifestScene[]): ManifestScene[] {
    const sceneEntries = Object.values(record.scenes);
    if (sceneEntries.length) {
      return sceneEntries
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
        .map((scene) => {
          const item: ManifestScene = {
            id: scene.id,
            name: scene.name,
            active: scene.active,
            writable: scene.writable,
            path: `scenes/${toPosixPath(scene.localPath)}`,
            entityCount: scene.entityCount,
            state: scene.status,
          };
          if (scene.error) item.error = scene.error;
          return item;
        });
    }
    const scenes = Array.isArray(existingScenes) ? existingScenes.map((s) => ({ ...s })) : [];
    const info = record.targetInfo;
    if (info.sceneId) {
      const found = scenes.find((item) => item.id === info.sceneId);
      if (found) found.name = info.sceneName || found.name;
      else scenes.push({ id: info.sceneId, name: info.sceneName || null });
    }
    return scenes;
  }

  async #writeManifest(record: ProjectRecord): Promise<void> {
    const path = join(record.directory, PROJECT_FILE);
    const existing = await readJson<ProjectManifest>(path);
    const scenes = this.#manifestScenes(record, existing?.scenes);
    const now = new Date().toISOString();
    const existingSettings = existing?.settings && typeof existing.settings === "object"
      ? existing.settings
      : {};
    const existingSync = existingSettings.sync && typeof existingSettings.sync === "object"
      ? existingSettings.sync as Record<string, unknown>
      : {};
    const previousLastSuccessfulSyncAt = existing?.workspace &&
      Object.prototype.hasOwnProperty.call(existing.workspace, "lastSuccessfulSyncAt")
      ? existing.workspace.lastSuccessfulSyncAt
      : record.lastSyncedAt;
    const manifest: ProjectManifest = {
      ...(existing || {}),
      schemaVersion: 3,
      project: { id: record.projectId, name: record.projectName },
      activeBranch: { id: record.branchId, name: record.branchName },
      scenes,
      workspace: {
        ...(existing?.workspace || {}),
        createdAt: existing?.workspace?.createdAt || now,
        updatedAt: existing?.workspace?.updatedAt || now,
        assetCatalogComplete: Boolean(record.lastSyncedAt),
        assetCount: Object.values(record.index.entries)
          .filter((entry) => entry.type !== "folder").length,
        assetHashAlgorithm: "md5",
        lastSuccessfulSyncAt: previousLastSuccessfulSyncAt,
      },
      settings: {
        ...existingSettings,
        sync: {
          conflictPolicy: "safe-newer",
          deletePolicy: "quarantine",
          ...existingSync,
          contentMode: "all",
          eagerMaxMb: this.#eagerMaxMb,
        },
      },
      assets: this.#manifestAssets(record),
    };
    if (existing && JSON.stringify(manifest) === JSON.stringify(existing)) return;
    manifest.workspace = {
      ...manifest.workspace,
      updatedAt: now,
      lastSuccessfulSyncAt: record.lastSyncedAt,
    };
    await atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async #writeSyncState(record: ProjectRecord): Promise<void> {
    const entries = Object.fromEntries(
      Object.values(record.index.entries)
        .filter((entry) =>
          entry.legacyLastSyncedSha256 ||
          entry.pendingRemoteHash ||
          entry.localFileSize !== undefined ||
          entry.localMtimeMs !== undefined ||
          entry.localIno !== undefined ||
          entry.preload !== undefined ||
          (entry.tags && entry.tags.length) ||
          entry.meta
        )
        .map((entry) => [entry.id, {
          legacyLastSyncedSha256: entry.legacyLastSyncedSha256,
          pendingRemoteHash: entry.pendingRemoteHash,
          localFileSize: entry.localFileSize,
          localMtimeMs: entry.localMtimeMs,
          localIno: entry.localIno,
          localDev: entry.localDev,
          preload: entry.preload,
          tags: entry.tags,
          meta: entry.meta,
        }]),
    );
    const comparable = JSON.stringify({
      projectId: record.projectId,
      branchId: record.branchId,
      entries,
      scenes: record.scenes,
    });
    if (record.lastSavedSyncStateComparable === comparable) return;
    record.lastSavedSyncStateComparable = comparable;
    record.index.updatedAt = new Date().toISOString();
    await atomicWrite(
      join(record.directory, SYNC_STATE_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: record.projectId,
        branchId: record.branchId,
        updatedAt: record.index.updatedAt,
        lastSuccessfulSyncAt: record.lastSyncedAt,
        entries,
        ...(Object.keys(record.scenes).length ? { scenes: record.scenes } : {}),
      } satisfies SyncState, null, 2)}\n`,
    );
  }

  async #persist(record: ProjectRecord): Promise<void> {
    await this.#writeManifest(record);
    await this.#writeSyncState(record);
    if (record.legacyIndexPath && existsSync(record.legacyIndexPath)) {
      const backup = join(record.directory, LEGACY_INDEX_BACKUP_FILE);
      if (!existsSync(backup)) await rename(record.legacyIndexPath, backup);
      if (!existsSync(record.legacyIndexPath)) record.legacyIndexPath = null;
    }
  }

  #recomputeOverallState(record: ProjectRecord): void {
    const entries = Object.values(record.index.entries);
    const scenes = Object.values(record.scenes);
    record.state = entries.some((entry) => entry.status === "conflict") || scenes.some((s) => s.status === "conflict")
      ? "conflict"
      : entries.some((entry) => entry.status === "local-change")
        ? "local-change"
        : entries.some((entry) => entry.status === "remote-change")
          ? "remote-change"
          : entries.some((entry) => entry.status === "error") || scenes.some((s) => s.status === "error")
            ? "error"
            : "synced";
  }

  #hasQueuedWork(record: ProjectRecord): boolean {
    return (
      record.dirtyFullSnapshot ||
      record.dirtyRemoteDeltas.length > 0 ||
      record.dirtyLocalAssetPaths.size > 0 ||
      record.dirtyLocalScenePaths.size > 0
    );
  }

  async #enqueueSync(
    record: ProjectRecord,
    options: { fullSnapshot?: boolean; force?: boolean },
  ): Promise<void> {
    if (options.fullSnapshot) record.dirtyFullSnapshot = true;
    if (options.force) record.dirtyForce = true;
    await this.#drainQueue(record);
  }

  async #drainQueue(record: ProjectRecord): Promise<void> {
    if (record.drainPromise) {
      await record.drainPromise;
      if (this.#hasQueuedWork(record)) {
        await this.#drainQueue(record);
      }
      return;
    }
    record.drainPromise = (async () => {
      while (this.#hasQueuedWork(record)) {
        if (record.dirtyFullSnapshot) {
          const force = record.dirtyForce;
          record.dirtyFullSnapshot = false;
          record.dirtyForce = false;
          record.dirtyRemoteDeltas.length = 0;
          record.dirtyLocalAssetPaths.clear();
          record.dirtyLocalScenePaths.clear();
          const pendingTimer = this.#watchTimers.get(record.projectId);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.#watchTimers.delete(record.projectId);
          }
          await this.#performFullSync(record, force);
          continue;
        }
        if (record.dirtyRemoteDeltas.length > 0) {
          const batch = record.dirtyRemoteDeltas.splice(0, record.dirtyRemoteDeltas.length);
          await this.#performRemoteDeltas(record, batch);
          continue;
        }
        if (record.dirtyLocalScenePaths.size > 0) {
          const paths = [...record.dirtyLocalScenePaths];
          record.dirtyLocalScenePaths.clear();
          await this.#performLocalSceneChanges(record, paths);
          continue;
        }
        if (record.dirtyLocalAssetPaths.size > 0) {
          const paths = [...record.dirtyLocalAssetPaths];
          record.dirtyLocalAssetPaths.clear();
          await this.#performLocalAssetChanges(record, paths);
          continue;
        }
      }
    })().finally(() => {
      record.drainPromise = null;
    });
    return record.drainPromise;
  }

  async #performFullSync(record: ProjectRecord, force: boolean): Promise<void> {
    const previousState = record.state === "syncing" ? "initializing" : record.state;
    record.state = "syncing";
    record.lastError = null;
    record.lastWarning = null;
    record.syncStartedAt = new Date().toISOString();
    record.syncPhase = "snapshot";
    try {
      const response = await this.#requestTarget(
        record.targetId,
        "bridge:workspaceSnapshot",
        {},
        60000,
      );
      if (!response.ok) throw new Error(response.error.message);
      const data = asObject(response.data);
      const assets = Array.isArray(data.assets) ? data.assets as unknown as RemoteAsset[] : [];
      if (!this.#acceptSnapshot(record, assets)) {
        record.state = previousState;
        return;
      }
      for (const asset of assets) {
        record.remoteAssetsCache.set(String(asset.id), asset);
      }
      record.syncPhase = "reconciling";
      record.syncProgress = {
        completed: 0,
        total: assets.filter((asset) => asset.type !== "folder" && (asset.file || DATA_JSON_TYPES.has(asset.type))).length,
        assetId: null,
        action: "comparing",
      };

      const processedAssets = await this.#preProcessLocalRenamesAndDeletes(record, assets);
      await this.#applySnapshot(record, processedAssets, force);
      await this.#uploadUnindexedFiles(record);

      const activeScene = data.activeScene && typeof data.activeScene === "object" && !Array.isArray(data.activeScene)
        ? data.activeScene as unknown as RemoteScenePayload
        : null;
      const sceneList = Array.isArray(data.scenes)
        ? data.scenes as unknown as RemoteSceneSummary[]
        : null;
      if (activeScene || sceneList) {
        await this.#reconcileAllScenes(record, activeScene, sceneList);
      }

      record.lastSyncedAt = new Date().toISOString();
      this.#recomputeOverallState(record);
      record.syncPhase = "persisting";
      await this.#persist(record);
    } catch (error) {
      record.state = "error";
      record.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      record.syncStartedAt = null;
      record.syncPhase = null;
      record.syncProgress = null;
    }
  }

  async #performRemoteDeltas(record: ProjectRecord, deltas: WorkspaceDelta[]): Promise<void> {
    try {
      const removedIds = new Set<string>();
      const upsertedById = new Map<string, RemoteAsset>();
      let fullActiveScene: RemoteScenePayload | null = null;
      const sceneDeltas: WorkspaceSceneDelta[] = [];

      for (const delta of deltas) {
        for (const rawId of delta.removedAssetIds || []) {
          const id = String(rawId);
          removedIds.add(id);
          upsertedById.delete(id);
        }
        for (const asset of delta.upsertedAssets || []) {
          const id = String(asset.id);
          removedIds.delete(id);
          upsertedById.set(id, asset);
          record.remoteAssetsCache.set(id, asset);
        }
        if (delta.activeScene) {
          fullActiveScene = delta.activeScene;
          sceneDeltas.length = 0;
        } else if (delta.sceneDelta) {
          sceneDeltas.push(delta.sceneDelta);
        }
      }

      let changed = false;

      if (removedIds.size > 0) {
        const deletionBatch = new Date().toISOString().replaceAll(":", "-");
        for (const id of removedIds) {
          record.remoteAssetsCache.delete(id);
          const old = record.index.entries[id];
          if (!old) continue;
          changed = true;
          await this.#quarantineRemoteDeletedEntry(record, id, old, deletionBatch);
          await this.#deleteAssetBaseline(record, id);
          delete record.index.entries[id];
          if (old.type === "folder" && old.localFolderPath.length) {
            await rmdir(this.#assetPath(record, join(...old.localFolderPath))).catch(() => undefined);
          }
        }
      }

      if (upsertedById.size > 0) {
        changed = true;
        // Rebuild lightweight asset list from memory cache + current index so folder/collision paths stay exact without any RPC.
        const currentAssets: RemoteAsset[] = [];
        const allKnownIds = new Set([
          ...Object.keys(record.index.entries),
          ...upsertedById.keys(),
        ]);
        for (const id of allKnownIds) {
          if (removedIds.has(id)) continue;
          const cached = upsertedById.get(id) || record.remoteAssetsCache.get(id);
          if (cached) {
            currentAssets.push(cached);
          } else {
            const existing = record.index.entries[id];
            if (existing) {
              currentAssets.push({
                id: existing.id,
                name: existing.name,
                type: existing.type,
                source: existing.role === "source",
                source_asset_id: existing.sourceAssetId,
                file: existing.filename
                  ? {
                      filename: existing.filename,
                      hash: existing.advertisedRemoteFileHash || undefined,
                      size: existing.advertisedRemoteFileSize ?? undefined,
                    }
                  : null,
              });
            }
          }
        }
        await this.#applySnapshot(record, currentAssets, false, new Set(upsertedById.keys()));
      }

      if (fullActiveScene) {
        changed = true;
        record.activeSceneMemory = structuredClone(fullActiveScene);
        await this.#reconcileActiveScene(record, fullActiveScene);
      } else if (sceneDeltas.length > 0) {
        for (const sd of sceneDeltas) {
          const sceneId = String(sd.sceneId);
          if (!record.activeSceneMemory || String(record.activeSceneMemory.id) !== sceneId) {
            const readResp = await this.#requestTarget(record.targetId, "bridge:readScene", { sceneId }, 30000);
            if (readResp.ok) {
              record.activeSceneMemory = asObject(readResp.data) as unknown as RemoteScenePayload;
            }
          }
          if (record.activeSceneMemory && String(record.activeSceneMemory.id) === sceneId) {
            changed = true;
            if (sd.sceneName) record.activeSceneMemory.name = sd.sceneName;
            if (sd.settings) record.activeSceneMemory.settings = structuredClone(sd.settings);
            const entities = (record.activeSceneMemory.entities || {}) as Record<string, unknown>;
            for (const remId of sd.removedEntityIds || []) {
              delete entities[String(remId)];
            }
            for (const [entId, entVal] of Object.entries(sd.upsertedEntities || {})) {
              entities[entId] = structuredClone(entVal);
            }
            record.activeSceneMemory.entities = entities;
          }
        }
        if (record.activeSceneMemory) {
          await this.#reconcileActiveScene(record, record.activeSceneMemory);
        }
      }

      if (changed) {
        record.lastSyncedAt = new Date().toISOString();
        this.#recomputeOverallState(record);
        await this.#persist(record);
      }
    } catch (error) {
      record.state = "error";
      record.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async #performLocalSceneChanges(record: ProjectRecord, dirtyPaths: string[]): Promise<void> {
    const actionable: string[] = [];
    for (const rel of dirtyPaths) {
      const abs = this.#scenePath(record, rel);
      if (await this.#isSelfWriteEcho(record, abs)) continue;
      actionable.push(rel);
    }
    if (!actionable.length) return;

    try {
      let changed = false;
      for (const rel of actionable) {
        const parsedName = parseSceneFilename(basename(rel));
        const matchedEntry = Object.values(record.scenes).find(
          (item) => toPosixPath(item.localPath) === rel || (parsedName && item.id === parsedName.sceneId),
        );
        if (!matchedEntry) continue;
        const abs = this.#scenePath(record, matchedEntry.localPath);
        if (!existsSync(abs)) {
          // Restore accidentally deleted scene mirror from baseline.
          const baseline = await this.#loadSceneBaseline(record, matchedEntry.id);
          if (baseline) {
            const restored = buildSceneProjection({
              id: matchedEntry.id,
              name: baseline.name,
              active: matchedEntry.active,
              settings: baseline.settings,
              entities: baseline.entities,
            });
            await this.#writeManagedSceneFile(record, matchedEntry, Buffer.from(restored.text, "utf8"), hashContent(restored.text));
            changed = true;
          }
          continue;
        }
        if (!matchedEntry.active || !matchedEntry.writable) {
          await this.#quarantineInactiveSceneEdit(record, matchedEntry, abs);
          changed = true;
          continue;
        }
        const readResp = await this.#requestTarget(
          record.targetId,
          "bridge:readScene",
          { sceneId: matchedEntry.id },
          30000,
        );
        if (!readResp.ok) throw new Error(readResp.error.message);
        const liveRemote = asObject(readResp.data) as unknown as RemoteScenePayload;
        record.activeSceneMemory = structuredClone(liveRemote);
        await this.#reconcileActiveScene(record, liveRemote);
        changed = true;
      }
      if (changed) {
        record.lastSyncedAt = new Date().toISOString();
        this.#recomputeOverallState(record);
        await this.#persist(record);
      }
    } catch (error) {
      record.state = "error";
      record.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async #performLocalAssetChanges(record: ProjectRecord, dirtyPaths: string[]): Promise<void> {
    const genuinePaths: string[] = [];
    for (const rel of dirtyPaths) {
      let abs: string;
      try {
        abs = this.#assetPath(record, rel);
      } catch {
        continue;
      }
      if (await this.#isSelfWriteEcho(record, abs)) continue;
      genuinePaths.push(rel);
    }
    if (!genuinePaths.length) return;

    // Check if every dirty path maps cleanly to an existing, still-present indexed writable asset.
    // If any path disappeared or is unindexed (possible rename, move, deletion, or new file), run full reconciliation.
    const byLocalPath = new Map<string, AssetIndexEntry>();
    for (const entry of Object.values(record.index.entries)) {
      if (entry.localPath) byLocalPath.set(toPosixPath(entry.localPath), entry);
    }

    const targetedEntries: AssetIndexEntry[] = [];
    for (const rel of genuinePaths) {
      const entry = byLocalPath.get(rel);
      const abs = this.#assetPath(record, rel);
      if (!entry || !entry.writable || !existsSync(abs)) {
        await this.#performFullSync(record, false);
        return;
      }
      targetedEntries.push(entry);
    }

    try {
      for (const entry of targetedEntries) {
        const old = { ...entry };
        if (DATA_JSON_TYPES.has(entry.type) && !entry.filename) {
          const cachedRemote = record.remoteAssetsCache.get(entry.id);
          await this.#reconcileJsonAsset(record, entry, old, cachedRemote);
        } else if (TEXT_FILE_TYPES.has(entry.type)) {
          await this.#reconcileTextAsset(record, entry, old, true);
        } else {
          await this.#reconcileBinary(record, entry, old);
        }
      }
      record.lastSyncedAt = new Date().toISOString();
      this.#recomputeOverallState(record);
      await this.#persist(record);
    } catch (error) {
      record.state = "error";
      record.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async #quarantineRemoteDeletedEntry(
    record: ProjectRecord,
    id: string,
    old: AssetIndexEntry,
    deletionBatch: string,
  ): Promise<void> {
    const deletedPaths = [
      old.localPath,
      ...Object.values(old.resources).map((resource) => resource.localPath),
    ].filter((path): path is string => Boolean(path));
    for (const deletedPath of deletedPaths) {
      if (!existsSync(this.#assetPath(record, deletedPath))) continue;
      const source = this.#assetPath(record, deletedPath);
      await chmod(source, 0o644).catch(() => undefined);
      const destination = join(
        record.tmpDirectory,
        "trash",
        "remote",
        deletionBatch,
        `${id}-${safeWorkspaceName(basename(deletedPath), `asset-${id}`)}`,
      );
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
      this.#markSelfDeleted(record, source);
    }
  }

  async #backupLocalDeletedEntry(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    deletionBatch: string,
  ): Promise<void> {
    const filename = basename(entry.localPath || entry.filename || entry.name || `asset-${entry.id}`);
    const destination = join(
      record.tmpDirectory,
      "trash",
      "local",
      deletionBatch,
      `${entry.id}-${safeWorkspaceName(filename, `asset-${entry.id}`)}`,
    );
    if (DATA_JSON_TYPES.has(entry.type)) {
      const baseline = await this.#loadAssetBaseline(record, entry.id);
      if (baseline) {
        const proj = buildAssetProjection({
          id: entry.id,
          name: baseline.name,
          type: entry.type,
          preload: baseline.preload,
          tags: baseline.tags,
          data: baseline.data,
          role: entry.role,
          sourceAssetId: entry.sourceAssetId,
          writable: entry.writable,
        });
        await atomicWrite(destination, proj.text);
      }
      return;
    }
    const cached = await this.#cachedObject(record, entry, entry.lastSyncedHash || entry.localHash || entry.remoteFileHash);
    if (cached) {
      await atomicWrite(destination, cached.content);
    }
  }

  async #scanUnindexedFiles(record: ProjectRecord, knownPaths: Set<string>): Promise<string[]> {
    const files: string[] = [];
    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        if (child.name.startsWith(".") || child.name === "tmp") continue;
        const relativePath = relativeDirectory ? join(relativeDirectory, child.name) : child.name;
        const path = join(directory, child.name);
        if (child.isDirectory()) await visit(path, relativePath);
        else if (child.isFile() && !knownPaths.has(toPosixPath(relativePath))) files.push(relativePath);
      }
    };
    await visit(record.assetsDirectory, "");
    return files;
  }

  async #preProcessLocalRenamesAndDeletes(
    record: ProjectRecord,
    incomingAssets: RemoteAsset[],
  ): Promise<RemoteAsset[]> {
    const previous = record.index.entries;
    const incomingById = new Map(incomingAssets.map((asset) => [String(asset.id), asset]));

    // Build expected folder map so we don't confuse a remote rename/move with a local deletion.
    const missingEntries = new Map<string, AssetIndexEntry>();
    for (const [id, old] of Object.entries(previous)) {
      if (!old.writable || old.type === "folder" || !old.downloaded || !old.localPath) continue;
      if (!incomingById.has(id)) continue;
      const oldAbs = this.#assetPath(record, old.localPath);
      if (!existsSync(oldAbs)) {
        missingEntries.set(id, old);
      }
    }

    if (!missingEntries.size) return incomingAssets;

    const known = new Set(
      Object.values(previous)
        .flatMap((entry) => [
          entry.localPath ? toPosixPath(entry.localPath) : null,
          ...Object.values(entry.resources).map((resource) => toPosixPath(resource.localPath)),
        ])
        .filter((item): item is string => Boolean(item)),
    );
    const unindexedFiles = await this.#scanUnindexedFiles(record, known);
    let needsRefresh = false;

    for (const relativePath of unindexedFiles) {
      if (!missingEntries.size) break;
      const absPath = this.#assetPath(record, relativePath);
      let fileInfo;
      let content: Buffer;
      try {
        fileInfo = await stat(absPath);
        content = await readFile(absPath);
      } catch {
        continue;
      }
      const contentHash = hashContent(content);
      const parts = relativePath.split(/[\\/]/g);
      const rawFilename = parts.pop() || "asset.bin";
      const cleanFilename = stripCollisionTag(rawFilename);
      const folder = parts.map(stripCollisionTag).join("/");
      const parsedDataFile = parseDataAssetFilename(cleanFilename);

      let matched: AssetIndexEntry | undefined;

      // 1. Exact match by embedded $pcbridge.id for structured JSON assets.
      if (parsedDataFile) {
        try {
          const parsed = parseAssetProjection(content.toString("utf8"), {
            name: parsedDataFile.stem,
            type: parsedDataFile.type,
          });
          if (parsed.embeddedId && missingEntries.has(parsed.embeddedId)) {
            matched = missingEntries.get(parsed.embeddedId);
          }
        } catch {
          // Fall through to inode/hash matching.
        }
      }

      // 2. POSIX (dev, ino) inode match (handles mv + simultaneous content edit!).
      if (!matched && fileInfo.ino > 0) {
        for (const candidate of missingEntries.values()) {
          if (
            candidate.localIno !== undefined &&
            candidate.localIno > 0 &&
            candidate.localIno === fileInfo.ino &&
            (candidate.localDev === undefined || candidate.localDev === fileInfo.dev)
          ) {
            matched = candidate;
            break;
          }
        }
      }

      // 3. Content hash match (handles copy + unlink style renames).
      if (!matched) {
        for (const candidate of missingEntries.values()) {
          if (candidate.localHash && candidate.localHash === contentHash) {
            matched = candidate;
            break;
          }
        }
      }

      if (!matched) continue;

      const remoteName = parsedDataFile ? parsedDataFile.stem : cleanFilename;
      const renameResponse = await this.#requestTarget(
        record.targetId,
        "bridge:renameAsset",
        {
          assetId: matched.id,
          name: remoteName,
          filename: cleanFilename,
          folder,
        },
        60000,
      );
      if (renameResponse.ok) {
        missingEntries.delete(matched.id);
        matched.localPath = relativePath;
        matched.name = remoteName;
        matched.localFolderPath = parts;
        matched.remotePath = parts.map(stripCollisionTag);
        const remoteAsset = incomingById.get(matched.id);
        if (remoteAsset) {
          remoteAsset.name = remoteName;
        }
        needsRefresh = true;
      }
    }

    // Any remaining missing Tier 1 eager writable assets were genuinely deleted locally -> delete remotely too.
    const tier1Deleted: AssetIndexEntry[] = [];
    for (const candidate of missingEntries.values()) {
      if (this.#isTier1EagerWritable(candidate)) {
        tier1Deleted.push(candidate);
      }
    }

    if (tier1Deleted.length > 0) {
      const deletionBatch = new Date().toISOString().replaceAll(":", "-");
      for (const entry of tier1Deleted) {
        await this.#backupLocalDeletedEntry(record, entry, deletionBatch);
      }
      const deleteResp = await this.#requestTarget(
        record.targetId,
        "bridge:deleteAssets",
        { assetIds: tier1Deleted.map((entry) => entry.id) },
        60000,
      );
      if (deleteResp.ok) {
        const deletedSet = new Set(tier1Deleted.map((entry) => entry.id));
        for (const id of deletedSet) {
          record.remoteAssetsCache.delete(id);
          await this.#deleteAssetBaseline(record, id);
          delete record.index.entries[id];
          incomingById.delete(id);
        }
      } else {
        record.lastWarning = `Failed to delete remote asset(s): ${deleteResp.error.message}`;
      }
    }

    if (needsRefresh) {
      const refresh = await this.#requestTarget(record.targetId, "bridge:workspaceSnapshot", {}, 60000);
      if (refresh.ok) {
        const snapshot = asObject(refresh.data);
        const refreshed = Array.isArray(snapshot.assets) ? snapshot.assets as unknown as RemoteAsset[] : [];
        if (refreshed.length) {
          for (const asset of refreshed) record.remoteAssetsCache.set(String(asset.id), asset);
          return refreshed;
        }
      }
    }

    return [...incomingById.values()];
  }

  async #uploadUnindexedFiles(record: ProjectRecord): Promise<void> {
    const known = new Set(
      Object.values(record.index.entries)
        .flatMap((entry) => [
          entry.localPath ? toPosixPath(entry.localPath) : null,
          ...Object.values(entry.resources).map((resource) => toPosixPath(resource.localPath)),
        ])
        .filter((item): item is string => Boolean(item)),
    );
    const files = await this.#scanUnindexedFiles(record, known);
    if (!files.length) return;

    let uploadedAny = false;
    for (const relativePath of files) {
      const path = this.#assetPath(record, relativePath);
      const content = await readFile(path);
      const contentHash = hashContent(content);
      const parts = relativePath.split(/[\\/]/g);
      const filename = parts.pop() || "asset.bin";
      const folder = parts.map(stripCollisionTag).join("/");

      const derived = Object.values(record.index.entries).find((entry) =>
        entry.role === "derived" &&
        !entry.writable &&
        (entry.localHash === contentHash || entry.lastSyncedHash === contentHash),
      );
      if (derived) {
        const conflictPath = join(
          record.tmpDirectory,
          "conflicts",
          `${derived.id}-${safeWorkspaceName(filename, `asset-${derived.id}`)}.derived-local`,
        );
        await mkdir(dirname(conflictPath), { recursive: true });
        await chmod(path, 0o644).catch(() => undefined);
        await rename(path, conflictPath);
        record.lastWarning =
          `Ignored a moved or copied projection of derived Asset ${derived.id}; ` +
          `the local copy was saved to ${relative(record.directory, conflictPath)}.`;
        continue;
      }

      const parsedDataFile = parseDataAssetFilename(filename);
      if (parsedDataFile) {
        let parsed;
        try {
          parsed = parseAssetProjection(content.toString("utf8"), {
            name: parsedDataFile.stem,
            type: parsedDataFile.type,
          });
        } catch (error) {
          record.lastWarning = `Invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`;
          continue;
        }
        const createResp = await this.#requestTarget(
          record.targetId,
          "bridge:createDataAsset",
          {
            name: parsed.doc.name || parsedDataFile.stem,
            type: parsed.embeddedType,
            folder,
            preload: parsed.doc.preload,
            tags: parsed.doc.tags,
            data: parsed.doc.data,
          },
          60000,
        );
        if (!createResp.ok) {
          record.lastWarning = `Failed to create structured asset ${relativePath}: ${createResp.error.message}`;
          continue;
        }
        const createdObj = asObject(createResp.data).asset;
        if (createdObj && typeof createdObj === "object" && !Array.isArray(createdObj)) {
          const remoteCreated = createdObj as unknown as RemoteAsset;
          const newId = String(remoteCreated.id);
          record.remoteAssetsCache.set(newId, remoteCreated);
          const projection = buildAssetProjection({
            id: newId,
            name: remoteCreated.name || parsed.doc.name,
            type: remoteCreated.type || parsed.embeddedType,
            preload: remoteCreated.preload ?? parsed.doc.preload,
            tags: remoteCreated.tags ?? parsed.doc.tags,
            data: remoteCreated.data ?? parsed.doc.data,
            role: "standalone",
            sourceAssetId: null,
            writable: true,
          });
          const projBytes = Buffer.from(projection.text, "utf8");
          const projHash = hashContent(projBytes);
          await this.#writeRawSelfManaged(record, path, projBytes, projHash, true);
          await this.#saveAssetBaseline(record, newId, projection.doc);
          uploadedAny = true;
        }
        continue;
      }

      const response = await this.#requestTarget(
        record.targetId,
        "bridge:uploadAsset",
        {
          name: filename,
          filename,
          folder,
          base64: content.toString("base64"),
        },
        120000,
      );
      if (!response.ok) {
        record.lastWarning = `Failed to upload local file ${relativePath}: ${response.error.message}`;
        continue;
      }
      const data = asObject(response.data);
      if (data.asset && typeof data.asset === "object" && !Array.isArray(data.asset)) {
        const uploadedAsset = data.asset as unknown as RemoteAsset;
        record.remoteAssetsCache.set(String(uploadedAsset.id), uploadedAsset);
        uploadedAny = true;
      }
    }

    if (uploadedAny) {
      const refresh = await this.#requestTarget(record.targetId, "bridge:workspaceSnapshot", {}, 60000);
      if (refresh.ok) {
        const snapshot = asObject(refresh.data);
        const refreshedAssets = Array.isArray(snapshot.assets)
          ? snapshot.assets as unknown as RemoteAsset[]
          : [];
        if (refreshedAssets.length) {
          for (const asset of refreshedAssets) record.remoteAssetsCache.set(String(asset.id), asset);
          await this.#applySnapshot(record, refreshedAssets, false);
        }
      }
    }
  }

  #acceptSnapshot(record: ProjectRecord, assets: RemoteAsset[]): boolean {
    const previousIds = Object.keys(record.index.entries);
    if (!previousIds.length) {
      record.pendingShrinkDigest = null;
      record.pendingShrinkCount = 0;
      return true;
    }
    const incomingIds = new Set(assets.map((asset) => String(asset.id)));
    const missing = previousIds.filter((id) => !incomingIds.has(id));
    if (!missing.length) {
      record.pendingShrinkDigest = null;
      record.pendingShrinkCount = 0;
      return true;
    }
    if (!assets.length) {
      record.pendingShrinkDigest = null;
      record.pendingShrinkCount = 0;
      record.lastWarning =
        `Ignored an empty PlayCanvas asset snapshot while ${previousIds.length} indexed assets ` +
        "are present. Waiting for the Editor asset store to finish loading.";
      return false;
    }

    const digest = hashContent([...incomingIds].sort().join("\n"));
    if (record.pendingShrinkDigest === digest) record.pendingShrinkCount += 1;
    else {
      record.pendingShrinkDigest = digest;
      record.pendingShrinkCount = 1;
    }
    if (record.pendingShrinkCount < 2) {
      record.lastWarning =
        `Deferred ${missing.length} possible remote deletion${missing.length === 1 ? "" : "s"}; ` +
        "the same non-empty asset snapshot must be observed twice.";
      return false;
    }
    record.pendingShrinkDigest = null;
    record.pendingShrinkCount = 0;
    return true;
  }

  async #applySnapshot(
    record: ProjectRecord,
    assets: RemoteAsset[],
    force: boolean,
    onlyReconcileIds?: Set<string>,
  ): Promise<void> {
    const previous = record.index.entries;
    const incomingIds = new Set(assets.map((asset) => String(asset.id)));
    const folderAssets = assets
      .filter((asset) => asset.type === "folder")
      .sort((left, right) => {
        const depthDifference = (left.path?.length || 0) - (right.path?.length || 0);
        if (depthDifference) return depthDifference;
        return String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
      });
    const localFolderPaths = new Map<string, string[]>();
    const remoteFolderPaths = new Map<string, string[]>();
    const usedNames = new Map<string, Set<string>>();

    for (const entry of Object.values(previous)) {
      if (!incomingIds.has(entry.id)) continue;
      for (const resource of Object.values(entry.resources)) {
        const parentKey = pathNameKey(localFolderParts(resource.localPath).join("/"));
        const used = usedNames.get(parentKey) || new Set<string>();
        used.add(pathNameKey(basename(resource.localPath)));
        usedNames.set(parentKey, used);
      }
    }

    const allocateName = (parent: string[], rawName: string, type: string, id: string) => {
      const parentKey = pathNameKey(parent.join("/"));
      const used = usedNames.get(parentKey) || new Set<string>();
      const safe = safeAssetName(rawName, `asset-${id}`);
      const key = pathNameKey(safe);
      let selected = used.has(key) ? collisionName(safe, type, id) : safe;
      let suffix = 2;
      while (used.has(pathNameKey(selected))) {
        selected = collisionName(safe, type, `${id}_${suffix}`);
        suffix += 1;
      }
      used.add(pathNameKey(selected));
      usedNames.set(parentKey, used);
      return selected;
    };

    for (const folder of folderAssets) {
      const parentIds = (folder.path || []).map(String);
      const localParent = parentIds.length
        ? localFolderPaths.get(parentIds[parentIds.length - 1]) || []
        : [];
      const remoteParent = parentIds.length
        ? remoteFolderPaths.get(parentIds[parentIds.length - 1]) || []
        : [];
      const localName = allocateName(localParent, folder.name, "folder", String(folder.id));
      const localPath = [...localParent, localName];
      localFolderPaths.set(String(folder.id), localPath);
      remoteFolderPaths.set(String(folder.id), [...remoteParent, folder.name]);
      const folderAbs = this.#assetPath(record, join(...localPath));
      if (!existsSync(folderAbs)) {
        await mkdir(folderAbs, { recursive: true });
      }
    }

    const next: Record<string, AssetIndexEntry> = {};
    const roleOrder: Record<AssetRole, number> = { source: 0, standalone: 1, derived: 2 };
    const orderedAssets = [...assets].sort((left, right) => {
      const roleDifference = roleOrder[assetRole(left)] - roleOrder[assetRole(right)];
      if (roleDifference) return roleDifference;
      return String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
    });

    for (const asset of orderedAssets) {
      const id = String(asset.id);
      const parentIds = (asset.path || []).map(String);
      const localParent = parentIds.length
        ? localFolderPaths.get(parentIds[parentIds.length - 1]) || []
        : [];
      const remoteParent = parentIds.length
        ? remoteFolderPaths.get(parentIds[parentIds.length - 1]) || []
        : [];
      if (asset.type === "folder") {
        next[id] = {
          id,
          name: asset.name,
          type: asset.type,
          role: "standalone",
          sourceAssetId: null,
          writable: false,
          remotePath: remoteFolderPaths.get(id) || [...remoteParent, asset.name],
          localFolderPath: localFolderPaths.get(id) || localParent,
          localPath: null,
          filename: null,
          advertisedRemoteFileSize: null,
          advertisedRemoteFileHash: null,
          observedRemoteFileSize: null,
          observedRemoteFileHash: null,
          remoteFileSize: null,
          remoteFileHash: null,
          localHash: null,
          lastSyncedHash: null,
          resources: {},
          downloaded: false,
          status: "indexed",
        };
        continue;
      }

      const role = assetRole(asset);
      const derived = role === "derived";
      const sourceAssetId = derived ? String(asset.source_asset_id) : null;
      const remoteFilename = asset.file?.filename || (TEXT_FILE_TYPES.has(asset.type) ? asset.name : null);
      const isEditableDataJson = DATA_JSON_TYPES.has(asset.type) && !remoteFilename;
      const localFilename = desiredLocalFilename(asset, role);
      const localName = localFilename ? allocateName(localParent, localFilename, asset.type, id) : null;
      const localPath = localName ? join(...localParent, localName) : null;
      const old = previous[id];
      const advertisedRemoteFileSize = asset.file?.size ?? null;
      const advertisedRemoteFileHash = asset.file?.hash || null;
      const metadataUnchanged = old?.advertisedRemoteFileHash === advertisedRemoteFileHash &&
        old?.advertisedRemoteFileSize === advertisedRemoteFileSize;
      const observedRemoteFileSize = metadataUnchanged ? old?.observedRemoteFileSize ?? null : null;
      const observedRemoteFileHash = metadataUnchanged && typeof old?.observedRemoteFileHash === "string"
        ? old.observedRemoteFileHash
        : null;
      const entry: AssetIndexEntry = {
        id,
        name: asset.name,
        type: asset.type,
        role,
        sourceAssetId,
        writable: isEditableDataJson ? true : !derived,
        preload: asset.preload ?? old?.preload,
        tags: asset.tags ?? old?.tags,
        meta: asset.meta ?? old?.meta ?? null,
        remotePath: remoteParent,
        localFolderPath: localParent,
        localPath,
        filename: remoteFilename,
        advertisedRemoteFileSize,
        advertisedRemoteFileHash,
        observedRemoteFileSize,
        observedRemoteFileHash,
        remoteFileSize: observedRemoteFileSize ?? advertisedRemoteFileSize ??
          (DATA_JSON_TYPES.has(asset.type) ? old?.remoteFileSize ?? null : null),
        remoteFileHash: observedRemoteFileHash || advertisedRemoteFileHash ||
          (DATA_JSON_TYPES.has(asset.type) ? old?.remoteFileHash ?? null : null),
        localHash: old?.localHash || null,
        lastSyncedHash: old?.lastSyncedHash || null,
        legacyLastSyncedSha256: old?.legacyLastSyncedSha256,
        pendingRemoteHash: old?.pendingRemoteHash,
        localFileSize: old?.localFileSize,
        localMtimeMs: old?.localMtimeMs,
        localIno: old?.localIno,
        localDev: old?.localDev,
        resources: old?.resources || {},
        downloaded: old?.downloaded || false,
        status: old?.status || "indexed",
        error: old?.error,
      };
      next[id] = entry;

      const pathChanged = Boolean(old?.localPath && localPath && old.localPath !== localPath);
      if (pathChanged && old?.localPath && localPath && existsSync(this.#assetPath(record, old.localPath))) {
        const oldPath = this.#assetPath(record, old.localPath);
        const newPath = this.#assetPath(record, localPath);
        await mkdir(dirname(newPath), { recursive: true });
        if (!existsSync(newPath)) {
          await rename(oldPath, newPath);
          const fp = record.recentSelfWrites.get(oldPath);
          this.#markSelfDeleted(record, oldPath);
          if (fp) {
            record.recentSelfWrites.set(newPath, fp);
          } else if (entry.localHash) {
            const movedStat = await stat(newPath).catch(() => null);
            if (movedStat) {
              record.recentSelfWrites.set(newPath, {
                size: movedStat.size,
                mtimeMs: movedStat.mtimeMs,
                hash: entry.localHash,
                expiresAt: Date.now() + SELF_WRITE_TTL_MS,
              });
            }
          }
        }
      }

      if (onlyReconcileIds && !onlyReconcileIds.has(id) && !pathChanged) {
        continue;
      }

      if ((asset.file || DATA_JSON_TYPES.has(asset.type)) && record.syncProgress) {
        record.syncProgress.assetId = id;
        record.syncProgress.action = "comparing";
      }

      if (DATA_JSON_TYPES.has(asset.type) && !entry.filename && localPath) {
        await this.#reconcileJsonAsset(record, entry, old, asset);
      } else if (derived && localPath) {
        await this.#reconcileDerived(record, entry, old);
        if (existsSync(this.#assetPath(record, localPath))) {
          await ensureFileMode(this.#assetPath(record, localPath), false);
        }
      } else if (TEXT_FILE_TYPES.has(asset.type) && localPath) {
        const abs = this.#assetPath(record, localPath);
        const tier = this.#syncTierForAsset(entry);
        if (tier === "lazy-text" && !existsSync(abs)) {
          entry.downloaded = false;
          entry.status = "indexed";
          delete entry.error;
        } else {
          if (existsSync(abs)) await ensureFileMode(abs, true);
          await this.#reconcileTextAsset(record, entry, old, force);
        }
      } else if (localPath) {
        const abs = this.#assetPath(record, localPath);
        if (existsSync(abs)) await ensureFileMode(abs, true);
        await this.#reconcileBinary(record, entry, old);
      }

      if ((asset.file || DATA_JSON_TYPES.has(asset.type)) && record.syncProgress) {
        record.syncProgress.completed += 1;
      }
    }

    const deletionBatch = new Date().toISOString().replaceAll(":", "-");
    for (const [id, old] of Object.entries(previous)) {
      if (next[id]) continue;
      await this.#quarantineRemoteDeletedEntry(record, id, old, deletionBatch);
      await this.#deleteAssetBaseline(record, id);
    }

    const obsoleteFolders = Object.entries(previous)
      .filter(([id, old]) =>
        old.type === "folder" &&
        (!next[id] || next[id].localFolderPath.join("/") !== old.localFolderPath.join("/")),
      )
      .map(([, old]) => old.localFolderPath)
      .sort((left, right) => right.length - left.length);
    for (const folder of obsoleteFolders) {
      if (!folder.length) continue;
      await rmdir(this.#assetPath(record, join(...folder))).catch(() => undefined);
    }

    record.index = {
      schemaVersion: 3,
      projectId: record.projectId,
      branchId: record.branchId,
      updatedAt: new Date().toISOString(),
      entries: next,
    };
  }

  async #localFileSnapshot(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old?: AssetIndexEntry,
  ): Promise<{ hash: string; size: number; mtimeMs: number; ino: number; dev: number } | null> {
    if (!entry.localPath) return null;
    const path = this.#assetPath(record, entry.localPath);
    if (!existsSync(path)) return null;
    const info = await stat(path);
    const cachedHash = old?.localHash &&
      old.localFileSize === info.size &&
      old.localMtimeMs === info.mtimeMs
      ? old.localHash
      : null;
    return {
      hash: cachedHash || hashContent(await readFile(path)),
      size: info.size,
      mtimeMs: info.mtimeMs,
      ino: info.ino,
      dev: info.dev,
    };
  }

  async #recordLocalFile(record: ProjectRecord, entry: AssetIndexEntry, hash: string): Promise<void> {
    if (!entry.localPath) return;
    const absPath = this.#assetPath(record, entry.localPath);
    const info = await stat(absPath);
    entry.localHash = hash;
    entry.localFileSize = info.size;
    entry.localMtimeMs = info.mtimeMs;
    entry.localIno = info.ino;
    entry.localDev = info.dev;
    entry.downloaded = true;
  }

  async #writeRawSelfManaged(
    record: ProjectRecord,
    absPath: string,
    content: Buffer | string,
    hash: string,
    writable: boolean,
  ): Promise<void> {
    if (existsSync(absPath)) await ensureFileMode(absPath, true);
    await atomicWrite(absPath, content);
    await ensureFileMode(absPath, writable);
    const info = await stat(absPath);
    record.recentSelfWrites.set(absPath, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      hash,
      expiresAt: Date.now() + SELF_WRITE_TTL_MS,
    });
  }

  async #writeManagedAssetFile(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    content: Buffer | string,
    hash: string,
  ): Promise<string> {
    if (!entry.localPath) throw new Error(`Asset ${entry.id} has no local projection path.`);
    const path = this.#assetPath(record, entry.localPath);
    await this.#writeRawSelfManaged(record, path, content, hash, entry.writable);
    await this.#recordLocalFile(record, entry, hash);
    return path;
  }

  async #writeManagedSceneFile(
    record: ProjectRecord,
    scene: SceneIndexEntry,
    content: Buffer,
    hash: string,
  ): Promise<string> {
    await mkdir(record.scenesDirectory, { recursive: true });
    this.#ensureScenesWatcher(record);
    const path = this.#scenePath(record, scene.localPath);
    await this.#writeRawSelfManaged(record, path, content, hash, scene.writable);
    const info = await stat(path);
    scene.localHash = hash;
    scene.localFileSize = info.size;
    scene.localMtimeMs = info.mtimeMs;
    return path;
  }

  #objectPath(record: ProjectRecord, entry: AssetIndexEntry, hash: string): string {
    const path = this.#withinRoot(join(
      record.objectsDirectory,
      safeAssetName(entry.id, "asset"),
      safeAssetName(hash, "unknown"),
      safeAssetName(entry.filename || basename(entry.localPath || "") || entry.name, "file.bin"),
    ));
    if (path !== record.objectsDirectory && !path.startsWith(`${record.objectsDirectory}${sep}`)) {
      throw new Error(`Object path escapes workspace cache: ${path}`);
    }
    return path;
  }

  async #cachedObject(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    hash: string | null,
  ): Promise<{ path: string; content: Buffer; hash: string } | null> {
    if (!hash) return null;
    const path = this.#objectPath(record, entry, hash);
    if (!existsSync(path)) return null;
    const content = await readFile(path);
    if (hashContent(content) !== hash) return null;
    return { path, content, hash };
  }

  async #storeObject(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    content: Buffer,
    hash: string,
  ): Promise<string> {
    const existing = await this.#cachedObject(record, entry, hash);
    if (existing) return existing.path;
    const path = this.#objectPath(record, entry, hash);
    await atomicWrite(path, content);
    return path;
  }

  #resourceObjectPath(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    resource: AssetResourceEntry,
    hash: string,
  ): string {
    const path = this.#withinRoot(join(
      record.objectsDirectory,
      safeAssetName(entry.id, "asset"),
      safeAssetName(hash, "unknown"),
      safeAssetName(resource.filename, "resource.bin"),
    ));
    if (path !== record.objectsDirectory && !path.startsWith(`${record.objectsDirectory}${sep}`)) {
      throw new Error(`Resource object path escapes workspace cache: ${path}`);
    }
    return path;
  }

  async #cachedResourceObject(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    resource: AssetResourceEntry,
    hash: string | null,
  ): Promise<{ content: Buffer; hash: string } | null> {
    if (!hash) return null;
    const path = this.#resourceObjectPath(record, entry, resource, hash);
    if (!existsSync(path)) return null;
    const content = await readFile(path);
    if (hashContent(content) !== hash) return null;
    return { content, hash };
  }

  async #storeResourceObject(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    resource: AssetResourceEntry,
    content: Buffer,
    hash: string,
  ): Promise<void> {
    const cached = await this.#cachedResourceObject(record, entry, resource, hash);
    if (cached) return;
    await atomicWrite(this.#resourceObjectPath(record, entry, resource, hash), content);
  }

  async #materializeResource(
    record: ProjectRecord,
    resource: AssetResourceEntry,
    content: Buffer,
    hash: string,
  ): Promise<string> {
    const path = this.#assetPath(record, resource.localPath);
    await this.#writeRawSelfManaged(record, path, content, hash, false);
    resource.localHash = hash;
    resource.remoteFileSize = content.byteLength;
    return path;
  }

  #legacyCachedFilePath(record: ProjectRecord, assetId: string, filename: string): string {
    return this.#withinRoot(join(
      record.tmpDirectory,
      "cache",
      "assets",
      safeAssetName(assetId, "asset"),
      safeAssetName(filename, "resource.bin"),
    ));
  }

  #legacyResourcePath(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    resource: AssetResourceEntry,
  ): string {
    return this.#legacyCachedFilePath(record, entry.id, resource.filename);
  }

  async #removeLegacyResource(path: string): Promise<void> {
    if (!existsSync(path)) return;
    await unlink(path).catch(() => undefined);
    await rmdir(dirname(path)).catch(() => undefined);
    await rmdir(dirname(dirname(path))).catch(() => undefined);
    await rmdir(dirname(dirname(dirname(path)))).catch(() => undefined);
  }

  async #readRemoteResource(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    resource: AssetResourceEntry,
  ): Promise<{ content: Buffer; hash: string }> {
    const readOnce = async () => {
      const response = await this.#requestTarget(
        record.targetId,
        "bridge:readAssetResource",
        { assetId: entry.id, url: resource.url },
        120000,
      );
      if (!response.ok) throw new Error(response.error.message);
      const data = asObject(response.data);
      const base64 = typeof data.base64 === "string" ? data.base64 : "";
      if (!base64) {
        throw new Error(`Asset ${entry.id} resource ${resource.filename} returned no data.`);
      }
      const content = Buffer.from(base64, "base64");
      return { content, hash: hashContent(content) };
    };

    const expectedHash = resource.remoteHash;
    let remote = await readOnce();
    if (expectedHash && expectedHash !== remote.hash) {
      const confirmed = await readOnce();
      if (confirmed.hash !== remote.hash) {
        throw new Error(
          `Asset ${entry.id} resource ${resource.filename} changed while it was being downloaded: ` +
          `expected ${expectedHash}, received ${remote.hash}, then ${confirmed.hash}.`,
        );
      }
      record.lastWarning =
        `Asset ${entry.id} resource ${resource.filename} has stale PlayCanvas metadata ` +
        `(${expectedHash}); using stable downloaded content ${confirmed.hash}.`;
      remote = confirmed;
    }
    resource.observedRemoteHash = resource.advertisedRemoteHash !== remote.hash ? remote.hash : null;
    resource.remoteHash = remote.hash;
    resource.remoteFileSize = remote.content.byteLength;
    return remote;
  }

  async #prepareAssetResourceContent(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    resource: AssetResourceEntry,
  ): Promise<PreparedWorkspaceResource> {
    const path = this.#assetPath(record, resource.localPath);
    const localContent = existsSync(path) ? await readFile(path) : null;
    const localHash = localContent ? hashContent(localContent) : null;
    const localModified = Boolean(
      localHash && resource.localHash && localHash !== resource.localHash,
    );
    if (localContent && (!resource.remoteHash || localHash === resource.remoteHash)) {
      resource.localHash = localHash;
      resource.remoteFileSize = localContent.byteLength;
      await ensureFileMode(path, false);
      if (resource.remoteHash) {
        await this.#storeResourceObject(record, entry, resource, localContent, resource.remoteHash);
      }
      return {
        assetId: entry.id,
        filename: resource.filename,
        url: resource.url,
        path,
        hash: localHash!,
      };
    }

    const legacyPath = this.#legacyResourcePath(record, entry, resource);
    if (!localContent && existsSync(legacyPath)) {
      const legacyContent = await readFile(legacyPath);
      const legacyHash = hashContent(legacyContent);
      if (!resource.remoteHash || legacyHash === resource.remoteHash) {
        if (!resource.remoteHash) {
          resource.observedRemoteHash = legacyHash;
          resource.remoteHash = legacyHash;
        }
        await this.#storeResourceObject(record, entry, resource, legacyContent, legacyHash);
        const materialized = await this.#materializeResource(record, resource, legacyContent, legacyHash);
        await this.#removeLegacyResource(legacyPath);
        return {
          assetId: entry.id,
          filename: resource.filename,
          url: resource.url,
          path: materialized,
          hash: legacyHash,
        };
      }
    }

    if (localModified && localContent) {
      const conflictPath = join(
        record.tmpDirectory,
        "conflicts",
        `${entry.id}-${safeWorkspaceName(resource.filename, `resource-${entry.id}`)}.resource-local`,
      );
      await mkdir(dirname(conflictPath), { recursive: true });
      await copyFile(path, conflictPath);
      record.lastWarning =
        `Ignored a local edit to managed build resource ${entry.id}/${resource.filename}; ` +
        `the local copy was saved to ${relative(record.directory, conflictPath)}.`;
    }

    const cached = await this.#cachedResourceObject(record, entry, resource, resource.remoteHash);
    if (cached) {
      const materialized = await this.#materializeResource(record, resource, cached.content, cached.hash);
      await this.#removeLegacyResource(legacyPath);
      return {
        assetId: entry.id,
        filename: resource.filename,
        url: resource.url,
        path: materialized,
        hash: cached.hash,
      };
    }

    const remote = await this.#readRemoteResource(record, entry, resource);
    await this.#storeResourceObject(record, entry, resource, remote.content, remote.hash);
    const materialized = await this.#materializeResource(record, resource, remote.content, remote.hash);
    await this.#removeLegacyResource(legacyPath);
    return {
      assetId: entry.id,
      filename: resource.filename,
      url: resource.url,
      path: materialized,
      hash: remote.hash,
    };
  }

  async #readRemoteAsset(
    record: ProjectRecord,
    entry: AssetIndexEntry,
  ): Promise<{ content: Buffer; hash: string }> {
    const readOnce = async () => {
      const response = await this.#requestTarget(
        record.targetId,
        "bridge:readAssetFile",
        { assetId: entry.id },
        120000,
      );
      if (!response.ok) throw new Error(response.error.message);
      const data = asObject(response.data);
      const base64 = typeof data.base64 === "string" ? data.base64 : "";
      if (!base64) throw new Error(`Asset ${entry.id} returned no file data.`);
      const content = Buffer.from(base64, "base64");
      return { content, hash: hashContent(content) };
    };
    const expectedHash = entry.remoteFileHash;
    let remote = await readOnce();
    if (expectedHash && expectedHash !== remote.hash) {
      const confirmed = await readOnce();
      if (confirmed.hash !== remote.hash) {
        throw new Error(
          `Asset ${entry.id} changed while it was being downloaded: ` +
          `expected ${expectedHash}, received ${remote.hash}, then ${confirmed.hash}.`,
        );
      }
      record.lastWarning =
        `Asset ${entry.id} has stale PlayCanvas file metadata (${expectedHash}); ` +
        `using stable downloaded content ${confirmed.hash}.`;
      remote = confirmed;
    }
    entry.observedRemoteFileHash = entry.advertisedRemoteFileHash !== remote.hash
      ? remote.hash
      : null;
    entry.observedRemoteFileSize = entry.advertisedRemoteFileSize !== remote.content.byteLength
      ? remote.content.byteLength
      : null;
    entry.remoteFileSize = remote.content.byteLength;
    entry.remoteFileHash = remote.hash;
    return remote;
  }

  async #downloadAsset(
    record: ProjectRecord,
    entry: AssetIndexEntry,
  ): Promise<{ path: string; size: number; hash: string }> {
    if (!entry.localPath) throw new Error(`Asset ${entry.id} has no downloadable file.`);
    if (record.syncProgress) {
      record.syncProgress.assetId = entry.id;
      record.syncProgress.action = "downloading";
    }
    const legacyPath = this.#legacyCachedFilePath(
      record,
      entry.id,
      entry.filename || entry.name,
    );
    let legacy: { content: Buffer; hash: string } | null = null;
    if (existsSync(legacyPath)) {
      const content = await readFile(legacyPath);
      const hash = hashContent(content);
      if (entry.remoteFileHash && hash === entry.remoteFileHash) legacy = { content, hash };
    }
    const cached = legacy || await this.#cachedObject(record, entry, entry.remoteFileHash);
    const remote = cached || await this.#readRemoteAsset(record, entry);
    await this.#storeObject(record, entry, remote.content, remote.hash);
    const path = await this.#writeManagedAssetFile(record, entry, remote.content, remote.hash);
    await this.#removeLegacyResource(legacyPath);
    entry.lastSyncedHash = remote.hash;
    entry.status = "synced";
    delete entry.legacyLastSyncedSha256;
    delete entry.pendingRemoteHash;
    delete entry.error;
    return { path, size: remote.content.byteLength, hash: remote.hash };
  }

  async #downloadTextAsset(
    record: ProjectRecord,
    entry: AssetIndexEntry,
  ): Promise<{ path: string; size: number; hash: string }> {
    if (!entry.localPath) throw new Error(`Asset ${entry.id} has no downloadable file.`);
    if (record.syncProgress) {
      record.syncProgress.assetId = entry.id;
      record.syncProgress.action = "downloading";
    }
    const cached = await this.#cachedObject(record, entry, entry.remoteFileHash);
    let content: Buffer;
    let hash: string;
    if (cached) {
      content = cached.content;
      hash = cached.hash;
    } else {
      const response = await this.#requestTarget(
        record.targetId,
        "bridge:readAssetText",
        { assetId: entry.id },
        30000,
      );
      if (!response.ok) throw new Error(response.error.message);
      const data = asObject(response.data);
      const text = typeof data.text === "string" ? data.text : "";
      content = Buffer.from(text, "utf8");
      hash = hashContent(content);
      entry.observedRemoteFileHash = entry.advertisedRemoteFileHash !== hash ? hash : null;
      entry.observedRemoteFileSize = entry.advertisedRemoteFileSize !== content.byteLength ? content.byteLength : null;
      entry.remoteFileHash = hash;
      entry.remoteFileSize = content.byteLength;
      await this.#storeObject(record, entry, content, hash);
    }
    const path = await this.#writeManagedAssetFile(record, entry, content, hash);
    entry.lastSyncedHash = hash;
    entry.status = "synced";
    delete entry.legacyLastSyncedSha256;
    delete entry.pendingRemoteHash;
    delete entry.error;
    return { path, size: content.byteLength, hash };
  }

  async #uploadBinary(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    content: Buffer,
    localHash: string,
  ): Promise<void> {
    if (!entry.writable) throw new Error(`Derived Asset ${entry.id} is read-only.`);
    if (record.syncProgress) {
      record.syncProgress.assetId = entry.id;
      record.syncProgress.action = "uploading";
    }
    const response = await this.#requestTarget(
      record.targetId,
      "bridge:writeAssetFile",
      {
        assetId: entry.id,
        filename: entry.filename || entry.name,
        base64: content.toString("base64"),
      },
      120000,
    );
    if (!response.ok) {
      entry.status = "local-change";
      entry.error = response.error.message;
      return;
    }
    await this.#storeObject(record, entry, content, localHash);
    await this.#recordLocalFile(record, entry, localHash);
    entry.pendingRemoteHash = localHash;
    entry.status = "local-change";
    delete entry.legacyLastSyncedSha256;
    entry.error = "Waiting for PlayCanvas to confirm the uploaded file hash.";
  }

  async #writeBinaryConflict(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    remoteContent: Buffer,
    localHash: string,
  ): Promise<void> {
    if (!entry.localPath) return;
    if (record.syncProgress) {
      record.syncProgress.assetId = entry.id;
      record.syncProgress.action = "conflict";
    }
    const conflictBase = join(
      record.tmpDirectory,
      "conflicts",
      `${entry.id}-${safeWorkspaceName(entry.filename || entry.name, `asset-${entry.id}`)}`,
    );
    await mkdir(dirname(conflictBase), { recursive: true });
    await copyFile(this.#assetPath(record, entry.localPath), `${conflictBase}.local`);
    await atomicWrite(`${conflictBase}.remote`, remoteContent);
    entry.localHash = localHash;
    entry.downloaded = true;
    entry.status = "conflict";
    entry.error =
      `Local and remote asset files changed since the last sync. See ` +
      `${relative(record.directory, conflictBase)}.*`;
  }

  async #reconcileDerived(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old: AssetIndexEntry | undefined,
  ): Promise<void> {
    const local = await this.#localFileSnapshot(record, entry, old);
    if (!local) {
      if (old?.downloaded && entry.remoteFileHash) {
        const cached = await this.#cachedObject(record, entry, entry.remoteFileHash);
        if (cached) {
          await this.#writeManagedAssetFile(record, entry, cached.content, cached.hash);
          entry.lastSyncedHash = cached.hash;
          entry.status = "synced";
          delete entry.error;
          return;
        }
        await this.#downloadAsset(record, entry);
        return;
      }
      entry.localHash = null;
      entry.localFileSize = undefined;
      entry.localMtimeMs = undefined;
      entry.downloaded = false;
      entry.status = "indexed";
      delete entry.error;
      return;
    }

    entry.localHash = local.hash;
    entry.localFileSize = local.size;
    entry.localMtimeMs = local.mtimeMs;
    entry.localIno = local.ino;
    entry.localDev = local.dev;
    entry.downloaded = true;
    if (entry.remoteFileHash && local.hash === entry.remoteFileHash) {
      entry.lastSyncedHash = local.hash;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    const locallyModified = !old?.lastSyncedHash || local.hash !== old.lastSyncedHash;
    if (locallyModified && entry.localPath) {
      const conflictPath = join(
        record.tmpDirectory,
        "conflicts",
        `${entry.id}-${safeWorkspaceName(entry.filename || entry.name, `asset-${entry.id}`)}.derived-local`,
      );
      await mkdir(dirname(conflictPath), { recursive: true });
      await copyFile(this.#assetPath(record, entry.localPath), conflictPath);
      record.lastWarning =
        `Ignored a local edit to derived Asset ${entry.id}; restored the generated PlayCanvas file. ` +
        `The local copy was saved to ${relative(record.directory, conflictPath)}.`;
    }
    await this.#downloadAsset(record, entry);
  }

  async #reconcileBinary(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old: AssetIndexEntry | undefined,
  ): Promise<void> {
    const local = await this.#localFileSnapshot(record, entry, old);
    const baseline = old?.lastSyncedHash || null;
    const advertisedRemoteHash = entry.remoteFileHash;
    if (!local) {
      entry.downloaded = false;
      entry.status = "indexed";
      delete entry.error;
      return;
    }

    entry.localHash = local.hash;
    entry.localFileSize = local.size;
    entry.localMtimeMs = local.mtimeMs;
    entry.localIno = local.ino;
    entry.localDev = local.dev;
    entry.downloaded = true;
    if (advertisedRemoteHash && local.hash === advertisedRemoteHash) {
      await this.#storeObject(record, entry, await readFile(this.#assetPath(record, entry.localPath!)), local.hash);
      entry.lastSyncedHash = local.hash;
      entry.status = "synced";
      delete entry.legacyLastSyncedSha256;
      delete entry.pendingRemoteHash;
      delete entry.error;
      return;
    }
    if (
      old?.pendingRemoteHash &&
      local.hash === old.pendingRemoteHash &&
      advertisedRemoteHash !== old.pendingRemoteHash
    ) {
      entry.pendingRemoteHash = old.pendingRemoteHash;
      entry.status = "local-change";
      entry.error = "Waiting for PlayCanvas to confirm the uploaded file hash.";
      return;
    }
    if (baseline && local.hash === baseline && advertisedRemoteHash !== baseline) {
      await this.#downloadAsset(record, entry);
      return;
    }
    if (baseline && advertisedRemoteHash === baseline && local.hash !== baseline) {
      await this.#uploadBinary(
        record,
        entry,
        await readFile(this.#assetPath(record, entry.localPath!)),
        local.hash,
      );
      return;
    }

    const remote = await this.#readRemoteAsset(record, entry);
    if (remote.hash === local.hash) {
      await this.#storeObject(record, entry, remote.content, local.hash);
      entry.lastSyncedHash = local.hash;
      entry.status = "synced";
      delete entry.legacyLastSyncedSha256;
      delete entry.pendingRemoteHash;
      delete entry.error;
      return;
    }
    if (baseline && remote.hash === baseline) {
      await this.#uploadBinary(
        record,
        entry,
        await readFile(this.#assetPath(record, entry.localPath!)),
        local.hash,
      );
      return;
    }
    if (baseline && local.hash === baseline) {
      await this.#storeObject(record, entry, remote.content, remote.hash);
      await this.#writeManagedAssetFile(record, entry, remote.content, remote.hash);
      entry.lastSyncedHash = remote.hash;
      entry.status = "synced";
      delete entry.pendingRemoteHash;
      delete entry.error;
      return;
    }
    if (old?.status === "conflict" && old.localHash === local.hash && old.remoteFileHash === remote.hash) {
      entry.status = "conflict";
      entry.error = old.error;
      return;
    }
    await this.#writeBinaryConflict(record, entry, remote.content, local.hash);
  }

  async #reconcileTextAsset(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old: AssetIndexEntry | undefined,
    force: boolean,
  ): Promise<void> {
    if (!entry.localPath) return;
    const path = this.#assetPath(record, entry.localPath);
    const localSnap = await this.#localFileSnapshot(record, entry, old);
    const localHash = localSnap?.hash ?? null;
    const baseline = old?.lastSyncedHash || null;
    const advertisedRemoteHash = entry.remoteFileHash;

    if (localSnap) {
      entry.localFileSize = localSnap.size;
      entry.localMtimeMs = localSnap.mtimeMs;
      entry.localIno = localSnap.ino;
      entry.localDev = localSnap.dev;
    }

    if (localHash !== null && advertisedRemoteHash && localHash === advertisedRemoteHash) {
      if (!(await this.#cachedObject(record, entry, localHash))) {
        await this.#storeObject(record, entry, await readFile(path), localHash);
      }
      entry.localHash = localHash;
      entry.lastSyncedHash = localHash;
      entry.downloaded = true;
      entry.status = "synced";
      delete entry.legacyLastSyncedSha256;
      delete entry.pendingRemoteHash;
      delete entry.error;
      return;
    }

    if (
      localHash !== null &&
      old?.pendingRemoteHash &&
      localHash === old.pendingRemoteHash &&
      advertisedRemoteHash !== old.pendingRemoteHash
    ) {
      if (record.syncProgress) {
        record.syncProgress.assetId = entry.id;
        record.syncProgress.action = "downloading";
      }
      const response = await this.#requestTarget(
        record.targetId,
        "bridge:readAssetText",
        { assetId: entry.id },
        30000,
      );
      if (!response.ok) {
        entry.localHash = localHash;
        entry.pendingRemoteHash = old.pendingRemoteHash;
        entry.downloaded = true;
        entry.status = "local-change";
        entry.error = response.error.message;
        return;
      }
      const data = asObject(response.data);
      const pendingRemoteContent = typeof data.text === "string" ? data.text : "";
      const pendingRemoteBytes = Buffer.from(pendingRemoteContent, "utf8");
      const pendingRemoteHash = hashContent(pendingRemoteBytes);
      entry.observedRemoteFileHash = entry.advertisedRemoteFileHash !== pendingRemoteHash ? pendingRemoteHash : null;
      entry.observedRemoteFileSize = entry.advertisedRemoteFileSize !== pendingRemoteBytes.byteLength ? pendingRemoteBytes.byteLength : null;
      entry.remoteFileHash = pendingRemoteHash;
      entry.remoteFileSize = pendingRemoteBytes.byteLength;
      if (pendingRemoteHash === old.pendingRemoteHash) {
        await this.#storeObject(record, entry, pendingRemoteBytes, localHash);
        entry.localHash = localHash;
        entry.lastSyncedHash = localHash;
        entry.downloaded = true;
        entry.status = "synced";
        delete entry.legacyLastSyncedSha256;
        delete entry.pendingRemoteHash;
        delete entry.error;
        return;
      }
      if (pendingRemoteHash !== baseline) {
        await this.#storeObject(record, entry, pendingRemoteBytes, pendingRemoteHash);
        await this.#writeManagedAssetFile(record, entry, pendingRemoteBytes, pendingRemoteHash);
        entry.lastSyncedHash = pendingRemoteHash;
        entry.status = "synced";
        delete entry.legacyLastSyncedSha256;
        delete entry.pendingRemoteHash;
        delete entry.error;
        return;
      }
      entry.localHash = localHash;
      entry.pendingRemoteHash = old.pendingRemoteHash;
      entry.downloaded = true;
      entry.status = "local-change";
      entry.error = "Waiting for PlayCanvas to confirm the uploaded file hash.";
      return;
    }

    const localChanged = localHash !== null && localHash !== baseline;
    const remoteMetadataChanged = !old || old.remoteFileHash !== advertisedRemoteHash;
    if (!force && localHash !== null && baseline && !localChanged && !remoteMetadataChanged) {
      entry.localHash = localHash;
      entry.lastSyncedHash = baseline;
      entry.downloaded = true;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    if (localHash !== null && baseline && advertisedRemoteHash === baseline && localChanged) {
      const localContent = await readFile(path, "utf8");
      await this.#uploadTextAsset(record, entry, localContent, localHash);
      return;
    }

    let remoteContent: string;
    let remoteBytes: Buffer;
    let remoteHash: string;
    const cachedRemote = localHash === null && advertisedRemoteHash
      ? await this.#cachedObject(record, entry, advertisedRemoteHash)
      : null;

    if (cachedRemote) {
      remoteBytes = cachedRemote.content;
      remoteContent = remoteBytes.toString("utf8");
      remoteHash = cachedRemote.hash;
    } else {
      if (record.syncProgress) {
        record.syncProgress.assetId = entry.id;
        record.syncProgress.action = "downloading";
      }
      const response = await this.#requestTarget(
        record.targetId,
        "bridge:readAssetText",
        { assetId: entry.id },
        30000,
      );
      if (!response.ok) {
        entry.status = "error";
        entry.error = response.error.message;
        return;
      }
      const data = asObject(response.data);
      remoteContent = typeof data.text === "string" ? data.text : "";
      remoteBytes = Buffer.from(remoteContent, "utf8");
      remoteHash = hashContent(remoteBytes);
      entry.observedRemoteFileHash = entry.advertisedRemoteFileHash !== remoteHash ? remoteHash : null;
      entry.observedRemoteFileSize = entry.advertisedRemoteFileSize !== remoteBytes.byteLength ? remoteBytes.byteLength : null;
      entry.remoteFileHash = remoteHash;
      entry.remoteFileSize = remoteBytes.byteLength;
      await this.#storeObject(record, entry, remoteBytes, remoteHash);
    }

    if (localHash === null) {
      await this.#writeManagedAssetFile(record, entry, remoteBytes, remoteHash);
      entry.lastSyncedHash = remoteHash;
      entry.status = "synced";
      delete entry.legacyLastSyncedSha256;
      delete entry.pendingRemoteHash;
      delete entry.error;
      return;
    }

    if (localHash === remoteHash) {
      entry.localHash = localHash;
      entry.lastSyncedHash = localHash;
      entry.downloaded = true;
      entry.status = "synced";
      delete entry.legacyLastSyncedSha256;
      delete entry.pendingRemoteHash;
      delete entry.error;
      return;
    }

    const localBytes = await readFile(path);
    const localContent = localBytes.toString("utf8");

    if (baseline) {
      if (localHash === baseline) {
        await this.#writeManagedAssetFile(record, entry, remoteBytes, remoteHash);
        entry.lastSyncedHash = remoteHash;
        entry.status = "synced";
        delete entry.legacyLastSyncedSha256;
        delete entry.pendingRemoteHash;
        delete entry.error;
        return;
      }
      if (remoteHash === baseline) {
        await this.#uploadTextAsset(record, entry, localContent, localHash);
        return;
      }
      await this.#writeConflict(record, entry, localContent, remoteContent);
      return;
    }

    const legacyBaseline = old?.legacyLastSyncedSha256;
    if (legacyBaseline) {
      const localChangedFromLegacy = hashLegacyContent(localBytes) !== legacyBaseline;
      const remoteChangedFromLegacy = hashLegacyContent(remoteContent) !== legacyBaseline;
      if (!localChangedFromLegacy) {
        await this.#writeManagedAssetFile(record, entry, remoteBytes, remoteHash);
        entry.lastSyncedHash = remoteHash;
        entry.status = "synced";
        delete entry.legacyLastSyncedSha256;
        delete entry.pendingRemoteHash;
        delete entry.error;
        return;
      }
      if (!remoteChangedFromLegacy) {
        await this.#uploadTextAsset(record, entry, localContent, localHash);
        return;
      }
    }

    await this.#writeConflict(record, entry, localContent, remoteContent);
  }

  async #uploadTextAsset(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    localContent: string,
    localHash: string,
  ): Promise<void> {
    if (record.syncProgress) {
      record.syncProgress.assetId = entry.id;
      record.syncProgress.action = "uploading";
    }
    const method = entry.type === "script" ? "bridge:writeScriptText" : "bridge:writeAssetText";
    const writeResponse = await this.#requestTarget(
      record.targetId,
      method,
      { assetId: entry.id, text: localContent, filename: entry.filename || entry.name },
      60000,
    );
    if (!writeResponse.ok) {
      entry.localHash = localHash;
      entry.status = "local-change";
      entry.error = writeResponse.error.message;
      return;
    }
    await this.#storeObject(record, entry, Buffer.from(localContent, "utf8"), localHash);
    await this.#recordLocalFile(record, entry, localHash);
    entry.pendingRemoteHash = localHash;
    entry.status = "local-change";
    delete entry.legacyLastSyncedSha256;
    entry.error = "Waiting for PlayCanvas to confirm the uploaded file hash.";
  }

  async #reconcileJsonAsset(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old: AssetIndexEntry | undefined,
    remoteAsset?: RemoteAsset,
  ): Promise<void> {
    if (!entry.localPath) return;
    const remoteProj = buildAssetProjection({
      id: entry.id,
      name: remoteAsset?.name ?? entry.name,
      type: entry.type,
      preload: remoteAsset?.preload ?? entry.preload,
      tags: remoteAsset?.tags ?? entry.tags,
      data: remoteAsset?.data ?? {},
      role: entry.role,
      sourceAssetId: entry.sourceAssetId,
      writable: entry.writable,
    });
    const remoteBytes = Buffer.from(remoteProj.text, "utf8");
    const remoteHash = hashContent(remoteBytes);
    entry.remoteFileHash = remoteHash;
    entry.remoteFileSize = remoteBytes.byteLength;

    const absPath = this.#assetPath(record, entry.localPath);
    const localSnap = await this.#localFileSnapshot(record, entry, old);

    // Derived JSON assets (e.g. GLB-imported materials/templates) are eagerly projected read-only for Agent inspection.
    if (!entry.writable) {
      if (localSnap && localSnap.hash === remoteHash) {
        await ensureFileMode(absPath, false);
        entry.localHash = localSnap.hash;
        entry.localFileSize = localSnap.size;
        entry.localMtimeMs = localSnap.mtimeMs;
        entry.localIno = localSnap.ino;
        entry.localDev = localSnap.dev;
        entry.lastSyncedHash = remoteHash;
        entry.downloaded = true;
        entry.status = "synced";
        delete entry.error;
        return;
      }
      if (localSnap && old?.lastSyncedHash && localSnap.hash !== old.lastSyncedHash) {
        const conflictPath = join(
          record.tmpDirectory,
          "conflicts",
          `${entry.id}-${safeWorkspaceName(basename(entry.localPath), `asset-${entry.id}`)}.derived-local`,
        );
        await mkdir(dirname(conflictPath), { recursive: true });
        await copyFile(absPath, conflictPath);
        record.lastWarning =
          `Ignored a local edit to derived Asset ${entry.id}; restored the PlayCanvas projection. ` +
          `The local copy was saved to ${relative(record.directory, conflictPath)}.`;
      }
      await this.#writeManagedAssetFile(record, entry, remoteBytes, remoteHash);
      await this.#saveAssetBaseline(record, entry.id, remoteProj.doc);
      entry.lastSyncedHash = remoteHash;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    const tier = this.#syncTierForAsset(entry, remoteBytes.byteLength);
    if (!localSnap) {
      if (tier === "lazy-json") {
        entry.downloaded = false;
        entry.status = "indexed";
        delete entry.error;
        return;
      }
      await this.#writeManagedAssetFile(record, entry, remoteBytes, remoteHash);
      await this.#saveAssetBaseline(record, entry.id, remoteProj.doc);
      entry.lastSyncedHash = remoteHash;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    entry.localHash = localSnap.hash;
    entry.localFileSize = localSnap.size;
    entry.localMtimeMs = localSnap.mtimeMs;
    entry.localIno = localSnap.ino;
    entry.localDev = localSnap.dev;
    entry.downloaded = true;

    if (localSnap.hash === remoteHash) {
      await ensureFileMode(absPath, true);
      if (!existsSync(this.#assetBaselinePath(record, entry.id))) {
        await this.#saveAssetBaseline(record, entry.id, remoteProj.doc);
      }
      entry.lastSyncedHash = remoteHash;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    await ensureFileMode(absPath, true);
    const localRawText = await readFile(absPath, "utf8");
    let localParsed;
    try {
      localParsed = parseAssetProjection(localRawText, {
        name: stripDataAssetSuffix(entry.name, entry.type),
        type: entry.type,
      });
    } catch (error) {
      entry.status = "error";
      entry.error = `Invalid JSON in ${entry.localPath}: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }

    const localCanonical = buildAssetProjection({
      id: entry.id,
      name: localParsed.doc.name,
      type: entry.type,
      preload: localParsed.doc.preload,
      tags: localParsed.doc.tags,
      data: localParsed.doc.data,
      role: entry.role,
      sourceAssetId: entry.sourceAssetId,
      writable: entry.writable,
    });

    // Formatting-only edit in local JSON -> semantically identical to remote, zero RPC needed.
    if (localCanonical.text === remoteProj.text) {
      const rawHeader = (() => {
        try { return JSON.parse(localRawText)?.$pcbridge; } catch { return null; }
      })();
      if (rawHeader?.readonly === true) {
        await this.#writeManagedAssetFile(record, entry, remoteBytes, remoteHash);
        await this.#saveAssetBaseline(record, entry.id, remoteProj.doc);
        entry.lastSyncedHash = remoteHash;
        entry.remoteFileHash = remoteHash;
        entry.status = "synced";
        delete entry.error;
        return;
      }
      await this.#saveAssetBaseline(record, entry.id, remoteProj.doc);
      entry.lastSyncedHash = localSnap.hash;
      entry.remoteFileHash = localSnap.hash;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    const baseDoc = await this.#loadAssetBaseline(record, entry.id);
    if (!baseDoc) {
      await this.#writeJsonConflict(
        record,
        `${entry.id}-${safeWorkspaceName(basename(entry.localPath), `asset-${entry.id}`)}`,
        localRawText,
        remoteProj.text,
        ["$no_baseline"],
      );
      entry.status = "conflict";
      entry.error = `Local and remote JSON asset ${entry.id} differ without a shared baseline.`;
      return;
    }

    const mergeResult = threeWayMergeAssetJson(
      entry.type,
      baseDoc,
      localParsed.doc,
      remoteProj.doc,
    );

    if (mergeResult.conflicts.length > 0) {
      const conflictName = `${entry.id}-${safeWorkspaceName(basename(entry.localPath), `asset-${entry.id}`)}`;
      await this.#writeJsonConflict(
        record,
        conflictName,
        localRawText,
        remoteProj.text,
        mergeResult.conflicts,
      );
      entry.status = "conflict";
      entry.error =
        `Conflicting changes on ${mergeResult.conflicts.join(", ")}. ` +
        `See tmp/conflicts/${conflictName}.*`;
      return;
    }

    const patch = diffAssetPatchOps(remoteProj.doc, mergeResult.merged);
    let finalDoc = mergeResult.merged;
    if (patch) {
      if (record.syncProgress) {
        record.syncProgress.assetId = entry.id;
        record.syncProgress.action = "uploading";
      }
      const patchResp = await this.#requestTarget(
        record.targetId,
        "bridge:patchAssetData",
        {
          assetId: entry.id,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.preload !== undefined ? { preload: patch.preload } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          sets: patch.sets,
          unsets: patch.unsets,
        },
        60000,
      );
      if (!patchResp.ok) {
        entry.status = "local-change";
        entry.error = patchResp.error.message;
        return;
      }
      const updatedAssetObj = asObject(patchResp.data).asset;
      if (updatedAssetObj && typeof updatedAssetObj === "object" && !Array.isArray(updatedAssetObj)) {
        const updatedRemote = updatedAssetObj as unknown as RemoteAsset;
        record.remoteAssetsCache.set(entry.id, updatedRemote);
        entry.name = updatedRemote.name || finalDoc.name;
        entry.preload = updatedRemote.preload ?? finalDoc.preload;
        entry.tags = updatedRemote.tags ?? finalDoc.tags;
        const rebuilt = buildAssetProjection({
          id: entry.id,
          name: entry.name,
          type: entry.type,
          preload: entry.preload,
          tags: entry.tags,
          data: updatedRemote.data ?? finalDoc.data,
          role: entry.role,
          sourceAssetId: entry.sourceAssetId,
          writable: entry.writable,
        });
        finalDoc = rebuilt.doc;
      }
    }

    const finalProj = buildAssetProjection({
      id: entry.id,
      name: finalDoc.name,
      type: entry.type,
      preload: finalDoc.preload,
      tags: finalDoc.tags,
      data: finalDoc.data,
      role: entry.role,
      sourceAssetId: entry.sourceAssetId,
      writable: entry.writable,
    });
    const finalBytes = Buffer.from(finalProj.text, "utf8");
    const finalHash = hashContent(finalBytes);
    entry.name = finalDoc.name;

    const nextDesiredFilename = safeAssetName(
      dataAssetFilename(finalDoc.name, entry.type),
      `asset-${entry.id}.${entry.type}.json`,
    );
    const nextDesiredLocalPath = join(...entry.localFolderPath, nextDesiredFilename);
    if (nextDesiredLocalPath !== entry.localPath) {
      const nextAbs = this.#assetPath(record, nextDesiredLocalPath);
      if (!existsSync(nextAbs)) {
        await rename(absPath, nextAbs);
        entry.localPath = nextDesiredLocalPath;
      }
    }

    if (localRawText !== finalProj.text || nextDesiredLocalPath !== old?.localPath) {
      await this.#writeManagedAssetFile(record, entry, finalBytes, finalHash);
    } else {
      await this.#recordLocalFile(record, entry, finalHash);
    }
    await this.#saveAssetBaseline(record, entry.id, finalProj.doc);
    entry.remoteFileHash = finalHash;
    entry.remoteFileSize = finalBytes.byteLength;
    entry.lastSyncedHash = finalHash;
    entry.status = "synced";
    delete entry.error;
  }

  async #reconcileAllScenes(
    record: ProjectRecord,
    activeScene: RemoteScenePayload | null,
    sceneList: RemoteSceneSummary[] | null,
  ): Promise<void> {
    const activeId = activeScene ? String(activeScene.id) : null;
    if (activeScene) {
      record.activeSceneMemory = structuredClone(activeScene);
      await this.#reconcileActiveScene(record, activeScene);
    }

    if (!sceneList) return;
    const incomingSceneIds = new Set(sceneList.map((s) => String(s.id)));
    if (activeId) incomingSceneIds.add(activeId);

    // Quarantine deleted remote scenes.
    const deletionBatch = new Date().toISOString().replaceAll(":", "-");
    for (const [id, oldScene] of Object.entries(record.scenes)) {
      if (incomingSceneIds.has(id)) continue;
      const oldAbs = this.#scenePath(record, oldScene.localPath);
      if (existsSync(oldAbs)) {
        await chmod(oldAbs, 0o644).catch(() => undefined);
        const dest = join(
          record.tmpDirectory,
          "trash",
          "remote",
          deletionBatch,
          `scene-${id}-${safeWorkspaceName(oldScene.localPath, `scene-${id}`)}`,
        );
        await mkdir(dirname(dest), { recursive: true });
        await rename(oldAbs, dest);
        this.#markSelfDeleted(record, oldAbs);
      }
      await this.#deleteSceneBaseline(record, id);
      delete record.scenes[id];
    }

    for (const summary of sceneList) {
      const id = String(summary.id);
      if (id === activeId) continue;
      await this.#reconcileInactiveScene(record, summary);
    }
  }

  async #reconcileActiveScene(
    record: ProjectRecord,
    remoteScene: RemoteScenePayload,
  ): Promise<void> {
    const id = String(remoteScene.id);
    const old = record.scenes[id];
    const desiredFile = sceneLocalFilename(remoteScene.name || old?.name || `Scene-${id}`, id);

    // Lock any previously active scene to read-only if the Editor switched scenes.
    for (const other of Object.values(record.scenes)) {
      if (other.id !== id && other.active) {
        other.active = false;
        other.writable = false;
        const otherAbs = this.#scenePath(record, other.localPath);
        const otherBase = await this.#loadSceneBaseline(record, other.id);
        if (otherBase) {
          const inactiveProj = buildSceneProjection({
            id: other.id,
            name: otherBase.name,
            active: false,
            settings: otherBase.settings,
            entities: otherBase.entities,
          });
          const inactiveBytes = Buffer.from(inactiveProj.text, "utf8");
          const inactiveHash = hashContent(inactiveBytes);
          await this.#writeManagedSceneFile(record, other, inactiveBytes, inactiveHash);
          other.remoteHash = inactiveHash;
          other.lastSyncedHash = inactiveHash;
        } else if (existsSync(otherAbs)) {
          await ensureFileMode(otherAbs, false);
        }
      }
    }

    if (old && old.localPath !== desiredFile && existsSync(this.#scenePath(record, old.localPath))) {
      const oldAbs = this.#scenePath(record, old.localPath);
      const nextAbs = this.#scenePath(record, desiredFile);
      await ensureFileMode(oldAbs, true);
      if (!existsSync(nextAbs)) {
        await rename(oldAbs, nextAbs);
        this.#markSelfDeleted(record, oldAbs);
      }
    }

    const remoteProj = buildSceneProjection({
      id,
      name: remoteScene.name || "Scene",
      active: true,
      settings: remoteScene.settings,
      entities: remoteScene.entities,
    });
    const remoteBytes = Buffer.from(remoteProj.text, "utf8");
    const remoteHash = hashContent(remoteBytes);
    const entityCount = Object.keys(remoteProj.doc.entities).length;

    const sceneEntry: SceneIndexEntry = {
      id,
      name: remoteProj.doc.name,
      active: true,
      writable: true,
      localPath: desiredFile,
      modified: remoteScene.modified ?? old?.modified ?? null,
      entityCount,
      remoteHash,
      localHash: old?.localHash ?? null,
      lastSyncedHash: old?.lastSyncedHash ?? null,
      localFileSize: old?.localFileSize,
      localMtimeMs: old?.localMtimeMs,
      status: "synced",
    };
    record.scenes[id] = sceneEntry;

    await mkdir(record.scenesDirectory, { recursive: true });
    this.#ensureScenesWatcher(record);
    const absPath = this.#scenePath(record, desiredFile);

    if (!existsSync(absPath)) {
      await this.#writeManagedSceneFile(record, sceneEntry, remoteBytes, remoteHash);
      await this.#saveSceneBaseline(record, id, remoteProj.doc);
      sceneEntry.lastSyncedHash = remoteHash;
      return;
    }

    await ensureFileMode(absPath, true);
    const info = await stat(absPath);
    const cachedLocalHash = old?.localHash &&
      old.localFileSize === info.size &&
      old.localMtimeMs === info.mtimeMs
      ? old.localHash
      : null;
    const localHash = cachedLocalHash || hashContent(await readFile(absPath));
    sceneEntry.localHash = localHash;
    sceneEntry.localFileSize = info.size;
    sceneEntry.localMtimeMs = info.mtimeMs;

    if (localHash === remoteHash) {
      if (!existsSync(this.#sceneBaselinePath(record, id))) {
        await this.#saveSceneBaseline(record, id, remoteProj.doc);
      }
      sceneEntry.lastSyncedHash = remoteHash;
      return;
    }

    const localRawText = await readFile(absPath, "utf8");
    const baseDoc = await this.#loadSceneBaseline(record, id);

    let localParsed;
    try {
      localParsed = parseSceneProjection(
        localRawText,
        { id, name: sceneEntry.name },
        baseDoc?.entities as Record<string, unknown> | undefined,
      );
    } catch (error) {
      sceneEntry.status = "error";
      sceneEntry.error = `Invalid scene JSON in scenes/${desiredFile}: ${error instanceof Error ? error.message : String(error)}`;
      record.lastError = sceneEntry.error;
      return;
    }

    const localCanonical = buildSceneProjection({
      id,
      name: localParsed.doc.name,
      active: true,
      settings: localParsed.doc.settings,
      entities: localParsed.doc.entities,
    });

    if (localCanonical.text === remoteProj.text) {
      const rawHeader = (() => {
        try { return JSON.parse(localRawText)?.$pcbridge; } catch { return null; }
      })();
      if (rawHeader?.active !== true || rawHeader?.readonly === true) {
        await this.#writeManagedSceneFile(record, sceneEntry, remoteBytes, remoteHash);
        await this.#saveSceneBaseline(record, id, remoteProj.doc);
        sceneEntry.lastSyncedHash = remoteHash;
        sceneEntry.remoteHash = remoteHash;
        return;
      }
      await this.#saveSceneBaseline(record, id, remoteProj.doc);
      sceneEntry.lastSyncedHash = localHash;
      sceneEntry.remoteHash = localHash;
      return;
    }

    if (!baseDoc) {
      const conflictName = `scene-${id}-${safeWorkspaceName(desiredFile, `scene-${id}`)}`;
      await this.#writeJsonConflict(record, conflictName, localRawText, remoteProj.text, ["$no_baseline"]);
      sceneEntry.status = "conflict";
      sceneEntry.error = `Local and remote scene ${id} differ without a shared baseline.`;
      return;
    }

    const mergeResult = threeWayMergeSceneJson(baseDoc, localParsed.doc, remoteProj.doc);
    if (mergeResult.conflicts.length > 0) {
      const conflictName = `scene-${id}-${safeWorkspaceName(desiredFile, `scene-${id}`)}`;
      await this.#writeJsonConflict(
        record,
        conflictName,
        localRawText,
        remoteProj.text,
        mergeResult.conflicts,
      );
      sceneEntry.status = "conflict";
      sceneEntry.error =
        `Conflicting scene changes on ${mergeResult.conflicts.join(", ")}. ` +
        `See tmp/conflicts/${conflictName}.*`;
      return;
    }

    let finalDoc = mergeResult.merged;
    const patch = diffScenePatchOps(remoteProj.doc, mergeResult.merged);
    if (patch) {
      const patchResp = await this.#requestTarget(
        record.targetId,
        "bridge:patchScene",
        {
          sceneId: id,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          creates: patch.creates,
          reparents: patch.reparents,
          updates: patch.updates,
          deletes: patch.deletes,
          settingsSets: patch.settingsSets,
          settingsUnsets: patch.settingsUnsets,
        },
        60000,
      );
      if (!patchResp.ok) {
        sceneEntry.status = "error";
        sceneEntry.error = patchResp.error.message;
        record.lastError = sceneEntry.error;
        return;
      }
      const patchedSceneObj = asObject(patchResp.data).scene;
      if (patchedSceneObj && typeof patchedSceneObj === "object" && !Array.isArray(patchedSceneObj)) {
        const patchedRemote = patchedSceneObj as unknown as RemoteScenePayload;
        record.activeSceneMemory = structuredClone(patchedRemote);
        const rebuilt = buildSceneProjection({
          id,
          name: patchedRemote.name || finalDoc.name,
          active: true,
          settings: patchedRemote.settings,
          entities: patchedRemote.entities,
        });
        finalDoc = rebuilt.doc;
      }
    }

    const finalProj = buildSceneProjection({
      id,
      name: finalDoc.name,
      active: true,
      settings: finalDoc.settings,
      entities: finalDoc.entities,
    });
    const finalBytes = Buffer.from(finalProj.text, "utf8");
    const finalHash = hashContent(finalBytes);
    const finalSceneFile = sceneLocalFilename(finalDoc.name, id);
    if (finalSceneFile !== sceneEntry.localPath) {
      const nextSceneAbs = this.#scenePath(record, finalSceneFile);
      if (!existsSync(nextSceneAbs)) {
        await rename(absPath, nextSceneAbs);
        sceneEntry.localPath = finalSceneFile;
      }
    }
    sceneEntry.name = finalDoc.name;
    sceneEntry.entityCount = Object.keys(finalProj.doc.entities).length;
    sceneEntry.remoteHash = finalHash;
    sceneEntry.lastSyncedHash = finalHash;

    if (localRawText !== finalProj.text || finalSceneFile !== desiredFile) {
      await this.#writeManagedSceneFile(record, sceneEntry, finalBytes, finalHash);
    }
    await this.#saveSceneBaseline(record, id, finalProj.doc);
  }

  async #quarantineInactiveSceneEdit(
    record: ProjectRecord,
    sceneEntry: SceneIndexEntry,
    absPath: string,
  ): Promise<void> {
    const conflictPath = join(
      record.tmpDirectory,
      "conflicts",
      `scene-${sceneEntry.id}-${safeWorkspaceName(sceneEntry.localPath, `scene-${sceneEntry.id}`)}.inactive-scene-local`,
    );
    await mkdir(dirname(conflictPath), { recursive: true });
    await copyFile(absPath, conflictPath);
    const baseline = await this.#loadSceneBaseline(record, sceneEntry.id);
    if (baseline) {
      const restored = buildSceneProjection({
        id: sceneEntry.id,
        name: baseline.name,
        active: false,
        settings: baseline.settings,
        entities: baseline.entities,
      });
      const bytes = Buffer.from(restored.text, "utf8");
      const hash = hashContent(bytes);
      await this.#writeManagedSceneFile(record, sceneEntry, bytes, hash);
      sceneEntry.lastSyncedHash = hash;
    }
    record.lastWarning =
      `Ignored a local edit to inactive Scene ${sceneEntry.id} (${sceneEntry.name}); ` +
      `run pcbridge scene open --id ${sceneEntry.id} before editing it. ` +
      `The local copy was saved to ${relative(record.directory, conflictPath)}.`;
  }

  async #reconcileInactiveScene(
    record: ProjectRecord,
    summary: RemoteSceneSummary,
  ): Promise<void> {
    const id = String(summary.id);
    const old = record.scenes[id];
    const desiredFile = sceneLocalFilename(summary.name || old?.name || `Scene-${id}`, id);

    if (old && old.localPath !== desiredFile && existsSync(this.#scenePath(record, old.localPath))) {
      const oldAbs = this.#scenePath(record, old.localPath);
      const nextAbs = this.#scenePath(record, desiredFile);
      await ensureFileMode(oldAbs, true);
      if (!existsSync(nextAbs)) {
        await rename(oldAbs, nextAbs);
        this.#markSelfDeleted(record, oldAbs);
      }
    }

    await mkdir(record.scenesDirectory, { recursive: true });
    this.#ensureScenesWatcher(record);
    const absPath = this.#scenePath(record, desiredFile);
    const modified = summary.modified ?? null;

    if (old && existsSync(absPath) && old.modified && modified && old.modified === modified) {
      const info = await stat(absPath);
      const localHash = (old.localFileSize === info.size && old.localMtimeMs === info.mtimeMs && old.localHash)
        ? old.localHash
        : hashContent(await readFile(absPath));
      old.active = false;
      old.writable = false;
      old.localPath = desiredFile;
      old.name = summary.name || old.name;
      if (old.lastSyncedHash && localHash !== old.lastSyncedHash) {
        await this.#quarantineInactiveSceneEdit(record, old, absPath);
      } else {
        // Refresh header if upgrading from an older projection without active/readonly flags.
        const rawText = await readFile(absPath, "utf8");
        const rawHeader = (() => {
          try { return JSON.parse(rawText)?.$pcbridge; } catch { return null; }
        })();
        if (rawHeader?.active !== false || rawHeader?.readonly !== true) {
          const baseDoc = await this.#loadSceneBaseline(record, id);
          if (baseDoc) {
            const refreshed = buildSceneProjection({
              id,
              name: baseDoc.name,
              active: false,
              settings: baseDoc.settings,
              entities: baseDoc.entities,
            });
            const refreshedBytes = Buffer.from(refreshed.text, "utf8");
            const refreshedHash = hashContent(refreshedBytes);
            await this.#writeManagedSceneFile(record, old, refreshedBytes, refreshedHash);
            old.remoteHash = refreshedHash;
            old.lastSyncedHash = refreshedHash;
            return;
          }
        }
        await ensureFileMode(absPath, false);
      }
      return;
    }

    if (old && existsSync(absPath) && old.lastSyncedHash) {
      const currentHash = hashContent(await readFile(absPath));
      if (currentHash !== old.lastSyncedHash) {
        await this.#quarantineInactiveSceneEdit(record, old, absPath);
      }
    }

    const resp = await this.#requestTarget(
      record.targetId,
      "bridge:readScene",
      { sceneId: id },
      30000,
    );
    if (!resp.ok) {
      record.lastWarning = `Could not read inactive scene ${id}: ${resp.error.message}`;
      return;
    }
    const payload = asObject(resp.data) as unknown as RemoteScenePayload;
    const proj = buildSceneProjection({
      id,
      name: payload.name || summary.name || `Scene ${id}`,
      active: false,
      settings: payload.settings,
      entities: payload.entities,
    });
    const bytes = Buffer.from(proj.text, "utf8");
    const hash = hashContent(bytes);
    const entry: SceneIndexEntry = {
      id,
      name: proj.doc.name,
      active: false,
      writable: false,
      localPath: desiredFile,
      modified: payload.modified ?? modified,
      entityCount: Object.keys(proj.doc.entities).length,
      remoteHash: hash,
      localHash: hash,
      lastSyncedHash: hash,
      status: "synced",
    };
    record.scenes[id] = entry;
    await this.#writeManagedSceneFile(record, entry, bytes, hash);
    await this.#saveSceneBaseline(record, id, proj.doc);
  }

  async #writeJsonConflict(
    record: ProjectRecord,
    baseName: string,
    localText: string,
    remoteText: string,
    conflictingPaths: string[],
  ): Promise<void> {
    const conflictBase = join(record.tmpDirectory, "conflicts", baseName);
    await atomicWrite(`${conflictBase}.local`, localText);
    await atomicWrite(`${conflictBase}.remote`, remoteText);
    await atomicWrite(
      `${conflictBase}.conflict.json`,
      `${JSON.stringify({ conflictingPaths, detectedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  async #writeConflict(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    localContent: string,
    remoteContent: string,
  ): Promise<void> {
    if (record.syncProgress) {
      record.syncProgress.assetId = entry.id;
      record.syncProgress.action = "conflict";
    }
    const conflictBase = join(
      record.tmpDirectory,
      "conflicts",
      `${entry.id}-${safeWorkspaceName(entry.filename || entry.name, `script-${entry.id}`)}`,
    );
    await atomicWrite(`${conflictBase}.local`, localContent);
    await atomicWrite(`${conflictBase}.remote`, remoteContent);
    entry.localHash = hashContent(localContent);
    entry.downloaded = true;
    entry.status = "conflict";
    entry.error = `Local and remote script changed since the last sync. See ${relative(record.directory, conflictBase)}.*`;
  }

  #status(record: ProjectRecord): Record<string, JsonValue> {
    const entries = Object.values(record.index.entries);
    const scripts = entries.filter((entry) => entry.type === "script");
    const jsonAssets = entries.filter((entry) => DATA_JSON_TYPES.has(entry.type));
    const scenes = Object.values(record.scenes);
    const downloadable = entries.filter(
      (entry) => entry.localPath && !this.#isTier1EagerWritable(entry) && entry.role !== "derived"
        ? true
        : Boolean(entry.localPath && entry.type !== "script" && !DATA_JSON_TYPES.has(entry.type) && !TEXT_FILE_TYPES.has(entry.type)),
    );
    const lazyCandidates = entries.filter((entry) => entry.localPath && !entry.downloaded);
    const downloadedNonScripts = entries.filter(
      (entry) => entry.localPath && entry.type !== "script" && entry.downloaded,
    );
    const settings = this.getSettings();
    return {
      available: true,
      state: record.state,
      rootDirectory: this.rootDir,
      projectDirectory: record.directory,
      assetsDirectory: record.assetsDirectory,
      scenesDirectory: record.scenesDirectory,
      tmpDirectory: record.tmpDirectory,
      projectId: record.projectId,
      projectName: record.projectName,
      branchId: record.branchId,
      branchName: record.branchName,
      connected: record.connected,
      eagerMaxMb: settings.eagerMaxMb,
      eagerMaxBytes: settings.eagerMaxBytes,
      lastSyncedAt: record.lastSyncedAt,
      lastError: record.lastError,
      lastWarning: record.lastWarning,
      progress: record.syncPhase && record.syncStartedAt
        ? {
            phase: record.syncPhase,
            startedAt: record.syncStartedAt,
            ...(record.syncProgress || {}),
          }
        : null,
      counts: {
        assets: entries.filter((entry) => entry.type !== "folder").length,
        folders: entries.filter((entry) => entry.type === "folder").length,
        scripts: scripts.length,
        scriptsSynced: scripts.filter((entry) => entry.status === "synced").length,
        jsonAssets: jsonAssets.length,
        jsonAssetsSynced: jsonAssets.filter((entry) => entry.status === "synced").length,
        scenes: scenes.length,
        scenesSynced: scenes.filter((scene) => scene.status === "synced").length,
        localChanges: entries.filter((entry) => entry.status === "local-change").length,
        remoteChanges: entries.filter((entry) => entry.status === "remote-change").length,
        conflicts:
          entries.filter((entry) => entry.status === "conflict").length +
          scenes.filter((scene) => scene.status === "conflict").length,
        lazyAssets: lazyCandidates.length || downloadable.filter((entry) => !entry.downloaded).length,
        downloadedAssets: downloadedNonScripts.length,
      },
    };
  }
}
