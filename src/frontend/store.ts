import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { t as inspectTar, x as extractTar } from "tar";
import {
  CONFIG_DIR,
  DEFAULT_FRONTEND_REPOSITORY,
  VERSION,
} from "../config.js";

const RELEASE_PATTERN = /^playcanvas-editor-v\d+\.\d+\.\d+-r\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const MAX_ARCHIVE_SIZE = 250 * 1024 * 1024;
const MAX_EXTRACTED_SIZE = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const REQUIRED_FILES = [
  "dist/js/editor.js",
  "dist/js/editor-empty.js",
  "dist/js/code-editor.js",
  "dist/js/launch.js",
  "dist/css/editor.css",
  "dist/css/code-editor.css",
  "dist/css/launch.css",
];

export type FrontendReleaseManifest = {
  schemaVersion: 1;
  release: string;
  editorVersion: string;
  sourceRepository: string;
  sourceCommit: string;
  archive: {
    name: string;
    url: string;
    sha256: string;
    size: number;
  };
  builtAt: string;
  minPcbridgeVersion: string;
};

export type FrontendState = {
  activeRelease: string | null;
  updatedAt: string;
};

export type InstalledFrontend = {
  release: string;
  editorVersion: string;
  sourceCommit: string;
  builtAt: string;
  path: string;
  active: boolean;
};

export type FrontendStatus = {
  ready: boolean;
  activeRelease: string | null;
  activePath: string | null;
  installed: InstalledFrontend[];
};

type FrontendStoreOptions = {
  rootDir?: string;
  fetch?: typeof fetch;
};

export class FrontendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FrontendError";
    this.code = code;
  }
}

function storePaths(rootDir = CONFIG_DIR) {
  const frontendsDir = join(rootDir, "frontends");
  return {
    rootDir,
    frontendsDir,
    stateFile: join(rootDir, "frontend-state.json"),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertReleaseName(release: string): void {
  if (!RELEASE_PATTERN.test(release)) {
    throw new FrontendError(
      "INVALID_FRONTEND_RELEASE",
      `Invalid frontend release name: ${release}`,
    );
  }
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", `Invalid version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function validateFrontendManifest(value: unknown): FrontendReleaseManifest {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Unsupported frontend manifest.");
  }

  const archive = value.archive;
  if (!isObject(archive)) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend archive metadata is missing.");
  }

  const manifest = value as unknown as FrontendReleaseManifest;
  assertReleaseName(manifest.release);

  if (
    typeof manifest.editorVersion !== "string" ||
    typeof manifest.sourceRepository !== "string" ||
    typeof manifest.sourceCommit !== "string" ||
    typeof manifest.builtAt !== "string" ||
    typeof manifest.minPcbridgeVersion !== "string" ||
    typeof manifest.archive.name !== "string" ||
    typeof manifest.archive.url !== "string" ||
    typeof manifest.archive.sha256 !== "string" ||
    typeof manifest.archive.size !== "number"
  ) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend manifest fields are invalid.");
  }

  parseVersion(manifest.editorVersion);
  parseVersion(manifest.minPcbridgeVersion);
  if (!manifest.release.startsWith(`playcanvas-editor-v${manifest.editorVersion}-r`)) {
    throw new FrontendError(
      "INVALID_FRONTEND_MANIFEST",
      "Frontend release name does not match the Editor version.",
    );
  }
  if (Number.isNaN(Date.parse(manifest.builtAt))) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend build time is invalid.");
  }

  if (manifest.sourceRepository !== DEFAULT_FRONTEND_REPOSITORY) {
    throw new FrontendError(
      "UNTRUSTED_FRONTEND_SOURCE",
      `Unexpected frontend repository: ${manifest.sourceRepository}`,
    );
  }
  if (!COMMIT_PATTERN.test(manifest.sourceCommit)) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend source commit is invalid.");
  }
  if (manifest.archive.name !== `${manifest.release}.tar.gz`) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend archive name is invalid.");
  }
  if (!SHA256_PATTERN.test(manifest.archive.sha256)) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend archive SHA-256 is invalid.");
  }
  if (
    !Number.isSafeInteger(manifest.archive.size) ||
    manifest.archive.size <= 0 ||
    manifest.archive.size > MAX_ARCHIVE_SIZE
  ) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend archive size is invalid.");
  }

  let archiveUrl: URL;
  try {
    archiveUrl = new URL(manifest.archive.url);
  } catch {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend archive URL is invalid.");
  }
  const expectedPath =
    `/${DEFAULT_FRONTEND_REPOSITORY}/releases/download/` +
    `${manifest.release}/${manifest.archive.name}`;
  if (
    archiveUrl.protocol !== "https:" ||
    archiveUrl.hostname !== "github.com" ||
    archiveUrl.pathname !== expectedPath ||
    archiveUrl.search ||
    archiveUrl.hash
  ) {
    throw new FrontendError("UNTRUSTED_FRONTEND_SOURCE", "Frontend archive URL is not trusted.");
  }

  if (compareVersions(VERSION, manifest.minPcbridgeVersion) < 0) {
    throw new FrontendError(
      "FRONTEND_REQUIRES_NEWER_CLI",
      `Frontend ${manifest.release} requires pcbridge ${manifest.minPcbridgeVersion} or newer.`,
    );
  }

  return manifest;
}

export function frontendManifestUrl(release = "latest"): string {
  if (release === "latest") {
    return `https://github.com/${DEFAULT_FRONTEND_REPOSITORY}/releases/latest/download/release.json`;
  }
  assertReleaseName(release);
  return (
    `https://github.com/${DEFAULT_FRONTEND_REPOSITORY}/releases/download/` +
    `${release}/release.json`
  );
}

export async function fetchFrontendManifest(
  release = "latest",
  options: FrontendStoreOptions = {},
): Promise<FrontendReleaseManifest> {
  const fetchImpl = options.fetch || fetch;
  let response: Response;
  try {
    response = await fetchImpl(frontendManifestUrl(release), {
      headers: {
        Accept: "application/json",
        "User-Agent": `playcanvas-agent-bridge-cli/${VERSION}`,
      },
      redirect: "follow",
    });
  } catch (error) {
    throw new FrontendError(
      "FRONTEND_MANIFEST_DOWNLOAD_FAILED",
      `Cannot download frontend manifest: ${String(error)}`,
    );
  }
  if (!response.ok) {
    throw new FrontendError(
      "FRONTEND_MANIFEST_DOWNLOAD_FAILED",
      `Cannot download frontend manifest: HTTP ${response.status}.`,
    );
  }
  try {
    return validateFrontendManifest(await response.json());
  } catch (error) {
    if (error instanceof FrontendError) throw error;
    throw new FrontendError(
      "INVALID_FRONTEND_MANIFEST",
      "Frontend manifest is not valid JSON.",
    );
  }
}

async function readState(rootDir = CONFIG_DIR): Promise<FrontendState> {
  const { stateFile } = storePaths(rootDir);
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8")) as unknown;
    if (
      isObject(value) &&
      (value.activeRelease === null || typeof value.activeRelease === "string") &&
      typeof value.updatedAt === "string"
    ) {
      if (typeof value.activeRelease === "string") assertReleaseName(value.activeRelease);
      return value as FrontendState;
    }
  } catch {
    // Missing or invalid state falls back to no active frontend.
  }
  return { activeRelease: null, updatedAt: "" };
}

async function writeState(state: FrontendState, rootDir = CONFIG_DIR): Promise<void> {
  const { stateFile } = storePaths(rootDir);
  await mkdir(rootDir, { recursive: true });
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, stateFile);
}

async function validateInstalledFrontend(directory: string): Promise<void> {
  for (const file of REQUIRED_FILES) {
    const info = await stat(join(directory, file)).catch(() => null);
    if (!info?.isFile()) {
      throw new FrontendError(
        "INVALID_FRONTEND_ARCHIVE",
        `Frontend archive is missing ${file}.`,
      );
    }
  }

  const monaco = await stat(join(directory, "dist/js/monaco-editor")).catch(() => null);
  const wasm = await stat(join(directory, "dist/wasm")).catch(() => null);
  if (!monaco?.isDirectory() || !wasm?.isDirectory()) {
    throw new FrontendError(
      "INVALID_FRONTEND_ARCHIVE",
      "Frontend archive is missing Monaco or WASM assets.",
    );
  }
}

function validateArchiveEntry(path: string, type: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new FrontendError(
      "INVALID_FRONTEND_ARCHIVE",
      `Unsafe frontend archive path: ${path}`,
    );
  }
  if (
    normalized !== "LICENSE" &&
    normalized !== "dist" &&
    normalized !== "dist/" &&
    !normalized.startsWith("dist/")
  ) {
    throw new FrontendError(
      "INVALID_FRONTEND_ARCHIVE",
      `Unexpected frontend archive path: ${path}`,
    );
  }
  if (!["File", "OldFile", "Directory"].includes(type)) {
    throw new FrontendError(
      "INVALID_FRONTEND_ARCHIVE",
      `Unsupported frontend archive entry type: ${type}`,
    );
  }
}

async function installedManifest(
  directory: string,
): Promise<FrontendReleaseManifest | null> {
  try {
    const manifest = validateFrontendManifest(
      JSON.parse(await readFile(join(directory, "release.json"), "utf8")),
    );
    await validateInstalledFrontend(directory);
    return manifest;
  } catch {
    return null;
  }
}

export async function installFrontend(
  release = "latest",
  options: FrontendStoreOptions & { activate?: boolean } = {},
): Promise<{ manifest: FrontendReleaseManifest; path: string; alreadyInstalled: boolean }> {
  const rootDir = options.rootDir || CONFIG_DIR;
  const fetchImpl = options.fetch || fetch;
  const { frontendsDir } = storePaths(rootDir);
  const manifest = await fetchFrontendManifest(release, { fetch: fetchImpl });
  const targetDir = join(frontendsDir, manifest.release);
  const existing = await installedManifest(targetDir);

  if (existing?.archive.sha256 === manifest.archive.sha256) {
    if (options.activate !== false) {
      await useFrontend(manifest.release, { rootDir });
    }
    return { manifest: existing, path: targetDir, alreadyInstalled: true };
  }

  await mkdir(frontendsDir, { recursive: true });
  const installId = `${manifest.release}.${process.pid}.${randomUUID()}`;
  const archiveFile = join(frontendsDir, `.${installId}.tar.gz.part`);
  const extractDir = join(frontendsDir, `.${installId}.extract`);

  try {
    let response: Response;
    try {
      response = await fetchImpl(manifest.archive.url, {
        headers: {
          Accept: "application/gzip, application/octet-stream",
          "User-Agent": `playcanvas-agent-bridge-cli/${VERSION}`,
        },
        redirect: "follow",
      });
    } catch (error) {
      throw new FrontendError(
        "FRONTEND_DOWNLOAD_FAILED",
        `Cannot download frontend archive: ${String(error)}`,
      );
    }
    if (!response.ok) {
      throw new FrontendError(
        "FRONTEND_DOWNLOAD_FAILED",
        `Cannot download frontend archive: HTTP ${response.status}.`,
      );
    }

    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length !== manifest.archive.size) {
      throw new FrontendError(
        "FRONTEND_SIZE_MISMATCH",
        `Frontend archive size mismatch: expected ${manifest.archive.size}, got ${archive.length}.`,
      );
    }
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== manifest.archive.sha256) {
      throw new FrontendError(
        "FRONTEND_CHECKSUM_MISMATCH",
        "Frontend archive SHA-256 verification failed.",
      );
    }

    await writeFile(archiveFile, archive, { mode: 0o600 });
    await mkdir(extractDir, { recursive: true });
    let entryCount = 0;
    let extractedSize = 0;
    await inspectTar({
      file: archiveFile,
      onentry: (entry) => {
        validateArchiveEntry(entry.path, entry.type);
        entryCount += 1;
        extractedSize += entry.size;
        if (
          entryCount > MAX_ARCHIVE_ENTRIES ||
          extractedSize > MAX_EXTRACTED_SIZE
        ) {
          throw new FrontendError(
            "INVALID_FRONTEND_ARCHIVE",
            "Frontend archive expands beyond the safety limit.",
          );
        }
      },
    });
    await extractTar({
      cwd: extractDir,
      file: archiveFile,
      preservePaths: false,
      strict: true,
    });
    await validateInstalledFrontend(extractDir);
    await writeFile(
      join(extractDir, "release.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );

    await rm(targetDir, { force: true, recursive: true });
    await rename(extractDir, targetDir);
    if (options.activate !== false) {
      await useFrontend(manifest.release, { rootDir });
    }
    return { manifest, path: targetDir, alreadyInstalled: false };
  } finally {
    await rm(archiveFile, { force: true });
    await rm(extractDir, { force: true, recursive: true });
  }
}

export async function listFrontends(
  options: FrontendStoreOptions = {},
): Promise<InstalledFrontend[]> {
  const rootDir = options.rootDir || CONFIG_DIR;
  const { frontendsDir } = storePaths(rootDir);
  const state = await readState(rootDir);
  const entries = await readdir(frontendsDir, { withFileTypes: true }).catch(() => []);
  const installed: InstalledFrontend[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(frontendsDir, entry.name);
    const manifest = await installedManifest(path);
    if (!manifest) continue;
    installed.push({
      release: manifest.release,
      editorVersion: manifest.editorVersion,
      sourceCommit: manifest.sourceCommit,
      builtAt: manifest.builtAt,
      path,
      active: state.activeRelease === manifest.release,
    });
  }

  return installed.sort((left, right) => right.release.localeCompare(left.release));
}

export async function getFrontendStatus(
  options: FrontendStoreOptions = {},
): Promise<FrontendStatus> {
  const rootDir = options.rootDir || CONFIG_DIR;
  const state = await readState(rootDir);
  const installed = await listFrontends({ rootDir });
  const active = installed.find((item) => item.release === state.activeRelease) || null;
  return {
    ready: Boolean(active),
    activeRelease: active?.release || null,
    activePath: active ? join(active.path, "dist") : null,
    installed,
  };
}

export async function useFrontend(
  release: string,
  options: FrontendStoreOptions = {},
): Promise<FrontendStatus> {
  assertReleaseName(release);
  const rootDir = options.rootDir || CONFIG_DIR;
  const { frontendsDir } = storePaths(rootDir);
  const directory = join(frontendsDir, release);
  if (!(await installedManifest(directory))) {
    throw new FrontendError("FRONTEND_NOT_INSTALLED", `Frontend ${release} is not installed.`);
  }
  await writeState(
    {
      activeRelease: release,
      updatedAt: new Date().toISOString(),
    },
    rootDir,
  );
  return getFrontendStatus({ rootDir });
}

export async function removeFrontend(
  release: string,
  options: FrontendStoreOptions = {},
): Promise<FrontendStatus> {
  assertReleaseName(release);
  const rootDir = options.rootDir || CONFIG_DIR;
  const { frontendsDir } = storePaths(rootDir);
  const state = await readState(rootDir);
  if (state.activeRelease === release) {
    throw new FrontendError(
      "FRONTEND_IS_ACTIVE",
      `Frontend ${release} is active. Select another version before removing it.`,
    );
  }
  const directory = join(frontendsDir, release);
  if (!(await installedManifest(directory))) {
    throw new FrontendError("FRONTEND_NOT_INSTALLED", `Frontend ${release} is not installed.`);
  }
  await rm(directory, { force: true, recursive: true });
  return getFrontendStatus({ rootDir });
}
