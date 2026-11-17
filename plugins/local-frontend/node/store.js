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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { t as inspectTar, x as extractTar } from "tar";

export const DEFAULT_FRONTEND_HOST = "127.0.0.1";
export const DEFAULT_FRONTEND_PORT = 3487;
export const DEFAULT_FRONTEND_REPOSITORY = "Q-My99/playcanvas-editor";

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

export class FrontendError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FrontendError";
    this.code = code;
  }
}

export function resolveFrontendRootDir(pluginDir) {
  if (process.env.PCBRIDGE_FRONTEND_ROOT_DIR) {
    return resolve(process.env.PCBRIDGE_FRONTEND_ROOT_DIR);
  }
  if (process.env.PCBRIDGE_CONFIG_DIR) {
    return resolve(process.env.PCBRIDGE_CONFIG_DIR);
  }
  if (pluginDir) {
    const normalized = resolve(pluginDir).replaceAll("\\", "/");
    if (/\/plugins\/installed\/[^/]+$/.test(normalized)) {
      return resolve(pluginDir, "..", "..", "..");
    }
  }
  return join(homedir(), ".pcbridge");
}

function storePaths(rootDir = resolveFrontendRootDir()) {
  return {
    rootDir,
    frontendsDir: join(rootDir, "frontends"),
    stateFile: join(rootDir, "frontend-state.json"),
    preferencesFile: join(rootDir, "frontend-preferences.json"),
  };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertReleaseName(release) {
  if (typeof release !== "string" || !RELEASE_PATTERN.test(release)) {
    throw new FrontendError(
      "INVALID_FRONTEND_RELEASE",
      `Invalid frontend release name: ${String(release)}`,
    );
  }
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version || "").trim());
  if (!match) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", `Invalid version: ${String(version)}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function validateFrontendManifest(value, options = {}) {
  const hostVersion = options.hostVersion || "0.8.0";
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Unsupported frontend manifest.");
  }

  const archive = value.archive;
  if (!isObject(archive)) {
    throw new FrontendError("INVALID_FRONTEND_MANIFEST", "Frontend archive metadata is missing.");
  }

  const manifest = value;
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

  let archiveUrl;
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

  if (compareVersions(hostVersion, manifest.minPcbridgeVersion) < 0) {
    throw new FrontendError(
      "FRONTEND_REQUIRES_NEWER_CLI",
      `Frontend ${manifest.release} requires pcbridge ${manifest.minPcbridgeVersion} or newer.`,
    );
  }

  return manifest;
}

export function frontendManifestUrl(release = "latest") {
  if (release === "latest") {
    return `https://github.com/${DEFAULT_FRONTEND_REPOSITORY}/releases/latest/download/release.json`;
  }
  assertReleaseName(release);
  return (
    `https://github.com/${DEFAULT_FRONTEND_REPOSITORY}/releases/download/` +
    `${release}/release.json`
  );
}

export async function fetchFrontendManifest(release = "latest", options = {}) {
  const fetchImpl = options.fetch || fetch;
  const hostVersion = options.hostVersion || "0.8.0";
  let response;
  try {
    response = await fetchImpl(frontendManifestUrl(release), {
      headers: {
        Accept: "application/json",
        "User-Agent": `playcanvas-agent-bridge-cli/${hostVersion}`,
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
    return validateFrontendManifest(await response.json(), { hostVersion });
  } catch (error) {
    if (error instanceof FrontendError) throw error;
    throw new FrontendError(
      "INVALID_FRONTEND_MANIFEST",
      "Frontend manifest is not valid JSON.",
    );
  }
}

async function writeAtomicJson(filePath, value, rootDir) {
  await mkdir(rootDir, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

async function readState(rootDir = resolveFrontendRootDir()) {
  const { stateFile } = storePaths(rootDir);
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8"));
    if (
      isObject(value) &&
      (value.activeRelease === null || typeof value.activeRelease === "string") &&
      typeof value.updatedAt === "string"
    ) {
      if (typeof value.activeRelease === "string") assertReleaseName(value.activeRelease);
      return value;
    }
  } catch {
    // Missing or invalid state falls back to no active frontend.
  }
  return { activeRelease: null, updatedAt: "" };
}

async function writeState(state, rootDir = resolveFrontendRootDir()) {
  const { stateFile } = storePaths(rootDir);
  await writeAtomicJson(stateFile, state, rootDir);
}

export async function readFrontendPreferences(options = {}) {
  const rootDir = options.rootDir || resolveFrontendRootDir();
  const { preferencesFile } = storePaths(rootDir);
  try {
    const parsed = JSON.parse(await readFile(preferencesFile, "utf8"));
    const projects = isObject(parsed) && isObject(parsed.projects) ? parsed.projects : parsed;
    if (!isObject(projects)) return {};
    const result = {};
    for (const [projectId, mode] of Object.entries(projects)) {
      if (!/^\d+$/.test(projectId)) continue;
      if (mode === "local" || mode === "custom") result[projectId] = "local";
      else if (mode === "official") result[projectId] = "official";
    }
    return result;
  } catch {
    return {};
  }
}

export async function setFrontendPreference(projectId, mode, options = {}) {
  const id = String(projectId || "").trim();
  if (!/^\d+$/.test(id)) {
    throw new FrontendError("INVALID_PROJECT_ID", "A numeric PlayCanvas projectId is required.");
  }
  const rootDir = options.rootDir || resolveFrontendRootDir();
  const { preferencesFile } = storePaths(rootDir);
  const current = await readFrontendPreferences({ rootDir });
  let normalizedMode = null;
  if (mode === "local" || mode === "custom") {
    normalizedMode = "local";
    current[id] = "local";
  } else if (mode === "official") {
    normalizedMode = "official";
    current[id] = "official";
  } else if (mode === "clear" || mode === null) {
    delete current[id];
  } else {
    throw new FrontendError(
      "INVALID_FRONTEND_MODE",
      "mode must be 'local', 'official', or 'clear'.",
    );
  }
  await writeAtomicJson(
    preferencesFile,
    { schemaVersion: 1, projects: current, updatedAt: new Date().toISOString() },
    rootDir,
  );
  return { projectId: id, mode: normalizedMode, preferences: current };
}

async function validateInstalledFrontend(directory) {
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

function validateArchiveEntry(path, type) {
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

async function installedManifest(directory, hostVersion = "0.8.0") {
  try {
    const manifest = validateFrontendManifest(
      JSON.parse(await readFile(join(directory, "release.json"), "utf8")),
      { hostVersion },
    );
    await validateInstalledFrontend(directory);
    return manifest;
  } catch {
    return null;
  }
}

export async function installFrontend(release = "latest", options = {}) {
  const rootDir = options.rootDir || resolveFrontendRootDir();
  const fetchImpl = options.fetch || fetch;
  const hostVersion = options.hostVersion || "0.8.0";
  const { frontendsDir } = storePaths(rootDir);
  const manifest = await fetchFrontendManifest(release, { fetch: fetchImpl, hostVersion });
  const targetDir = join(frontendsDir, manifest.release);
  const existing = await installedManifest(targetDir, hostVersion);

  if (existing?.archive.sha256 === manifest.archive.sha256) {
    if (options.activate !== false) {
      await useFrontend(manifest.release, { rootDir, hostVersion });
    }
    return { manifest: existing, path: targetDir, alreadyInstalled: true };
  }

  await mkdir(frontendsDir, { recursive: true });
  const installId = `${manifest.release}.${process.pid}.${randomUUID()}`;
  const archiveFile = join(frontendsDir, `.${installId}.tar.gz.part`);
  const extractDir = join(frontendsDir, `.${installId}.extract`);

  try {
    let response;
    try {
      response = await fetchImpl(manifest.archive.url, {
        headers: {
          Accept: "application/gzip, application/octet-stream",
          "User-Agent": `playcanvas-agent-bridge-cli/${hostVersion}`,
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
        if (entryCount > MAX_ARCHIVE_ENTRIES || extractedSize > MAX_EXTRACTED_SIZE) {
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
      await useFrontend(manifest.release, { rootDir, hostVersion });
    }
    return { manifest, path: targetDir, alreadyInstalled: false };
  } finally {
    await rm(archiveFile, { force: true });
    await rm(extractDir, { force: true, recursive: true });
  }
}

export async function listFrontends(options = {}) {
  const rootDir = options.rootDir || resolveFrontendRootDir();
  const hostVersion = options.hostVersion || "0.8.0";
  const { frontendsDir } = storePaths(rootDir);
  const state = await readState(rootDir);
  const entries = await readdir(frontendsDir, { withFileTypes: true }).catch(() => []);
  const installed = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(frontendsDir, entry.name);
    const manifest = await installedManifest(path, hostVersion);
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

export async function getFrontendStatus(options = {}) {
  const rootDir = options.rootDir || resolveFrontendRootDir();
  const hostVersion = options.hostVersion || "0.8.0";
  const state = await readState(rootDir);
  const installed = await listFrontends({ rootDir, hostVersion });
  const active = installed.find((item) => item.release === state.activeRelease) || null;
  return {
    ready: Boolean(active),
    activeRelease: active?.release || null,
    activePath: active ? join(active.path, "dist") : null,
    installed,
  };
}

export async function useFrontend(release, options = {}) {
  assertReleaseName(release);
  const rootDir = options.rootDir || resolveFrontendRootDir();
  const hostVersion = options.hostVersion || "0.8.0";
  const { frontendsDir } = storePaths(rootDir);
  const directory = join(frontendsDir, release);
  if (!(await installedManifest(directory, hostVersion))) {
    throw new FrontendError("FRONTEND_NOT_INSTALLED", `Frontend ${release} is not installed.`);
  }
  await writeState(
    {
      activeRelease: release,
      updatedAt: new Date().toISOString(),
    },
    rootDir,
  );
  return getFrontendStatus({ rootDir, hostVersion });
}

export async function removeFrontend(release, options = {}) {
  assertReleaseName(release);
  const rootDir = options.rootDir || resolveFrontendRootDir();
  const hostVersion = options.hostVersion || "0.8.0";
  const { frontendsDir } = storePaths(rootDir);
  const state = await readState(rootDir);
  if (state.activeRelease === release) {
    throw new FrontendError(
      "FRONTEND_IS_ACTIVE",
      `Frontend ${release} is active. Select another version before removing it.`,
    );
  }
  const directory = join(frontendsDir, release);
  if (!(await installedManifest(directory, hostVersion))) {
    throw new FrontendError("FRONTEND_NOT_INSTALLED", `Frontend ${release} is not installed.`);
  }
  await rm(directory, { force: true, recursive: true });
  return getFrontendStatus({ rootDir, hostVersion });
}
