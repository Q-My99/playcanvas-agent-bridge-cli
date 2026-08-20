import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Envelope, JsonValue, TargetInfo } from "../shared/protocol.js";

const PROJECT_FILE = "pcbridge.project.json";
const LEGACY_INDEX_FILE = join(".pcbridge", "asset-index.json");
const LEGACY_INDEX_BACKUP_FILE = join(".pcbridge", "asset-index.v1.json");
const SYNC_STATE_FILE = join(".pcbridge", "sync-state.json");
const DEFAULT_REFRESH_INTERVAL_MS = 5000;
const DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS = 350;
const PENDING_LOCAL_FILE_TTL_MS = 5 * 60 * 1000;

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
};

type AssetRole = "source" | "derived" | "standalone";

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
  remotePath: string[];
  localFolderPath: string[];
  localPath: string | null;
  filename: string | null;
  advertisedRemoteFileSize: number | null;
  advertisedRemoteFileHash: string | null;
  observedRemoteFileSize: number | null;
  observedRemoteFileHash: string | null;
  remoteFileSize: number | null;
  remoteFileHash: string | null;
  localHash: string | null;
  lastSyncedHash: string | null;
  legacyLastSyncedSha256?: string;
  pendingRemoteHash?: string;
  localFileSize?: number;
  localMtimeMs?: number;
  resources: Record<string, AssetResourceEntry>;
  downloaded: boolean;
  status: "indexed" | "synced" | "local-change" | "remote-change" | "conflict" | "error";
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

type ProjectManifest = Record<string, unknown> & {
  schemaVersion?: number;
  project?: { id: string; name: string };
  activeBranch?: { id: string | null; name: string | null };
  scenes?: Array<{ id: string; name: string | null }>;
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
  }>;
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

type ProjectRecord = {
  projectId: string;
  projectName: string;
  branchId: string | null;
  branchName: string | null;
  directory: string;
  assetsDirectory: string;
  tmpDirectory: string;
  objectsDirectory: string;
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
  syncPromise: Promise<void> | null;
  pendingLocalFiles: Map<string, {
    assetId: string;
    hash: string;
    createdAt: number;
  }>;
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
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const safeType = safeAssetName(type, "asset").replaceAll(" ", "-").toLocaleLowerCase();
  return `${stem}.__pc_${safeType}_${id}${extension}`;
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

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
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

  constructor(options: WorkspaceManagerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.#requestTarget = options.requestTarget;
    const interval = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.#localChangeDebounceMs = options.localChangeDebounceMs ?? DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS;
    if (interval > 0) {
      this.#refreshTimer = setInterval(() => {
        for (const record of this.#records.values()) {
          if (record.connected) void this.#sync(record, false);
        }
      }, interval);
      this.#refreshTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.#refreshTimer) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    await Promise.all(
      Array.from(this.#records.values(), (record) => record.syncPromise).filter(Boolean),
    );
    for (const watchers of this.#watchers.values()) for (const watcher of watchers) watcher.close();
    this.#watchers.clear();
    for (const timer of this.#watchTimers.values()) clearTimeout(timer);
    this.#watchTimers.clear();
  }

  async handleTarget(info: TargetInfo): Promise<void> {
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
    await this.#sync(record, false);
  }

  markDisconnected(info: TargetInfo): void {
    if (!info.projectId) return;
    const record = this.#records.get(info.projectId);
    if (record?.targetId === info.id) record.connected = false;
  }

  statusForTarget(info?: TargetInfo): JsonValue {
    if (!info?.projectId) {
      return {
        available: false,
        state: "unavailable",
        rootDirectory: this.rootDir,
      };
    }
    const record = this.#records.get(info.projectId);
    if (!record) {
      return {
        available: false,
        state: info.kind === "editor" ? "initializing" : "unavailable",
        rootDirectory: this.rootDir,
        projectId: info.projectId,
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
    if (!info.projectId) throw new Error("The selected target has no project metadata.");
    const record = this.#records.get(info.projectId);
    if (!record) throw new Error("The selected project workspace has not been initialized.");
    if (record.branchId && info.branchId && record.branchId !== info.branchId) {
      throw new Error(`Workspace is bound to branch ${record.branchId}, not ${info.branchId}.`);
    }
    record.targetId = info.id;
    record.targetInfo = info;
    record.connected = true;
    // A build only needs the selected dependency metadata and files. Do not
    // turn lazy binary synchronization back into a full project download.
    await this.#sync(record, false);
    return this.#status(record);
  }

  async prepareAssetFiles(
    info: TargetInfo,
    assetIds: Array<string | number>,
  ): Promise<PreparedWorkspaceAssets> {
    if (!info.projectId) throw new Error("The selected target has no project metadata.");
    const record = this.#records.get(info.projectId);
    if (!record) throw new Error("The selected project workspace has not been initialized.");
    record.targetId = info.id;
    record.targetInfo = info;
    record.connected = true;
    await this.#sync(record, true);

    const ids = [...new Set(assetIds.map(String))];
    const assets = await mapWithConcurrency(ids, 4, async (id): Promise<PreparedWorkspaceAsset> => {
      const entry = record.index.entries[id];
      if (!entry) throw new Error(`Asset ${id} is not present in the workspace catalog.`);
      if (entry.status === "conflict" || entry.status === "error") {
        throw new Error(`Asset ${id} cannot be built while its workspace state is ${entry.status}.`);
      }
      if (entry.localPath && !existsSync(this.#assetPath(record, entry.localPath))) {
        await this.#downloadAsset(record, entry);
      }
      const preparedPath = entry.localPath ? this.#assetPath(record, entry.localPath) : null;
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
    if (!info.projectId) throw new Error("The selected target has no project metadata.");
    const record = this.#records.get(info.projectId);
    if (!record) throw new Error("The selected project workspace has not been initialized.");
    const entry = record.index.entries[String(assetId)];
    if (!entry) throw new Error(`Asset ${assetId} is not present in the workspace index.`);
    if (!entry.localPath) throw new Error(`Asset ${assetId} has no downloadable file.`);
    if (entry.type === "script") {
      throw new Error("Scripts are synchronized automatically; use workspace sync instead.");
    }

    const result = await this.#downloadAsset(record, entry);
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
    const tmpDirectory = join(directory, "tmp");
    const objectsDirectory = join(directory, ".pcbridge", "objects");
    await mkdir(assetsDirectory, { recursive: true });
    await mkdir(join(tmpDirectory, "scripts"), { recursive: true });
    await mkdir(join(tmpDirectory, "captures"), { recursive: true });
    await mkdir(join(tmpDirectory, "conflicts"), { recursive: true });
    await mkdir(join(tmpDirectory, "trash", "remote"), { recursive: true });
    await mkdir(join(directory, ".pcbridge"), { recursive: true });
    await mkdir(objectsDirectory, { recursive: true });

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
      tmpDirectory,
      objectsDirectory,
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
      syncPromise: null,
      pendingLocalFiles: new Map(),
    };
    this.#records.set(record.projectId, record);
    return record;
  }

  #ensureWatcher(record: ProjectRecord): void {
    if (this.#watchers.has(record.projectId)) return;
    const watchers = new Set<FSWatcher>();
    this.#watchers.set(record.projectId, watchers);
    const schedule = (filename: string | Buffer | null | undefined) => {
      if (!filename) return;
      const relativeName = toPosixPath(String(filename));
      if (relativeName.startsWith(".pcbridge/") || relativeName.startsWith("tmp/") || relativeName.includes("/tmp/")) return;
      const existing = this.#watchTimers.get(record.projectId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.#watchTimers.delete(record.projectId);
        if (record.connected) void this.#sync(record, true);
      }, this.#localChangeDebounceMs);
      timer.unref();
      this.#watchTimers.set(record.projectId, timer);
    };
    try {
      const watcher = watch(record.assetsDirectory, { recursive: true }, (_event, filename) => {
        schedule(filename);
      });
      watcher.on("error", (error) => { record.lastWarning = `Local workspace watcher stopped: ${String(error)}`; });
      watchers.add(watcher);
    } catch (error) {
      // Some Linux Node builds do not support recursive fs.watch. Watch each
      // existing directory instead; new directories are picked up on sync.
      const attach = async (directory: string): Promise<void> => {
        let watcher: FSWatcher;
        try {
          watcher = watch(directory, (_event, filename) => schedule(filename));
        } catch {
          return;
        }
        watchers.add(watcher);
        let children;
        try { children = await readdir(directory, { withFileTypes: true }); } catch { return; }
        await Promise.all(children.filter((child) => child.isDirectory()).map((child) => attach(join(directory, child.name))));
      };
      void attach(record.assetsDirectory);
      record.lastWarning = `Recursive local watcher unavailable; using directory watchers (${String(error)})`;
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
          writable: asset.local?.writable ?? asset.origin.role !== "derived",
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
          legacyLastSyncedSha256: syncState?.entries?.[id]?.legacyLastSyncedSha256,
          pendingRemoteHash: syncState?.entries?.[id]?.pendingRemoteHash,
          localFileSize: syncState?.entries?.[id]?.localFileSize ?? asset.local?.size ?? undefined,
          localMtimeMs: syncState?.entries?.[id]?.localMtimeMs,
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
        legacyLastSyncedSha256: syncState?.entries?.[id]?.legacyLastSyncedSha256,
        pendingRemoteHash: syncState?.entries?.[id]?.pendingRemoteHash,
        localFileSize: syncState?.entries?.[id]?.localFileSize,
        localMtimeMs: syncState?.entries?.[id]?.localMtimeMs,
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
                observed: entry.observedRemoteFileHash,
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

  async #writeManifest(record: ProjectRecord): Promise<void> {
    const path = join(record.directory, PROJECT_FILE);
    const existing = await readJson<ProjectManifest>(path);
    const info = record.targetInfo;
    const scenes = Array.isArray(existing?.scenes) ? [...existing.scenes] : [];
    if (info.sceneId) {
      const scene = scenes.find((item) => item.id === info.sceneId);
      if (scene) scene.name = info.sceneName || scene.name;
      else scenes.push({ id: info.sceneId, name: info.sceneName || null });
    }
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
    record.index.updatedAt = new Date().toISOString();
    const entries = Object.fromEntries(
      Object.values(record.index.entries)
        .filter((entry) =>
          entry.legacyLastSyncedSha256 ||
          entry.pendingRemoteHash ||
          entry.localFileSize !== undefined ||
          entry.localMtimeMs !== undefined
        )
        .map((entry) => [entry.id, {
          legacyLastSyncedSha256: entry.legacyLastSyncedSha256,
          pendingRemoteHash: entry.pendingRemoteHash,
          localFileSize: entry.localFileSize,
          localMtimeMs: entry.localMtimeMs,
        }]),
    );
    await atomicWrite(
      join(record.directory, SYNC_STATE_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: record.projectId,
        branchId: record.branchId,
        updatedAt: record.index.updatedAt,
        lastSuccessfulSyncAt: record.lastSyncedAt,
        entries,
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

  async #sync(record: ProjectRecord, force: boolean): Promise<void> {
    if (record.syncPromise) return record.syncPromise;
    record.syncPromise = this.#performSync(record, force).finally(() => {
      record.syncPromise = null;
    });
    return record.syncPromise;
  }

  async #performSync(record: ProjectRecord, force: boolean): Promise<void> {
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
      record.syncPhase = "reconciling";
      record.syncProgress = {
        completed: 0,
        total: assets.filter((asset) => asset.type !== "folder" && asset.file).length,
        assetId: null,
        action: "comparing",
      };
      await this.#applySnapshot(record, assets, force);
      await this.#uploadUnindexedFiles(record);
      record.lastSyncedAt = new Date().toISOString();
      const entries = Object.values(record.index.entries);
      record.state = entries.some((entry) => entry.status === "conflict")
        ? "conflict"
        : entries.some((entry) => entry.status === "local-change")
          ? "local-change"
          : entries.some((entry) => entry.status === "remote-change")
            ? "remote-change"
            : entries.some((entry) => entry.status === "error")
              ? "error"
              : "synced";
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

  async #uploadUnindexedFiles(record: ProjectRecord): Promise<void> {
    const now = Date.now();
    for (const [path, pending] of record.pendingLocalFiles) {
      if (now - pending.createdAt > PENDING_LOCAL_FILE_TTL_MS) record.pendingLocalFiles.delete(path);
    }
    const known = new Set(
      Object.values(record.index.entries)
        .flatMap((entry) => [
          entry.localPath ? toPosixPath(entry.localPath) : null,
          ...Object.values(entry.resources).map((resource) => toPosixPath(resource.localPath)),
        ])
        .filter(Boolean),
    );
    for (const path of record.pendingLocalFiles.keys()) known.add(path);
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
        else if (child.isFile() && !known.has(toPosixPath(relativePath))) files.push(relativePath);
      }
    };
    await visit(record.assetsDirectory, "");
    for (const relativePath of files) {
      const path = this.#assetPath(record, relativePath);
      const content = await readFile(path);
      const contentHash = hashContent(content);
      const normalizedPath = toPosixPath(relativePath);
      const parts = relativePath.split(/[\\/]/g);
      const filename = parts.pop() || "asset.bin";
      const folder = parts.join("/");
      const derived = Object.values(record.index.entries).find((entry) =>
        entry.role === "derived" &&
        (entry.localHash === contentHash || entry.lastSyncedHash === contentHash),
      );
      if (derived) {
        const conflictPath = join(
          record.tmpDirectory,
          "conflicts",
          `${derived.id}-${safeWorkspaceName(filename, `asset-${derived.id}`)}.derived-local`,
        );
        await mkdir(dirname(conflictPath), { recursive: true });
        await rename(path, conflictPath);
        record.lastWarning =
          `Ignored a moved or copied projection of derived Asset ${derived.id}; ` +
          `the local copy was saved to ${relative(record.directory, conflictPath)}.`;
        continue;
      }
      const renamed = Object.values(record.index.entries).find((entry) =>
        entry.writable && entry.type !== "folder" && entry.localPath &&
        !existsSync(this.#assetPath(record, entry.localPath)) &&
        entry.localHash === contentHash,
      );
      if (renamed) {
        const renameResponse = await this.#requestTarget(
          record.targetId,
          "bridge:renameAsset",
          {
            assetId: renamed.id,
            name: filename,
            filename,
            folder,
          },
          60000,
        );
        if (renameResponse.ok) {
          record.pendingLocalFiles.set(normalizedPath, {
            assetId: renamed.id,
            hash: contentHash,
            createdAt: Date.now(),
          });
          const refresh = await this.#requestTarget(record.targetId, "bridge:workspaceSnapshot", {}, 60000);
          if (refresh.ok) {
            const snapshot = asObject(refresh.data);
            const refreshedAssets = Array.isArray(snapshot.assets) ? snapshot.assets as unknown as RemoteAsset[] : [];
            if (refreshedAssets.length) await this.#applySnapshot(record, refreshedAssets, false);
          }
          continue;
        }
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
      const uploaded = data.asset;
      if (uploaded && typeof uploaded === "object" && !Array.isArray(uploaded)) {
        const uploadedId = (uploaded as Record<string, JsonValue>).id;
        if (uploadedId !== undefined && uploadedId !== null) {
          record.pendingLocalFiles.set(normalizedPath, {
            assetId: String(uploadedId),
            hash: contentHash,
            createdAt: Date.now(),
          });
        }
        const refresh = await this.#requestTarget(record.targetId, "bridge:workspaceSnapshot", {}, 60000);
        if (refresh.ok) {
          const snapshot = asObject(refresh.data);
          const refreshedAssets = Array.isArray(snapshot.assets)
            ? snapshot.assets as unknown as RemoteAsset[]
            : [];
          if (refreshedAssets.length) await this.#applySnapshot(record, refreshedAssets, false);
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

  async #applySnapshot(record: ProjectRecord, assets: RemoteAsset[], force: boolean): Promise<void> {
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
      await mkdir(this.#assetPath(record, join(...localPath)), { recursive: true });
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
          localFileSize: undefined,
          localMtimeMs: undefined,
          resources: {},
          downloaded: false,
          status: "indexed",
        };
        continue;
      }

      const role = assetRole(asset);
      const derived = role === "derived";
      const sourceAssetId = derived ? String(asset.source_asset_id) : null;
      const remoteFilename = asset.file?.filename || (asset.type === "script" ? asset.name : null);
      const localFilename = remoteFilename;
      const localName = localFilename ? allocateName(localParent, localFilename, asset.type, id) : null;
      const localPath = localName ? join(...localParent, localName) : null;
      const old = previous[id];
      const advertisedRemoteFileSize = asset.file?.size ?? null;
      const advertisedRemoteFileHash = asset.file?.hash || null;
      const metadataUnchanged = old?.advertisedRemoteFileHash === advertisedRemoteFileHash &&
        old?.advertisedRemoteFileSize === advertisedRemoteFileSize;
      const observedRemoteFileSize = metadataUnchanged ? old?.observedRemoteFileSize ?? null : null;
      const observedRemoteFileHash = metadataUnchanged ? old?.observedRemoteFileHash ?? null : null;
      const entry: AssetIndexEntry = {
        id,
        name: asset.name,
        type: asset.type,
        role,
        sourceAssetId,
        writable: !derived,
        remotePath: remoteParent,
        localFolderPath: localParent,
        localPath,
        filename: remoteFilename,
        advertisedRemoteFileSize,
        advertisedRemoteFileHash,
        observedRemoteFileSize,
        observedRemoteFileHash,
        remoteFileSize: observedRemoteFileSize ?? advertisedRemoteFileSize,
        remoteFileHash: observedRemoteFileHash || advertisedRemoteFileHash,
        localHash: old?.localHash || null,
        lastSyncedHash: old?.lastSyncedHash || null,
        legacyLastSyncedSha256: old?.legacyLastSyncedSha256,
        pendingRemoteHash: old?.pendingRemoteHash,
        localFileSize: old?.localFileSize,
        localMtimeMs: old?.localMtimeMs,
        resources: old?.resources || {},
        downloaded: old?.downloaded || false,
        status: old?.status || "indexed",
        error: old?.error,
      };
      next[id] = entry;

      if (asset.file && record.syncProgress) {
        record.syncProgress.assetId = id;
        record.syncProgress.action = "comparing";
      }

      if (old?.localPath && localPath && old.localPath !== localPath && existsSync(this.#assetPath(record, old.localPath))) {
        const oldPath = this.#assetPath(record, old.localPath);
        const newPath = this.#assetPath(record, localPath);
        await mkdir(dirname(newPath), { recursive: true });
        if (!existsSync(newPath)) await rename(oldPath, newPath);
      }
      if (derived && localPath) {
        await this.#reconcileDerived(record, entry, old);
        if (existsSync(this.#assetPath(record, localPath))) {
          await chmod(this.#assetPath(record, localPath), 0o444).catch(() => undefined);
        }
      } else if (asset.type === "script" && localPath) {
        if (existsSync(this.#assetPath(record, localPath))) {
          await chmod(this.#assetPath(record, localPath), 0o644).catch(() => undefined);
        }
        await this.#reconcileScript(record, entry, old, force);
      } else if (localPath) {
        if (existsSync(this.#assetPath(record, localPath))) {
          await chmod(this.#assetPath(record, localPath), 0o644).catch(() => undefined);
        }
        await this.#reconcileBinary(record, entry, old);
      }
      if (asset.file && record.syncProgress) record.syncProgress.completed += 1;
    }

    const deletionBatch = new Date().toISOString().replaceAll(":", "-");
    for (const [id, old] of Object.entries(previous)) {
      if (next[id]) continue;
      const deletedPaths = [
        old.localPath,
        ...Object.values(old.resources).map((resource) => resource.localPath),
      ].filter((path): path is string => Boolean(path));
      for (const deletedPath of deletedPaths) {
        if (!existsSync(this.#assetPath(record, deletedPath))) continue;
        const source = this.#assetPath(record, deletedPath);
        const destination = join(
          record.tmpDirectory,
          "trash",
          "remote",
          deletionBatch,
          `${id}-${safeWorkspaceName(basename(deletedPath), `asset-${id}`)}`,
        );
        await mkdir(dirname(destination), { recursive: true });
        await rename(source, destination);
      }
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
    for (const [path, pending] of record.pendingLocalFiles) {
      const entry = next[pending.assetId];
      if (entry?.localPath && toPosixPath(entry.localPath) === path) {
        record.pendingLocalFiles.delete(path);
      }
    }
  }

  async #localFileSnapshot(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old?: AssetIndexEntry,
  ): Promise<{ hash: string; size: number; mtimeMs: number } | null> {
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
    };
  }

  async #recordLocalFile(record: ProjectRecord, entry: AssetIndexEntry, hash: string): Promise<void> {
    if (!entry.localPath) return;
    const info = await stat(this.#assetPath(record, entry.localPath));
    entry.localHash = hash;
    entry.localFileSize = info.size;
    entry.localMtimeMs = info.mtimeMs;
    entry.downloaded = true;
  }

  #objectPath(record: ProjectRecord, entry: AssetIndexEntry, hash: string): string {
    const path = this.#withinRoot(join(
      record.objectsDirectory,
      safeAssetName(entry.id, "asset"),
      safeAssetName(hash, "unknown"),
      safeAssetName(entry.filename || entry.name, "file.bin"),
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
    if (existsSync(path)) await chmod(path, 0o644).catch(() => undefined);
    await atomicWrite(path, content);
    await chmod(path, 0o444).catch(() => undefined);
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
      await chmod(path, 0o444).catch(() => undefined);
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

  async #materializeObject(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    content: Buffer,
    hash: string,
  ): Promise<string> {
    if (!entry.localPath) throw new Error(`Asset ${entry.id} has no local projection path.`);
    const path = this.#assetPath(record, entry.localPath);
    if (existsSync(path)) await chmod(path, 0o644).catch(() => undefined);
    await atomicWrite(path, content);
    await chmod(path, entry.writable ? 0o644 : 0o444).catch(() => undefined);
    await this.#recordLocalFile(record, entry, hash);
    return path;
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
      // Processed assets can expose stale metadata after their generated file has been replaced.
      // A second identical download distinguishes that case from an actively changing resource.
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
    const path = await this.#materializeObject(record, entry, remote.content, remote.hash);
    await this.#removeLegacyResource(legacyPath);
    entry.lastSyncedHash = remote.hash;
    entry.status = "synced";
    delete entry.legacyLastSyncedSha256;
    delete entry.pendingRemoteHash;
    delete entry.error;
    return { path, size: remote.content.byteLength, hash: remote.hash };
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
          await this.#materializeObject(record, entry, cached.content, cached.hash);
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
      // Binary assets are lazy. Keep the catalog and remote hash locally, and
      // only fetch bytes through workspace pull or a Template build.
      entry.downloaded = false;
      entry.status = "indexed";
      delete entry.error;
      return;
    }

    entry.localHash = local.hash;
    entry.localFileSize = local.size;
    entry.localMtimeMs = local.mtimeMs;
    entry.downloaded = true;
    if (advertisedRemoteHash && local.hash === advertisedRemoteHash) {
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
      await atomicWrite(this.#assetPath(record, entry.localPath!), remote.content);
      await this.#recordLocalFile(record, entry, remote.hash);
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

  async #reconcileScript(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old: AssetIndexEntry | undefined,
    force: boolean,
  ): Promise<void> {
    if (!entry.localPath) return;
    const path = this.#assetPath(record, entry.localPath);
    const localBytes = existsSync(path) ? await readFile(path) : null;
    const localContent = localBytes?.toString("utf8") ?? null;
    const localHash = localBytes === null ? null : hashContent(localBytes);
    const baseline = old?.lastSyncedHash || null;
    const advertisedRemoteHash = entry.remoteFileHash;

    if (localContent !== null && advertisedRemoteHash && localHash === advertisedRemoteHash) {
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
      localContent !== null &&
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
      const pendingRemoteHash = hashContent(pendingRemoteContent);
      entry.remoteFileHash = pendingRemoteHash;
      if (pendingRemoteHash === old.pendingRemoteHash) {
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
        await atomicWrite(path, pendingRemoteContent);
        entry.localHash = pendingRemoteHash;
        entry.lastSyncedHash = pendingRemoteHash;
        entry.downloaded = true;
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
    if (!force && localContent !== null && baseline && !localChanged && !remoteMetadataChanged) {
      entry.localHash = localHash;
      entry.lastSyncedHash = baseline;
      entry.downloaded = true;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    if (localContent !== null && baseline && advertisedRemoteHash === baseline && localChanged) {
      await this.#uploadScript(record, entry, localContent, localHash);
      return;
    }

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
    const remoteContent = typeof data.text === "string" ? data.text : "";
    const remoteHash = hashContent(remoteContent);
    // The Editor observer can lag behind the asset file endpoint immediately
    // after a save. The text response is authoritative for this reconciliation
    // pass; the next snapshot will catch up to its hash.
    entry.remoteFileHash = remoteHash;

    if (localContent === null) {
      await atomicWrite(path, remoteContent);
      entry.localHash = remoteHash;
      entry.lastSyncedHash = remoteHash;
      entry.downloaded = true;
      entry.status = "synced";
      delete entry.legacyLastSyncedSha256;
      delete entry.pendingRemoteHash;
      delete entry.error;
      return;
    }
    if (!localHash) throw new Error(`Could not hash local script ${entry.id}.`);

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

    if (baseline) {
      if (localHash === baseline) {
        await atomicWrite(path, remoteContent);
        entry.localHash = remoteHash;
        entry.lastSyncedHash = remoteHash;
        entry.downloaded = true;
        entry.status = "synced";
        delete entry.legacyLastSyncedSha256;
        delete entry.pendingRemoteHash;
        delete entry.error;
        return;
      }
      if (remoteHash === baseline) {
        await this.#uploadScript(record, entry, localContent, localHash);
        return;
      }
      await this.#writeConflict(record, entry, localContent, remoteContent);
      return;
    }

    const legacyBaseline = old?.legacyLastSyncedSha256;
    if (legacyBaseline && localBytes) {
      const localChangedFromLegacy = hashLegacyContent(localBytes) !== legacyBaseline;
      const remoteChangedFromLegacy = hashLegacyContent(remoteContent) !== legacyBaseline;
      if (!localChangedFromLegacy) {
        await atomicWrite(path, remoteContent);
        entry.localHash = remoteHash;
        entry.lastSyncedHash = remoteHash;
        entry.downloaded = true;
        entry.status = "synced";
        delete entry.legacyLastSyncedSha256;
        delete entry.pendingRemoteHash;
        delete entry.error;
        return;
      }
      if (!remoteChangedFromLegacy) {
        await this.#uploadScript(record, entry, localContent, localHash);
        return;
      }
    }

    await this.#writeConflict(record, entry, localContent, remoteContent);
  }

  async #uploadScript(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    localContent: string,
    localHash: string,
  ): Promise<void> {
    if (record.syncProgress) {
      record.syncProgress.assetId = entry.id;
      record.syncProgress.action = "uploading";
    }
    const writeResponse = await this.#requestTarget(
      record.targetId,
      "bridge:writeScriptText",
      { assetId: entry.id, text: localContent },
      60000,
    );
    if (!writeResponse.ok) {
      entry.localHash = localHash;
      entry.status = "local-change";
      entry.error = writeResponse.error.message;
      return;
    }
    entry.localHash = localHash;
    entry.pendingRemoteHash = localHash;
    entry.downloaded = true;
    entry.status = "local-change";
    delete entry.legacyLastSyncedSha256;
    entry.error = "Waiting for PlayCanvas to confirm the uploaded file hash.";
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
    const downloadable = entries.filter((entry) => entry.localPath && entry.type !== "script");
    return {
      available: true,
      state: record.state,
      rootDirectory: this.rootDir,
      projectDirectory: record.directory,
      assetsDirectory: record.assetsDirectory,
      tmpDirectory: record.tmpDirectory,
      projectId: record.projectId,
      projectName: record.projectName,
      branchId: record.branchId,
      branchName: record.branchName,
      connected: record.connected,
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
        localChanges: entries.filter((entry) => entry.status === "local-change").length,
        remoteChanges: entries.filter((entry) => entry.status === "remote-change").length,
        conflicts: entries.filter((entry) => entry.status === "conflict").length,
        lazyAssets: downloadable.filter((entry) => !entry.downloaded).length,
        downloadedAssets: downloadable.filter((entry) => entry.downloaded).length,
      },
    };
  }
}
