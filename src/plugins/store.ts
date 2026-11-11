import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { x as extractTar } from "tar";
import { copyDir, findPackageRoot } from "../config.js";

export const PLUGIN_MANIFEST = "pcbridge-plugin.json";
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
  description?: string;
  node?: string;
  page?: { editor?: string; launch?: string };
  actions?: Record<string, { description?: string; params?: Record<string, string> }>;
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

export function summarizePlugin(plugin: InstalledPlugin): PluginSummary {
  const manifest = plugin.manifest;
  return {
    id: plugin.id,
    name: manifest?.name || plugin.id,
    version: manifest?.version || null,
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

  constructor(rootDir: string, options: { fetch?: typeof fetch; officialDir?: string } = {}) {
    this.rootDir = rootDir;
    this.#fetch = options.fetch || fetch;
    this.#officialDir = options.officialDir;
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

  async get(id: string): Promise<InstalledPlugin> {
    const record = (await this.#records())[id];
    if (!record) throw new PluginError("PLUGIN_NOT_FOUND", `Plugin ${id} is not installed.`);
    return this.#describe(id, record);
  }

  async available(): Promise<AvailablePlugin[]> {
    const official = await this.#official();
    if (!existsSync(official)) return [];
    const records = await this.#records();
    const result: AvailablePlugin[] = [];
    for (const entry of await readdir(official, { withFileTypes: true })) {
      if (!entry.isDirectory() || records[entry.name]) continue;
      const manifest = await readPluginManifest(join(official, entry.name));
      result.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description || "",
        source: entry.name,
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
    const from = source.type === "official" ? join(await this.#official(), source.name) : source.path;
    if (!existsSync(join(from, PLUGIN_MANIFEST))) {
      throw new PluginError(
        "PLUGIN_SOURCE_NOT_FOUND",
        source.type === "official"
          ? `No official plugin named ${source.name}. Use an absolute or ./relative path for a local directory.`
          : `${from} does not contain ${PLUGIN_MANIFEST}.`,
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
