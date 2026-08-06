import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Envelope, JsonValue, TargetInfo } from "../shared/protocol.js";

const PROJECT_FILE = "pcbridge.project.json";
const LEGACY_INDEX_FILE = join(".pcbridge", "asset-index.json");
const LEGACY_INDEX_BACKUP_FILE = join(".pcbridge", "asset-index.v1.json");
const SYNC_STATE_FILE = join(".pcbridge", "sync-state.json");
const DEFAULT_REFRESH_INTERVAL_MS = 5000;

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
};

type AssetIndexEntry = {
  id: string;
  name: string;
  type: string;
  remotePath: string[];
  localPath: string | null;
  filename: string | null;
  remoteFileSize: number | null;
  remoteFileHash: string | null;
  localHash: string | null;
  lastSyncedHash: string | null;
  legacyLastSyncedSha256?: string;
  pendingRemoteHash?: string;
  localFileSize?: number;
  localMtimeMs?: number;
  downloaded: boolean;
  status: "indexed" | "synced" | "local-change" | "remote-change" | "conflict" | "error";
  error?: string;
};

type AssetIndex = {
  schemaVersion: 2;
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

type ManifestAsset = {
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
  assets?: Record<string, ManifestAsset>;
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

type ProjectRecord = {
  projectId: string;
  projectName: string;
  branchId: string | null;
  branchName: string | null;
  directory: string;
  assetsDirectory: string;
  tmpDirectory: string;
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

function collisionName(filename: string, id: string): string {
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem}~${id}${extension}`;
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid workspace response from PlayCanvas target.");
  }
  return value as Record<string, JsonValue>;
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

  constructor(options: WorkspaceManagerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.#requestTarget = options.requestTarget;
    const interval = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
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
    await this.#sync(record, true);
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

    const assets: PreparedWorkspaceAsset[] = [];
    for (const rawId of assetIds) {
      const id = String(rawId);
      const entry = record.index.entries[id];
      if (!entry) throw new Error(`Asset ${id} is not present in the workspace catalog.`);
      if (entry.status === "conflict" || entry.status === "error") {
        throw new Error(`Asset ${id} cannot be built while its workspace state is ${entry.status}.`);
      }
      if (entry.localPath && !existsSync(this.#assetPath(record, entry.localPath))) {
        await this.#downloadAsset(record, entry);
      }
      assets.push({
        id,
        name: entry.name,
        type: entry.type,
        filename: entry.filename,
        path: entry.localPath ? this.#assetPath(record, entry.localPath) : null,
        hash: entry.localHash,
      });
    }
    await this.#persist(record);
    return {
      projectDirectory: record.directory,
      tmpDirectory: record.tmpDirectory,
      assets,
    };
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
    await mkdir(assetsDirectory, { recursive: true });
    await mkdir(join(tmpDirectory, "scripts"), { recursive: true });
    await mkdir(join(tmpDirectory, "captures"), { recursive: true });
    await mkdir(join(tmpDirectory, "conflicts"), { recursive: true });
    await mkdir(join(tmpDirectory, "trash", "remote"), { recursive: true });
    await mkdir(join(directory, ".pcbridge"), { recursive: true });

    const manifest = await readJson<ProjectManifest>(join(directory, PROJECT_FILE));
    const syncState = await readJson<SyncState>(join(directory, SYNC_STATE_FILE));
    const legacyPrimaryPath = join(directory, LEGACY_INDEX_FILE);
    const legacyBackupPath = join(directory, LEGACY_INDEX_BACKUP_FILE);
    const legacyPrimary = await readJson<LegacyAssetIndex>(legacyPrimaryPath);
    const legacyBackup = legacyPrimary ? null : await readJson<LegacyAssetIndex>(legacyBackupPath);
    const legacy = legacyPrimary?.schemaVersion === 1
      ? legacyPrimary
      : legacyBackup?.schemaVersion === 1 ? legacyBackup : null;
    const index = manifest?.schemaVersion === 2 && manifest.assets
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
    };
    this.#records.set(record.projectId, record);
    return record;
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
    for (const [id, asset] of Object.entries(manifest.assets || {})) {
      const localPath = manifestLocalPath(asset.file?.path);
      const present = Boolean(localPath && asset.file?.present);
      const state = asset.state === "remote-only" ? "indexed" : asset.state;
      entries[id] = {
        id,
        name: asset.name,
        type: asset.type,
        remotePath: asset.folder ? asset.folder.split("/").filter(Boolean) : [],
        localPath,
        filename: asset.file?.filename || null,
        remoteFileSize: asset.file?.size ?? null,
        remoteFileHash: asset.file?.hash.remote || null,
        localHash: present ? asset.file?.hash.local || null : null,
        lastSyncedHash: asset.file?.hash.base || null,
        legacyLastSyncedSha256: syncState?.entries?.[id]?.legacyLastSyncedSha256,
        pendingRemoteHash: syncState?.entries?.[id]?.pendingRemoteHash,
        localFileSize: syncState?.entries?.[id]?.localFileSize,
        localMtimeMs: syncState?.entries?.[id]?.localMtimeMs,
        downloaded: present,
        status: state,
        error: asset.error,
      };
    }
    return {
      schemaVersion: 2,
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
        remotePath: old.remotePath || [],
        localPath,
        filename: old.filename || null,
        remoteFileSize: old.remoteFileSize ?? null,
        remoteFileHash: old.remoteFileHash || null,
        localHash,
        lastSyncedHash: migratedBase,
        legacyLastSyncedSha256: migratedBase ? undefined : old.lastSyncedHash || undefined,
        pendingRemoteHash: old.pendingRemoteHash,
        localFileSize: old.localFileSize,
        localMtimeMs: old.localMtimeMs,
        downloaded: Boolean(localContent),
        status: old.status,
        error: old.error,
      };
    }
    return {
      schemaVersion: 2,
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
      const asset: ManifestAsset = {
        id: entry.id,
        name: entry.name,
        type: entry.type,
        folder: toPosixPath(entry.remotePath.join("/")),
        file: entry.localPath && entry.filename
          ? {
              filename: entry.filename,
              path: `assets/${toPosixPath(entry.localPath)}`,
              size: entry.remoteFileSize,
              present,
              hash: {
                algorithm: "md5",
                remote: entry.remoteFileHash,
                local: present ? entry.localHash : null,
                base: entry.lastSyncedHash,
                matches: entry.remoteFileHash && present && entry.localHash
                  ? entry.remoteFileHash === entry.localHash
                  : null,
              },
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
      schemaVersion: 2,
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
    const folderAssets = assets
      .filter((asset) => asset.type === "folder")
      .sort((left, right) => (left.path?.length || 0) - (right.path?.length || 0));
    const folderPaths = new Map<string, string[]>();
    const usedNames = new Map<string, Set<string>>();

    const allocateName = (parent: string[], rawName: string, id: string) => {
      const parentKey = parent.join("/").toLocaleLowerCase();
      const used = usedNames.get(parentKey) || new Set<string>();
      const safe = safeAssetName(rawName, `asset-${id}`);
      const key = safe.toLocaleLowerCase();
      const selected = used.has(key) ? collisionName(safe, id) : safe;
      used.add(selected.toLocaleLowerCase());
      usedNames.set(parentKey, used);
      return selected;
    };

    for (const folder of folderAssets) {
      const parentIds = (folder.path || []).map(String);
      const parent = parentIds.length ? folderPaths.get(parentIds[parentIds.length - 1]) || [] : [];
      const name = allocateName(parent, folder.name, String(folder.id));
      const path = [...parent, name];
      folderPaths.set(String(folder.id), path);
      await mkdir(this.#assetPath(record, join(...path)), { recursive: true });
    }

    const previous = record.index.entries;
    const next: Record<string, AssetIndexEntry> = {};
    for (const asset of assets) {
      const id = String(asset.id);
      const parentIds = (asset.path || []).map(String);
      const parent = parentIds.length ? folderPaths.get(parentIds[parentIds.length - 1]) || [] : [];
      if (asset.type === "folder") {
        next[id] = {
          id,
          name: asset.name,
          type: asset.type,
          remotePath: folderPaths.get(id) || parent,
          localPath: null,
          filename: null,
          remoteFileSize: null,
          remoteFileHash: null,
          localHash: null,
          lastSyncedHash: null,
          localFileSize: undefined,
          localMtimeMs: undefined,
          downloaded: false,
          status: "indexed",
        };
        continue;
      }

      const remoteFilename = asset.file?.filename || (asset.type === "script" ? asset.name : null);
      const localName = remoteFilename ? allocateName(parent, remoteFilename, id) : null;
      const localPath = localName ? join(...parent, localName) : null;
      const old = previous[id];
      const entry: AssetIndexEntry = {
        id,
        name: asset.name,
        type: asset.type,
        remotePath: parent,
        localPath,
        filename: remoteFilename,
        remoteFileSize: asset.file?.size ?? null,
        remoteFileHash: asset.file?.hash || null,
        localHash: old?.localHash || null,
        lastSyncedHash: old?.lastSyncedHash || null,
        legacyLastSyncedSha256: old?.legacyLastSyncedSha256,
        pendingRemoteHash: old?.pendingRemoteHash,
        localFileSize: old?.localFileSize,
        localMtimeMs: old?.localMtimeMs,
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
      if (asset.type === "script" && localPath) {
        await this.#reconcileScript(record, entry, old, force);
      } else if (localPath) {
        await this.#reconcileBinary(record, entry, old);
      }
      if (asset.file && record.syncProgress) record.syncProgress.completed += 1;
    }

    const deletionBatch = new Date().toISOString().replaceAll(":", "-");
    for (const [id, old] of Object.entries(previous)) {
      if (next[id] || !old.localPath || !existsSync(this.#assetPath(record, old.localPath))) continue;
      const source = this.#assetPath(record, old.localPath);
      const destination = join(
        record.tmpDirectory,
        "trash",
        "remote",
        deletionBatch,
        `${id}-${safeWorkspaceName(basename(old.localPath), `asset-${id}`)}`,
      );
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
    }

    const obsoleteFolders = Object.entries(previous)
      .filter(([id, old]) =>
        old.type === "folder" &&
        (!next[id] || next[id].remotePath.join("/") !== old.remotePath.join("/")),
      )
      .map(([, old]) => old.remotePath)
      .sort((left, right) => right.length - left.length);
    for (const folder of obsoleteFolders) {
      if (!folder.length) continue;
      await rmdir(this.#assetPath(record, join(...folder))).catch(() => undefined);
    }

    record.index = {
      schemaVersion: 2,
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

  async #readRemoteAsset(
    record: ProjectRecord,
    entry: AssetIndexEntry,
  ): Promise<{ content: Buffer; hash: string }> {
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
    const hash = hashContent(content);
    if (entry.remoteFileHash && entry.remoteFileHash !== hash) {
      throw new Error(
        `Asset ${entry.id} changed while it was being downloaded: ` +
        `expected ${entry.remoteFileHash}, received ${hash}.`,
      );
    }
    entry.remoteFileHash = hash;
    return { content, hash };
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
    const remote = await this.#readRemoteAsset(record, entry);
    const path = this.#assetPath(record, entry.localPath);
    await atomicWrite(path, remote.content);
    await this.#recordLocalFile(record, entry, remote.hash);
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

  async #reconcileBinary(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old: AssetIndexEntry | undefined,
  ): Promise<void> {
    const local = await this.#localFileSnapshot(record, entry, old);
    const baseline = old?.lastSyncedHash || null;
    const advertisedRemoteHash = entry.remoteFileHash;
    if (!local) {
      await this.#downloadAsset(record, entry);
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
    if (advertisedRemoteHash && advertisedRemoteHash !== remoteHash) {
      entry.localHash = localHash;
      entry.status = "error";
      entry.error =
        `Remote script ${entry.id} changed while it was being read: ` +
        `expected ${advertisedRemoteHash}, received ${remoteHash}.`;
      return;
    }
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
