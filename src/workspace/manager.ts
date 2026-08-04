import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Envelope, JsonValue, TargetInfo } from "../shared/protocol.js";

const PROJECT_FILE = "pcbridge.project.json";
const INDEX_FILE = join(".pcbridge", "asset-index.json");
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

type WorkspaceSnapshot = {
  assets: RemoteAsset[];
};

type AssetIndexEntry = {
  id: string;
  name: string;
  type: string;
  remotePath: string[];
  localPath: string | null;
  filename: string | null;
  remoteFileHash: string | null;
  localHash: string | null;
  lastSyncedHash: string | null;
  downloaded: boolean;
  status: "indexed" | "synced" | "local-change" | "conflict" | "error";
  error?: string;
};

type AssetIndex = {
  schemaVersion: 1;
  projectId: string;
  branchId: string | null;
  updatedAt: string;
  entries: Record<string, AssetIndexEntry>;
};

type ProjectManifest = {
  schemaVersion: 1;
  project: { id: string; name: string };
  activeBranch: { id: string | null; name: string | null };
  scenes: Array<{ id: string; name: string | null }>;
  workspace: { createdAt: string; updatedAt: string };
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
  connected: boolean;
  state: "initializing" | "syncing" | "synced" | "local-change" | "conflict" | "error";
  lastSyncedAt: string | null;
  lastError: string | null;
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
  return createHash("sha256").update(value).digest("hex");
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
    record.connected = true;
    record.projectName = info.projectName;
    record.branchName = info.branchName || record.branchName;
    await this.#writeManifest(record, info);
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
    record.connected = true;
    await this.#sync(record, true);
    return this.#status(record);
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

    const response = await this.#requestTarget(
      info.id,
      "bridge:readAssetFile",
      { assetId },
      120000,
    );
    if (!response.ok) throw new Error(response.error.message);
    const data = asObject(response.data);
    const base64 = typeof data.base64 === "string" ? data.base64 : "";
    if (!base64) throw new Error(`Asset ${assetId} returned no file data.`);
    const path = this.#assetPath(record, entry.localPath);
    await atomicWrite(path, Buffer.from(base64, "base64"));
    entry.downloaded = true;
    entry.localHash = hashContent(await readFile(path));
    entry.status = "synced";
    await this.#writeIndex(record);
    return {
      assetId,
      path,
      size: Buffer.byteLength(base64, "base64"),
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
    await mkdir(join(directory, ".pcbridge"), { recursive: true });

    const stored = await readJson<AssetIndex>(join(directory, INDEX_FILE));
    const index: AssetIndex = stored?.schemaVersion === 1
      ? stored
      : {
          schemaVersion: 1,
          projectId: info.projectId || "",
          branchId: info.branchId || null,
          updatedAt: new Date().toISOString(),
          entries: {},
        };
    const record: ProjectRecord = {
      projectId: info.projectId || "",
      projectName: info.projectName || "Project",
      branchId: info.branchId || index.branchId || null,
      branchName: info.branchName || null,
      directory,
      assetsDirectory,
      tmpDirectory,
      targetId: info.id,
      connected: true,
      state: "initializing",
      lastSyncedAt: null,
      lastError: null,
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

  async #writeManifest(record: ProjectRecord, info: TargetInfo): Promise<void> {
    const path = join(record.directory, PROJECT_FILE);
    const existing = await readJson<ProjectManifest>(path);
    const scenes = existing?.scenes || [];
    if (info.sceneId) {
      const scene = scenes.find((item) => item.id === info.sceneId);
      if (scene) scene.name = info.sceneName || scene.name;
      else scenes.push({ id: info.sceneId, name: info.sceneName || null });
    }
    const now = new Date().toISOString();
    const manifest: ProjectManifest = {
      schemaVersion: 1,
      project: { id: record.projectId, name: record.projectName },
      activeBranch: { id: record.branchId, name: record.branchName },
      scenes,
      workspace: {
        createdAt: existing?.workspace?.createdAt || now,
        updatedAt: now,
      },
    };
    await atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async #writeIndex(record: ProjectRecord): Promise<void> {
    record.index.updatedAt = new Date().toISOString();
    await atomicWrite(
      join(record.directory, INDEX_FILE),
      `${JSON.stringify(record.index, null, 2)}\n`,
    );
  }

  async #sync(record: ProjectRecord, force: boolean): Promise<void> {
    if (record.syncPromise) return record.syncPromise;
    record.syncPromise = this.#performSync(record, force).finally(() => {
      record.syncPromise = null;
    });
    return record.syncPromise;
  }

  async #performSync(record: ProjectRecord, force: boolean): Promise<void> {
    record.state = "syncing";
    record.lastError = null;
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
      await this.#applySnapshot(record, assets, force);
      record.lastSyncedAt = new Date().toISOString();
      const entries = Object.values(record.index.entries);
      record.state = entries.some((entry) => entry.status === "conflict")
        ? "conflict"
        : entries.some((entry) => entry.status === "local-change")
          ? "local-change"
          : entries.some((entry) => entry.status === "error")
            ? "error"
            : "synced";
      await this.#writeIndex(record);
    } catch (error) {
      record.state = "error";
      record.lastError = error instanceof Error ? error.message : String(error);
    }
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
          remoteFileHash: null,
          localHash: null,
          lastSyncedHash: null,
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
        remoteFileHash: asset.file?.hash || null,
        localHash: old?.localHash || null,
        lastSyncedHash: old?.lastSyncedHash || null,
        downloaded: old?.downloaded || false,
        status: old?.status || "indexed",
        error: old?.error,
      };
      next[id] = entry;

      if (old?.localPath && localPath && old.localPath !== localPath && existsSync(this.#assetPath(record, old.localPath))) {
        const oldPath = this.#assetPath(record, old.localPath);
        const newPath = this.#assetPath(record, localPath);
        await mkdir(dirname(newPath), { recursive: true });
        if (!existsSync(newPath)) await rename(oldPath, newPath);
      }
      if (asset.type === "script" && localPath) {
        await this.#reconcileScript(record, entry, old, force);
      }
    }

    for (const [id, old] of Object.entries(previous)) {
      if (next[id] || !old.localPath || !existsSync(this.#assetPath(record, old.localPath))) continue;
      const source = this.#assetPath(record, old.localPath);
      const destination = join(
        record.tmpDirectory,
        "conflicts",
        `remote-deleted-${id}-${safeWorkspaceName(basename(old.localPath), `asset-${id}`)}`,
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
      schemaVersion: 1,
      projectId: record.projectId,
      branchId: record.branchId,
      updatedAt: new Date().toISOString(),
      entries: next,
    };
  }

  async #reconcileScript(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    old: AssetIndexEntry | undefined,
    force: boolean,
  ): Promise<void> {
    if (!entry.localPath) return;
    const path = this.#assetPath(record, entry.localPath);
    const localContent = existsSync(path) ? await readFile(path, "utf8") : null;
    const localHash = localContent === null ? null : hashContent(localContent);
    const baseline = old?.lastSyncedHash || null;
    const localChanged = localHash !== null && localHash !== baseline;
    const remoteMetadataChanged = !old || old.remoteFileHash !== entry.remoteFileHash;
    if (!force && localContent !== null && !localChanged && !remoteMetadataChanged) {
      entry.localHash = localHash;
      entry.lastSyncedHash = baseline;
      entry.downloaded = true;
      entry.status = "synced";
      return;
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

    if (localContent === null || localHash === baseline) {
      await atomicWrite(path, remoteContent);
      entry.localHash = remoteHash;
      entry.lastSyncedHash = remoteHash;
      entry.downloaded = true;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    if (!baseline) {
      if (localHash === remoteHash) {
        entry.localHash = localHash;
        entry.lastSyncedHash = localHash;
        entry.downloaded = true;
        entry.status = "synced";
      } else {
        await this.#writeConflict(record, entry, localContent, remoteContent);
      }
      return;
    }

    if (remoteHash === baseline || remoteHash === localHash) {
      if (remoteHash !== localHash) {
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
      }
      entry.localHash = localHash;
      entry.lastSyncedHash = localHash;
      entry.downloaded = true;
      entry.status = "synced";
      delete entry.error;
      return;
    }

    await this.#writeConflict(record, entry, localContent, remoteContent);
  }

  async #writeConflict(
    record: ProjectRecord,
    entry: AssetIndexEntry,
    localContent: string,
    remoteContent: string,
  ): Promise<void> {
    const conflictBase = join(
      record.tmpDirectory,
      "conflicts",
      `${entry.id}-${safeWorkspaceName(entry.filename || entry.name, `script-${entry.id}`)}`,
    );
    await atomicWrite(`${conflictBase}.local`, localContent);
    await atomicWrite(`${conflictBase}.remote`, remoteContent);
    entry.localHash = hashContent(localContent);
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
      counts: {
        assets: entries.filter((entry) => entry.type !== "folder").length,
        folders: entries.filter((entry) => entry.type === "folder").length,
        scripts: scripts.length,
        scriptsSynced: scripts.filter((entry) => entry.status === "synced").length,
        localChanges: scripts.filter((entry) => entry.status === "local-change").length,
        conflicts: entries.filter((entry) => entry.status === "conflict").length,
        lazyAssets: downloadable.filter((entry) => !entry.downloaded).length,
        downloadedAssets: downloadable.filter((entry) => entry.downloaded).length,
      },
    };
  }
}
