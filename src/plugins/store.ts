import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { x as extractTar } from "tar";
import {
  compareSemver,
  CONFIG_DIR,
  copyDir,
  DEFAULT_PCBRIDGE_REF,
  DEFAULT_PCBRIDGE_REPOSITORY,
  findPackageRoot,
  VERSION,
} from "../config.js";

export const PLUGIN_MANIFEST = "pcbridge-plugin.json";
export const PLUGIN_CATALOG_FILE = "index.json";
export const PLUGIN_API_VERSION = 1;
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

export class PluginError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  minPcbridgeVersion?: string;
  description?: string;
  node?: string;
  page?: { editor?: string; launch?: string };
  actions?: Record<string, { description?: string; params?: Record<string, string> }>;
};

export type OfficialPluginCatalogEntry = {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  minPcbridgeVersion?: string;
  description: string;
  subdir: string;
  repo?: string;
  ref?: string;
};

export type PluginSource =
  | { type: "official"; name: string }
  | { type: "directory"; path: string }
  | { type: "link"; path: string }
  | { type: "github"; repo: string; subdir: string; ref: string };

type PluginRecord = {
  enabled: boolean;
  source: PluginSource;
  installedAt: string;
};

export type InstalledPlugin = PluginRecord & {
  id: string;
  path: string;
  manifest: PluginManifest | null;
  error: string | null;
};

export type PluginSummary = {
  id: string;
  name: string;
  version: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  compatible: boolean;
  minPcbridgeVersion: string | null;
  description: string;
  enabled: boolean;
  state: "active" | "stopped" | "disabled" | "error";
  error: string | null;
  source: PluginSource;
  path: string;
  runtimes: { node: boolean; editor: boolean; launch: boolean };
  actions: NonNullable<PluginManifest["actions"]>;
};

export type AvailablePlugin = {
  id: string;
  name: string;
  version: string;
  minPcbridgeVersion: string | null;
  compatible: boolean;
  description: string;
  source: string;
};

function invalid(message: string): PluginError {
  return new PluginError("PLUGIN_MANIFEST_INVALID", message);
}

function requireEntry(directory: string, value: unknown, label: string): void {
  if (typeof value !== "string" || !value) throw invalid(`${label} must be a relative file path.`);
  const file = resolve(directory, value);
  if (!file.startsWith(`${resolve(directory)}${sep}`)) {
    throw invalid(`${label} must stay inside the plugin directory.`);
  }
  if (!existsSync(file)) throw invalid(`${label} file does not exist: ${value}`);
}

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, PLUGIN_MANIFEST), "utf8")) as PluginManifest;
  } catch (error) {
    throw invalid(`Cannot read ${PLUGIN_MANIFEST} in ${directory}: ${String(error)}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalid(`${PLUGIN_MANIFEST} must be a JSON object.`);
  }
  if (typeof manifest.id !== "string" || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    throw invalid("id must be 2-49 characters of lowercase letters, digits, and hyphens.");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) throw invalid("name is required.");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw invalid("version must be a semantic version such as 1.0.0.");
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw invalid(`apiVersion ${String(manifest.apiVersion)} is not supported; this pcbridge supports ${PLUGIN_API_VERSION}.`);
  }
  if (
    manifest.minPcbridgeVersion !== undefined &&
    (typeof manifest.minPcbridgeVersion !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.minPcbridgeVersion))
  ) {
    throw invalid("minPcbridgeVersion must be a semantic version such as 0.7.0.");
  }
  const page = manifest.page;
  if (page !== undefined && (!page || typeof page !== "object" || Array.isArray(page))) {
    throw invalid("page must be an object with editor and/or launch entries.");
  }
  if (manifest.node === undefined && page?.editor === undefined && page?.launch === undefined) {
    throw invalid("At least one of node, page.editor, or page.launch is required.");
  }
  if (manifest.node !== undefined) requireEntry(directory, manifest.node, "node");
  if (page?.editor !== undefined) requireEntry(directory, page.editor, "page.editor");
  if (page?.launch !== undefined) requireEntry(directory, page.launch, "page.launch");
  const actions = manifest.actions;
  if (actions !== undefined && (!actions || typeof actions !== "object" || Array.isArray(actions))) {
    throw invalid("actions must be an object keyed by action name.");
  }
  return manifest;
}

export function isPluginCompatible(
  item: { apiVersion?: number; minPcbridgeVersion?: string | null },
  hostVersion = VERSION,
): boolean {
  if (item.apiVersion !== undefined && item.apiVersion !== PLUGIN_API_VERSION) {
    return false;
  }
  if (item.minPcbridgeVersion && compareSemver(hostVersion, item.minPcbridgeVersion) < 0) {
    return false;
  }
  return true;
}

function assertPluginCompatible(
  item: { id: string; version: string; apiVersion?: number; minPcbridgeVersion?: string | null },
  hostVersion = VERSION,
): void {
  if (item.apiVersion !== undefined && item.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginError(
      "PLUGIN_MANIFEST_INVALID",
      `apiVersion ${String(item.apiVersion)} is not supported; this pcbridge supports ${PLUGIN_API_VERSION}.`,
    );
  }
  if (item.minPcbridgeVersion && compareSemver(hostVersion, item.minPcbridgeVersion) < 0) {
    throw new PluginError(
      "PLUGIN_REQUIRES_NEWER_PCBRIDGE",
      `Plugin ${item.id} v${item.version} requires pcbridge v${item.minPcbridgeVersion} or newer (current v${hostVersion}). Run pcbridge update first.`,
    );
  }
}

export function parsePluginSource(value: string, link = false): PluginSource {
  const github = value.match(/^github:([\w.-]+\/[\w.-]+)((?:\/[^#]+)?)(?:#([\w./-]+))?$/);
  let source: PluginSource;
  if (github) {
    source = {
      type: "github",
      repo: github[1],
      subdir: github[2].split("/").filter(Boolean).join("/"),
      ref: github[3] || "HEAD",
    };
  } else if (PLUGIN_ID_PATTERN.test(value)) {
    source = { type: "official", name: value };
  } else if (isAbsolute(value)) {
    source = { type: link ? "link" : "directory", path: resolve(value) };
  } else {
    throw new PluginError(
      "PLUGIN_SOURCE_INVALID",
      "Plugin source must be an official plugin name, github:owner/repo[/subdir][#ref], or an absolute directory path.",
    );
  }
  if (link && source.type !== "link") {
    throw new PluginError("PLUGIN_SOURCE_INVALID", "--link requires a local plugin directory.");
  }
  return source;
}

export function summarizePlugin(
  plugin: InstalledPlugin,
  catalog?: Map<string, OfficialPluginCatalogEntry>,
): PluginSummary {
  const manifest = plugin.manifest;
  const currentVersion = manifest?.version || null;
  const officialEntry = plugin.source.type === "official"
    ? catalog?.get(plugin.source.name) || catalog?.get(plugin.id)
    : undefined;
  const latestVersion = officialEntry?.version || currentVersion;
  const minPcbridgeVersion =
    officialEntry?.minPcbridgeVersion || manifest?.minPcbridgeVersion || null;
  const compatible = isPluginCompatible({
    apiVersion: officialEntry?.apiVersion ?? manifest?.apiVersion,
    minPcbridgeVersion,
  });
  const updateAvailable = Boolean(
    currentVersion &&
      latestVersion &&
      compareSemver(latestVersion, currentVersion) > 0,
  );
  return {
    id: plugin.id,
    name: manifest?.name || plugin.id,
    version: currentVersion,
    latestVersion,
    updateAvailable,
    compatible,
    minPcbridgeVersion,
    description: manifest?.description || "",
    enabled: plugin.enabled,
    state: plugin.error ? "error" : plugin.enabled ? "stopped" : "disabled",
    error: plugin.error,
    source: plugin.source,
    path: plugin.path,
    runtimes: {
      node: Boolean(manifest?.node),
      editor: Boolean(manifest?.page?.editor),
      launch: Boolean(manifest?.page?.launch),
    },
    actions: manifest?.actions || {},
  };
}

function runBunInstall(directory: string): Promise<void> {
  return new Promise((resolveInstall, reject) => {
    const child = spawn(process.execPath, ["install", "--production"], {
      cwd: directory,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveInstall();
      else reject(new PluginError("PLUGIN_INSTALL_FAILED", `bun install failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

async function installDependencies(directory: string): Promise<void> {
  const packagePath = join(directory, "package.json");
  if (!existsSync(packagePath)) return;
  const dependencies = (JSON.parse(await readFile(packagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  }).dependencies;
  if (dependencies && Object.keys(dependencies).length > 0) await runBunInstall(directory);
}

export class PluginStore {
  readonly rootDir: string;
  #fetch: typeof fetch;
  #officialDir: string | undefined;
  #hasCustomOfficialDir: boolean;
  #remoteCatalogUrl: string | null | undefined;
  #repo: string;
  #ref: string;
  #catalogCache: { at: number; entries: Map<string, OfficialPluginCatalogEntry> } | null = null;

  constructor(
    rootDir: string,
    options: {
      fetch?: typeof fetch;
      officialDir?: string;
      remoteCatalogUrl?: string | null;
      repo?: string;
      ref?: string;
    } = {},
  ) {
    this.rootDir = rootDir;
    this.#fetch = options.fetch || fetch;
    this.#officialDir = options.officialDir;
    this.#hasCustomOfficialDir = Boolean(options.officialDir);
    this.#remoteCatalogUrl = options.remoteCatalogUrl;
    this.#repo = options.repo || DEFAULT_PCBRIDGE_REPOSITORY;
    this.#ref = options.ref || DEFAULT_PCBRIDGE_REF;
  }

  get #registryPath(): string {
    return join(this.rootDir, "plugins.json");
  }

  get #installedDir(): string {
    return join(this.rootDir, "installed");
  }

  async #records(): Promise<Record<string, PluginRecord>> {
    if (!existsSync(this.#registryPath)) return {};
    return (JSON.parse(await readFile(this.#registryPath, "utf8")) as {
      plugins: Record<string, PluginRecord>;
    }).plugins;
  }

  async #save(plugins: Record<string, PluginRecord>): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.#registryPath, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`);
  }

  async #official(): Promise<string> {
    this.#officialDir ||= join(await findPackageRoot(), "plugins");
    return this.#officialDir;
  }

  #resolvedRemoteCatalogUrl(): string | null {
    if (this.#remoteCatalogUrl !== undefined) return this.#remoteCatalogUrl;
    if (process.env.PCBRIDGE_PLUGINS_INDEX_URL !== undefined) {
      return process.env.PCBRIDGE_PLUGINS_INDEX_URL || null;
    }
    if (this.#hasCustomOfficialDir) return null;
    return `https://raw.githubusercontent.com/${this.#repo}/${this.#ref}/plugins/index.json`;
  }

  async #localCatalog(): Promise<Map<string, OfficialPluginCatalogEntry>> {
    const official = await this.#official();
    const entries = new Map<string, OfficialPluginCatalogEntry>();
    if (!existsSync(official)) return entries;

    const indexPath = join(official, PLUGIN_CATALOG_FILE);
    if (existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(await readFile(indexPath, "utf8")) as {
          schemaVersion?: number;
          plugins?: OfficialPluginCatalogEntry[];
        };
        if (Array.isArray(parsed.plugins)) {
          for (const item of parsed.plugins) {
            if (item && typeof item.id === "string" && typeof item.version === "string") {
              entries.set(item.id, {
                id: item.id,
                name: item.name || item.id,
                version: item.version,
                apiVersion: item.apiVersion ?? PLUGIN_API_VERSION,
                ...(item.minPcbridgeVersion ? { minPcbridgeVersion: item.minPcbridgeVersion } : {}),
                description: item.description || "",
                subdir: item.subdir || `plugins/${item.id}`,
                ...(item.repo ? { repo: item.repo } : {}),
                ...(item.ref ? { ref: item.ref } : {}),
              });
            }
          }
        }
      } catch {
        // Fall back to scanning directories below.
      }
    }

    for (const entry of await readdir(official, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const manifest = await readPluginManifest(join(official, entry.name));
        const existing = entries.get(manifest.id);
        if (!existing || compareSemver(manifest.version, existing.version) >= 0) {
          entries.set(manifest.id, {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            apiVersion: manifest.apiVersion,
            ...(manifest.minPcbridgeVersion ? { minPcbridgeVersion: manifest.minPcbridgeVersion } : {}),
            description: manifest.description || "",
            subdir: `plugins/${entry.name}`,
          });
        }
      } catch {
        // Ignore non-plugin folders.
      }
    }
    return entries;
  }

  async #cachedRemoteCatalogFromState(): Promise<OfficialPluginCatalogEntry[]> {
    const stateFile = join(dirname(this.rootDir), "update-state.json");
    if (!existsSync(stateFile)) return [];
    try {
      const parsed = JSON.parse(await readFile(stateFile, "utf8")) as {
        officialCatalog?: OfficialPluginCatalogEntry[];
      };
      if (Array.isArray(parsed.officialCatalog)) return parsed.officialCatalog;
    } catch {
      // Ignore unreadable state cache.
    }
    return [];
  }

  async #fetchRemoteCatalog(): Promise<OfficialPluginCatalogEntry[] | null> {
    const url = this.#resolvedRemoteCatalogUrl();
    if (!url) return null;
    try {
      const response = await this.#fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const parsed = (await response.json()) as {
        schemaVersion?: number;
        plugins?: OfficialPluginCatalogEntry[];
      };
      if (!parsed || !Array.isArray(parsed.plugins)) return null;
      return parsed.plugins.filter(
        (item): item is OfficialPluginCatalogEntry =>
          Boolean(
            item &&
              typeof item.id === "string" &&
              PLUGIN_ID_PATTERN.test(item.id) &&
              typeof item.name === "string" &&
              typeof item.version === "string" &&
              /^\d+\.\d+\.\d+/.test(item.version),
          ),
      );
    } catch {
      return null;
    }
  }

  async catalog(
    options: { refresh?: boolean; allowNetwork?: boolean } = {},
  ): Promise<Map<string, OfficialPluginCatalogEntry>> {
    const now = Date.now();
    if (!options.refresh && this.#catalogCache && now - this.#catalogCache.at < 60_000) {
      return new Map(this.#catalogCache.entries);
    }

    const merged = await this.#localCatalog();
    const mergeEntries = (items: OfficialPluginCatalogEntry[]) => {
      for (const item of items) {
        const current = merged.get(item.id);
        if (!current || compareSemver(item.version, current.version) >= 0) {
          merged.set(item.id, {
            id: item.id,
            name: item.name,
            version: item.version,
            apiVersion: item.apiVersion ?? PLUGIN_API_VERSION,
            ...(item.minPcbridgeVersion ? { minPcbridgeVersion: item.minPcbridgeVersion } : {}),
            description: item.description || "",
            subdir: item.subdir || `plugins/${item.id}`,
            ...(item.repo ? { repo: item.repo } : {}),
            ...(item.ref ? { ref: item.ref } : {}),
          });
        }
      }
    };

    const cachedStateEntries = await this.#cachedRemoteCatalogFromState();
    if (cachedStateEntries.length > 0) {
      mergeEntries(cachedStateEntries);
    }

    if (
      options.allowNetwork !== false &&
      (options.refresh || this.#remoteCatalogUrl !== undefined || process.env.PCBRIDGE_PLUGINS_INDEX_URL)
    ) {
      const remote = await this.#fetchRemoteCatalog();
      if (remote) mergeEntries(remote);
    }

    this.#catalogCache = { at: now, entries: new Map(merged) };
    return merged;
  }

  #directory(id: string, source: PluginSource): string {
    return source.type === "link" ? source.path : join(this.#installedDir, id);
  }

  async #describe(id: string, record: PluginRecord): Promise<InstalledPlugin> {
    const path = this.#directory(id, record.source);
    try {
      return { id, ...record, path, manifest: await readPluginManifest(path), error: null };
    } catch (error) {
      return { id, ...record, path, manifest: null, error: (error as Error).message };
    }
  }

  async list(): Promise<InstalledPlugin[]> {
    const records = await this.#records();
    return Promise.all(Object.entries(records).map(([id, record]) => this.#describe(id, record)));
  }

  async summaries(options: { refresh?: boolean; allowNetwork?: boolean } = {}): Promise<PluginSummary[]> {
    const [installed, catalog] = await Promise.all([
      this.list(),
      this.catalog(options),
    ]);
    return installed.map((plugin) => summarizePlugin(plugin, catalog));
  }

  async get(id: string): Promise<InstalledPlugin> {
    const record = (await this.#records())[id];
    if (!record) throw new PluginError("PLUGIN_NOT_FOUND", `Plugin ${id} is not installed.`);
    return this.#describe(id, record);
  }

  async available(options: { refresh?: boolean; allowNetwork?: boolean } = {}): Promise<AvailablePlugin[]> {
    const [records, catalog] = await Promise.all([
      this.#records(),
      this.catalog(options),
    ]);
    const result: AvailablePlugin[] = [];
    for (const [id, entry] of catalog.entries()) {
      if (records[id]) continue;
      const minPcbridgeVersion = entry.minPcbridgeVersion || null;
      result.push({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        minPcbridgeVersion,
        compatible: isPluginCompatible(entry),
        description: entry.description || "",
        source: entry.id,
      });
    }
    return result;
  }

  async #download(source: Extract<PluginSource, { type: "github" }>, staging: string): Promise<void> {
    const url = `https://codeload.github.com/${source.repo}/tar.gz/${source.ref}`;
    const response = await this.#fetch(url);
    if (!response.ok) {
      throw new PluginError("PLUGIN_DOWNLOAD_FAILED", `GitHub returned HTTP ${response.status} for ${url}.`);
    }
    const archive = `${staging}.tar.gz`;
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const segments = source.subdir ? source.subdir.split("/") : [];
    try {
      await extractTar({
        file: archive,
        cwd: staging,
        strip: 1 + segments.length,
        filter: (path) => segments.every((segment, index) => path.split("/")[index + 1] === segment),
      });
    } finally {
      await rm(archive, { force: true });
    }
  }

  async #stage(source: Exclude<PluginSource, { type: "link" }>, staging: string): Promise<void> {
    await mkdir(staging, { recursive: true });
    if (source.type === "github") {
      await this.#download(source, staging);
      if (!existsSync(join(staging, PLUGIN_MANIFEST))) {
        const location = `github:${source.repo}${source.subdir ? `/${source.subdir}` : ""}#${source.ref}`;
        throw new PluginError("PLUGIN_SOURCE_NOT_FOUND", `${location} does not contain ${PLUGIN_MANIFEST}.`);
      }
      return;
    }
    if (source.type === "official") {
      const localDir = join(await this.#official(), source.name);
      const hasLocal = existsSync(join(localDir, PLUGIN_MANIFEST));
      const localManifest = hasLocal ? await readPluginManifest(localDir) : null;
      const catalog = await this.catalog({ refresh: true });
      const remoteEntry = catalog.get(source.name);

      if (remoteEntry) {
        assertPluginCompatible(remoteEntry);
      }

      const needsRemoteDownload = Boolean(
        remoteEntry &&
          (!localManifest || compareSemver(remoteEntry.version, localManifest.version) > 0),
      );

      if (needsRemoteDownload && remoteEntry) {
        await this.#download(
          {
            type: "github",
            repo: remoteEntry.repo || this.#repo,
            subdir: remoteEntry.subdir || `plugins/${source.name}`,
            ref: remoteEntry.ref || this.#ref,
          },
          staging,
        );
        if (!existsSync(join(staging, PLUGIN_MANIFEST))) {
          throw new PluginError(
            "PLUGIN_SOURCE_NOT_FOUND",
            `Remote official plugin ${source.name} does not contain ${PLUGIN_MANIFEST}.`,
          );
        }
        return;
      }

      if (!hasLocal) {
        throw new PluginError(
          "PLUGIN_SOURCE_NOT_FOUND",
          `No official plugin named ${source.name}. Use an absolute or ./relative path for a local directory.`,
        );
      }
      await copyDir(localDir, staging, { ignore: new Set(["node_modules", ".git"]) });
      return;
    }

    const from = source.path;
    if (!existsSync(join(from, PLUGIN_MANIFEST))) {
      throw new PluginError(
        "PLUGIN_SOURCE_NOT_FOUND",
        `${from} does not contain ${PLUGIN_MANIFEST}.`,
      );
    }
    await copyDir(from, staging, { ignore: new Set(["node_modules", ".git"]) });
  }

  async #install(source: PluginSource, expectedId?: string): Promise<PluginManifest> {
    const records = await this.#records();
    const check = (manifest: PluginManifest) => {
      if (expectedId && manifest.id !== expectedId) {
        throw new PluginError("PLUGIN_ID_MISMATCH", `Source now provides plugin ${manifest.id}, not ${expectedId}.`);
      }
      if (!expectedId && records[manifest.id]) {
        throw new PluginError(
          "PLUGIN_EXISTS",
          `Plugin ${manifest.id} is already installed. Use plugin update ${manifest.id} or remove it first.`,
        );
      }
      assertPluginCompatible(manifest);
    };
    if (source.type === "link") {
      const manifest = await readPluginManifest(source.path);
      check(manifest);
      return manifest;
    }
    const staging = join(this.#installedDir, `.staging-${randomUUID()}`);
    try {
      await this.#stage(source, staging);
      const manifest = await readPluginManifest(staging);
      check(manifest);
      await installDependencies(staging);
      const destination = join(this.#installedDir, manifest.id);
      await rm(destination, { force: true, recursive: true });
      await rename(staging, destination);
      return manifest;
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
  }

  async add(source: PluginSource): Promise<InstalledPlugin> {
    const manifest = await this.#install(source);
    const record = { enabled: true, source, installedAt: new Date().toISOString() };
    await this.#save({ ...(await this.#records()), [manifest.id]: record });
    return this.#describe(manifest.id, record);
  }

  async update(id: string): Promise<{ previousVersion: string | null; version: string }> {
    const current = await this.get(id);
    const manifest = await this.#install(current.source, id);
    return { previousVersion: current.manifest?.version || null, version: manifest.version };
  }

  async updateAll(): Promise<{
    updated: Array<{ id: string; previousVersion: string | null; version: string }>;
    skipped: Array<{ id: string; reason: string }>;
  }> {
    const summaries = await this.summaries({ refresh: true });
    const updated: Array<{ id: string; previousVersion: string | null; version: string }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const item of summaries) {
      if (item.source.type === "link") {
        skipped.push({ id: item.id, reason: "Linked development plugin; use plugin reload." });
        continue;
      }
      if (!item.compatible) {
        skipped.push({
          id: item.id,
          reason: item.minPcbridgeVersion
            ? `Requires pcbridge v${item.minPcbridgeVersion} or newer.`
            : "Incompatible plugin apiVersion.",
        });
        continue;
      }
      if (item.source.type === "official" && !item.updateAvailable) {
        continue;
      }
      const result = await this.update(item.id);
      if (result.previousVersion !== result.version || item.source.type !== "official") {
        updated.push({ id: item.id, ...result });
      }
    }
    return { updated, skipped };
  }

  async remove(id: string): Promise<void> {
    const records = await this.#records();
    const record = records[id];
    if (!record) throw new PluginError("PLUGIN_NOT_FOUND", `Plugin ${id} is not installed.`);
    if (record.source.type !== "link") {
      await rm(join(this.#installedDir, id), { force: true, recursive: true });
    }
    delete records[id];
    await this.#save(records);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const records = await this.#records();
    if (!records[id]) throw new PluginError("PLUGIN_NOT_FOUND", `Plugin ${id} is not installed.`);
    records[id].enabled = enabled;
    await this.#save(records);
  }
}
