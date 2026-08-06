#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR,
  DEFAULT_FRONTEND_PORT,
  DEFAULT_HOST,
  DEFAULT_PORT,
  EXTENSION_INSTALL_DIR,
  VERSION,
  copyDir,
  findPackageRoot,
  readOrCreateSession,
  readSessionIfExists,
} from "./config.js";
import { createDaemonServer } from "./daemon/server.js";
import {
  FrontendError,
  getFrontendStatus,
  installFrontend,
  listFrontends,
  removeFrontend,
  useFrontend,
} from "./frontend/store.js";
import {
  assetDeleteSnippet,
  assetFolderEnsureSnippet,
  assetCreateManySnippet,
  assetGetSnippet,
  assetInstantiateTemplateSnippet,
  assetListSnippet,
  entityAddComponentsSnippet,
  entityAddComponentSnippet,
  entityAddScriptSnippet,
  entityCreateManySnippet,
  entityCreateSnippet,
  entityDeleteSnippet,
  entityDuplicateSnippet,
  entityGetSnippet,
  entityListSnippet,
  entityPatchManySnippet,
  entityPatchSnippet,
  entityReparentSnippet,
  entityRemoveComponentsSnippet,
  entityRemoveComponentSnippet,
  entitySetMaterialSnippet,
  materialCreateSnippet,
  materialPatchSnippet,
  sceneSettingsGetSnippet,
  sceneSettingsPatchSnippet,
  scriptCreateSnippet,
  scriptParseSnippet,
  scriptSetTextSnippet,
  scriptUpsertSnippet,
  storeDownloadSnippet,
  storeGetSnippet,
  storeSearchSnippet,
  templateApplySnippet,
  templateCreateSnippet,
  templateOverridesSnippet,
} from "./snippets.js";
import { fail, ok, type Envelope, type JsonValue } from "./shared/protocol.js";

type Args = {
  _: string[];
  flags: Record<string, string | boolean | string[]>;
};

function parseArgs(argv: string[]): Args {
  const parsed: Args = { _: [], flags: {} };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      parsed._.push(item);
      continue;
    }

    const eq = item.indexOf("=");
    const key = eq === -1 ? item.slice(2) : item.slice(2, eq);
    let value: string | boolean;

    if (eq !== -1) {
      value = item.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }

    const existing = parsed.flags[key];
    if (existing === undefined) {
      parsed.flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      parsed.flags[key] = [String(existing), String(value)];
    }
  }

  return parsed;
}

function flagString(args: Args, name: string, fallback?: string): string | undefined {
  const value = args.flags[name];
  if (Array.isArray(value)) return value[value.length - 1];
  if (typeof value === "string") return value;
  return fallback;
}

function flagBool(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

function flagList(args: Args, name: string): string[] {
  const value = args.flags[name];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function print(value: Envelope): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (!value.ok) process.exitCode = 1;
}

type DaemonConnectionDiagnosis = {
  code: string;
  message: string;
  nextAction: string;
};

function nestedErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return nestedErrorCode(candidate.cause);
}

export function diagnoseDaemonConnection(
  error: unknown,
  port = DEFAULT_PORT,
): DaemonConnectionDiagnosis {
  const code = nestedErrorCode(error) || "DAEMON_UNREACHABLE";
  if (code === "EACCES" || code === "EPERM") {
    return {
      code: "LOOPBACK_ACCESS_DENIED",
      message:
        `Daemon may be running, but this process cannot access ${DEFAULT_HOST}:${port}.`,
      nextAction: "Retry from an execution context with local-loopback permission.",
    };
  }
  if (code === "ECONNREFUSED") {
    return {
      code: "DAEMON_NOT_LISTENING",
      message: `No pcbridge daemon is listening on ${DEFAULT_HOST}:${port}.`,
      nextAction: "Run pcbridge daemon start in a terminal.",
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      code: "DAEMON_HOST_UNRESOLVED",
      message: `The configured pcbridge daemon host could not be resolved (${code}).`,
      nextAction: "Check the generated pcbridge session configuration.",
    };
  }
  return {
    code: "DAEMON_UNREACHABLE",
    message: `The pcbridge daemon is not reachable (${code}).`,
    nextAction: "Check pcbridge daemon status, then start it if no listener is running.",
  };
}

class DaemonConnectionError extends Error {
  readonly diagnosis: DaemonConnectionDiagnosis;

  constructor(diagnosis: DaemonConnectionDiagnosis, cause: unknown) {
    super(diagnosis.message, { cause });
    this.name = "DaemonConnectionError";
    this.diagnosis = diagnosis;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readCode(args: Args): Promise<string> {
  const code = flagString(args, "code");
  const file = flagString(args, "file");
  if (code !== undefined) return code;
  if (file) return readFile(await resolveWorkspaceFile(args, file, "eval file"), "utf8");
  if (flagBool(args, "stdin")) return readStdin();
  throw new Error("Provide --code, --file, or --stdin.");
}

function parseJsonValue(raw: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

function parseSets(values: string[]): Array<{ path: string; value: JsonValue }> {
  return values.map((item) => {
    const eq = item.indexOf("=");
    if (eq === -1) {
      throw new Error(`Invalid --set value: ${item}. Use path=value.`);
    }
    return {
      path: item.slice(0, eq),
      value: parseJsonValue(item.slice(eq + 1)),
    };
  });
}

async function fetchDaemon(
  path: string,
  init: RequestInit = {},
): Promise<Envelope> {
  const session = await readOrCreateSession();
  const port = session.port || DEFAULT_PORT;
  let response: Response;
  try {
    response = await fetch(`http://${DEFAULT_HOST}:${port}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-PCBridge-Token": session.token,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    throw new DaemonConnectionError(diagnoseDaemonConnection(error, port), error);
  }
  try {
    return (await response.json()) as Envelope;
  } catch {
    return fail(
      "DAEMON_INVALID_RESPONSE",
      `pcbridge daemon returned a non-JSON response (HTTP ${response.status}).`,
      undefined,
      { status: response.status, path },
    );
  }
}

async function resolveWorkspaceFile(args: Args, path: string, label: string): Promise<string> {
  const resolvedPath = resolve(path);
  if (flagBool(args, "allow-external-path")) return resolvedPath;
  const target = flagString(args, "target", "current") || "current";
  const response = await fetchDaemon(`/workspace/status?target=${encodeURIComponent(target)}`);
  if (!response.ok) throw new Error(response.error.message);
  const status = objectJson(response.data, "workspace status");
  const projectDirectory = typeof status.projectDirectory === "string"
    ? resolve(status.projectDirectory)
    : null;
  if (!projectDirectory) {
    throw new Error(
      `${label} requires an initialized project workspace. ` +
      "Use --allow-external-path only for an intentional external file.",
    );
  }
  let checkedPath = resolvedPath;
  try {
    checkedPath = realpathSync(resolvedPath);
  } catch {
    let ancestor = dirname(resolvedPath);
    while (ancestor !== dirname(ancestor)) {
      try {
        const realAncestor = realpathSync(ancestor);
        checkedPath = resolve(realAncestor, relative(ancestor, resolvedPath));
        break;
      } catch {
        ancestor = dirname(ancestor);
      }
    }
  }
  const checkedProject = realpathSync(projectDirectory);
  if (checkedPath !== checkedProject && !checkedPath.startsWith(`${checkedProject}${sep}`)) {
    throw new Error(
      `${label} must be inside ${checkedProject}. ` +
      "Use --allow-external-path to override this workspace guard.",
    );
  }
  return resolvedPath;
}

async function rpcCall(
  args: Args,
  method: string,
  params: Record<string, JsonValue> = {},
  defaultTimeoutMs = 15000,
  honorTimeoutFlag = true,
): Promise<Envelope> {
  const timeoutMs = honorTimeoutFlag
    ? readTimeoutMs(args, defaultTimeoutMs)
    : defaultTimeoutMs;
  if (timeoutMs === null) return invalidTimeoutEnvelope();
  return fetchDaemon("/rpc", {
    method: "POST",
    body: JSON.stringify({
      target: flagString(args, "target", "current"),
      method,
      timeoutMs,
      params: {
        ...params,
        timeoutMs,
      },
    }),
  });
}

function readTimeoutMs(args: Args, defaultTimeoutMs: number): number | null {
  const value = Number(flagString(args, "timeout-ms", String(defaultTimeoutMs)));
  return Number.isInteger(value) && value >= 1000 && value <= 120000 ? value : null;
}

function invalidTimeoutEnvelope(): Envelope {
  return fail("INVALID_REQUEST", "--timeout-ms must be an integer from 1000 to 120000.");
}

async function rpcEval(
  args: Args,
  code: string,
  commandArgs: Record<string, JsonValue> = {},
  defaultTimeoutMs = 15000,
): Promise<Envelope> {
  const serializeOptions: Record<string, JsonValue> = {};
  const optionFlags = [
    ["max-depth", "maxDepth", 1, 20],
    ["max-items", "maxArray", 1, 5000],
    ["max-keys", "maxKeys", 1, 2000],
    ["max-string", "maxString", 1, 100000],
  ] as const;
  for (const [flag, key, minimum, maximum] of optionFlags) {
    const raw = flagString(args, flag);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      return fail(
        "INVALID_REQUEST",
        `--${flag} must be an integer from ${minimum} to ${maximum}.`,
      );
    }
    serializeOptions[key] = value;
  }
  return rpcCall(args, "bridge:eval", {
    code,
    args: commandArgs as JsonValue,
    serializeOptions: serializeOptions as JsonValue,
  }, defaultTimeoutMs);
}

function listEnvelope(raw: Envelope): Envelope {
  if (!raw.ok) return raw;
  const data = raw.data as {
    items?: JsonValue;
    total?: JsonValue;
    offset?: JsonValue;
    limit?: JsonValue;
    hasMore?: JsonValue;
  };
  if (!data || !Array.isArray(data.items)) return raw;
  return ok(data.items as JsonValue, {
    ...(raw.meta || {}),
    total: data.total ?? data.items.length,
    offset: data.offset ?? 0,
    limit: data.limit ?? data.items.length,
    hasMore: data.hasMore ?? false,
  });
}

function inferAssetType(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tga"].includes(ext)) return "texture";
  if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) return "audio";
  if (ext === ".json") return "json";
  if (ext === ".css") return "css";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".txt") return "text";
  return undefined;
}

function inferMime(path: string): string {
  const ext = extname(path).toLowerCase();
  const mimes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
  };
  return mimes[ext] || "application/octet-stream";
}

function nameFromFile(path: string): string {
  const file = basename(path);
  const ext = extname(file);
  return ext ? file.slice(0, -ext.length) : file;
}

async function readJsonFlag(args: Args, flagName: string): Promise<JsonValue | undefined> {
  const file = flagString(args, flagName);
  if (!file) return undefined;
  const path = await resolveWorkspaceFile(args, file, `--${flagName}`);
  return JSON.parse(await readFile(path, "utf8")) as JsonValue;
}

function objectJson(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, JsonValue>;
}

type UploadSpec = {
  key?: string;
  file: string;
  name?: string;
  filename?: string;
  type?: string;
  mime?: string;
  folder?: string;
  folderId?: string;
  preload?: boolean;
};

function uploadSpecFromJson(value: JsonValue, label: string): UploadSpec {
  const data = objectJson(value, label);
  const file = typeof data.file === "string" ? data.file : "";
  if (!file) {
    throw new Error(`${label}.file is required.`);
  }
  return {
    key: typeof data.key === "string" ? data.key : undefined,
    file,
    name: typeof data.name === "string" ? data.name : undefined,
    filename: typeof data.filename === "string" ? data.filename : undefined,
    type: typeof data.type === "string" ? data.type : undefined,
    mime: typeof data.mime === "string" ? data.mime : undefined,
    folder: typeof data.folder === "string" ? data.folder : undefined,
    folderId: typeof data.folderId === "string" || typeof data.folderId === "number"
      ? String(data.folderId)
      : undefined,
    preload: typeof data.preload === "boolean" ? data.preload : undefined,
  };
}

function resolveManifestFile(manifestPath: string, file: string): string {
  return isAbsolute(file) ? file : resolve(dirname(manifestPath), file);
}

async function uploadAsset(args: Args, spec: UploadSpec): Promise<Envelope> {
  spec.file = await resolveWorkspaceFile(args, spec.file, "asset upload file");
  const fileBuffer = await readFile(spec.file);
  const type = spec.type || inferAssetType(spec.file);
  if (!type) return fail("INVALID_REQUEST", `asset upload requires --type for ${spec.file}.`);
  const filename = spec.filename || basename(spec.file);
  return rpcCall(
    args,
    "bridge:uploadAsset",
    {
      base64: fileBuffer.toString("base64"),
      mime: spec.mime || inferMime(spec.file),
      name: spec.name || nameFromFile(spec.file),
      filename,
      type,
      folder: spec.folder || null,
      folderId: spec.folderId || null,
      preload: spec.preload !== false,
    },
    120000,
  );
}

async function doctor(): Promise<Envelope> {
  const session = await readSessionIfExists();
  const checks: JsonValue[] = [];
  const nextActions: string[] = [];
  const major = Number(process.versions.node.split(".", 1)[0]);
  let daemonOk = false;
  let connectedExtensionVersionsOk = true;

  checks.push({
    name: "node",
    ok: major >= 20,
    version: process.version,
    message: major >= 20 ? "Node version is supported." : "Node 20 or newer is required.",
  });

  if (!session) {
    nextActions.push("Run pcbridge install-extension to create a local session token.");
  }

  try {
    const health = await fetchDaemon("/health");
    const daemonData = health.ok ? objectJson(health.data, "daemon health") : null;
    const daemonVersion = daemonData && typeof daemonData.version === "string"
      ? daemonData.version
      : null;
    daemonOk = health.ok && daemonVersion === VERSION;
    checks.push({
      name: "daemon",
      ok: daemonOk,
      code: health.ok ? null : health.error.code,
      version: daemonVersion,
      expectedVersion: VERSION,
      message: !health.ok
        ? health.error.message
        : daemonVersion === VERSION
          ? "Daemon is reachable and matches the CLI version."
          : "Daemon is reachable but its version does not match the CLI.",
      data: health.ok ? health.data : null,
    });
    if (!health.ok && health.error.code === "BAD_TOKEN") {
      nextActions.push(
        "Stop the stale daemon, start it again with this pcbridge install, then regenerate/reload the extension.",
      );
    } else if (health.ok && daemonVersion !== VERSION) {
      nextActions.push("Restart the daemon with the same pcbridge version as this CLI.");
    }
  } catch (error) {
    const diagnosis = error instanceof DaemonConnectionError
      ? error.diagnosis
      : diagnoseDaemonConnection(error);
    checks.push({
      name: "daemon",
      ok: false,
      code: diagnosis.code,
      message: diagnosis.message,
    });
    nextActions.push(diagnosis.nextAction);
  }

  const frontend = await getFrontendStatus();
  checks.push({
    name: "frontend",
    ok: frontend.ready,
    activeRelease: frontend.activeRelease,
    installedCount: frontend.installed.length,
    message: frontend.ready
      ? `Frontend ${frontend.activeRelease} is ready.`
      : "No active custom Editor frontend is installed.",
  });
  if (!frontend.ready) {
    nextActions.push("Run pcbridge frontend install latest.");
  }

  const extensionExists = Boolean(session) && (await pathExists(EXTENSION_INSTALL_DIR));
  let generatedExtensionVersion: string | null = null;
  if (extensionExists) {
    try {
      const manifest = JSON.parse(await readFile(join(EXTENSION_INSTALL_DIR, "manifest.json"), "utf8")) as {
        version?: string;
      };
      generatedExtensionVersion = manifest.version || null;
    } catch {
      generatedExtensionVersion = null;
    }
  }
  checks.push({
    name: "extension",
    ok: extensionExists && generatedExtensionVersion === VERSION,
    path: EXTENSION_INSTALL_DIR,
    version: generatedExtensionVersion,
    expectedVersion: VERSION,
    message: extensionExists && generatedExtensionVersion === VERSION
      ? "Generated unpacked extension directory exists and matches package version."
      : extensionExists
        ? "Generated unpacked extension version does not match package version."
      : "Generated unpacked extension directory was not found.",
  });
  if (!extensionExists) {
    nextActions.push("Run pcbridge install-extension and load the printed directory in Chrome.");
  } else if (generatedExtensionVersion !== VERSION) {
    nextActions.push("Run pcbridge install-extension --no-open, then reload the unpacked extension in Chrome.");
  }

  try {
    const targets = await fetchDaemon("/targets");
    if (targets.ok && Array.isArray(targets.data)) {
      const connectedVersions = targets.data
        .map((target) => (target && typeof target === "object" && !Array.isArray(target) ? target.extensionVersion : null))
        .filter(Boolean);
      const mismatched = connectedVersions.filter((version) => version !== VERSION);
      connectedExtensionVersionsOk = mismatched.length === 0;
      checks.push({
        name: "connected-extension-version",
        ok: mismatched.length === 0,
        versions: connectedVersions as unknown as JsonValue,
        expectedVersion: VERSION,
        message: mismatched.length
          ? "One or more connected PlayCanvas tabs are using an older extension version."
          : "Connected extension versions match the package version.",
      });
      if (mismatched.length) {
        nextActions.push("Reload the unpacked extension and refresh the PlayCanvas Editor or Launch tab.");
      }
    }
  } catch {
    // Daemon reachability is already reported above.
  }

  return ok({
    version: VERSION,
    healthy:
      major >= 20 &&
      daemonOk &&
      extensionExists &&
      generatedExtensionVersion === VERSION &&
      connectedExtensionVersionsOk,
    configDir: CONFIG_DIR,
    checks,
    nextActions,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, "manifest.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function daemon(args: Args): Promise<void> {
  const subcommand = args._[1] || "status";

  if (subcommand === "start") {
    const session = await readOrCreateSession();
    const server = createDaemonServer({
      host: DEFAULT_HOST,
      port: session.port || DEFAULT_PORT,
      token: session.token,
      workspaceRoot: process.cwd(),
      log: (message) => {
        if (flagBool(args, "json")) {
          process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), message })}\n`);
        } else {
          process.stderr.write(`[pcbridge] ${message}\n`);
        }
      },
    });

    try {
      await server.listen();
    } catch (error) {
      print(
        fail(
          "PORT_BUSY",
          `Cannot listen on ${DEFAULT_HOST}:${session.port || DEFAULT_PORT}. ${String(error)}`,
        ),
      );
      process.exitCode = 1;
      return;
    }

    print(
      ok({
        version: VERSION,
        host: DEFAULT_HOST,
        port: session.port || DEFAULT_PORT,
        workspaceRoot: process.cwd(),
        extensionPath: EXTENSION_INSTALL_DIR,
        frontend: await server.frontend.status() as unknown as JsonValue,
      }),
    );
  } else if (subcommand === "status") {
    try {
      print(await fetchDaemon("/health"));
    } catch (error) {
      print(fail("DAEMON_UNREACHABLE", "Daemon is not reachable."));
      process.exitCode = 1;
    }
  } else {
    print(fail("UNKNOWN_COMMAND", `Unknown daemon command: ${subcommand}`));
    process.exitCode = 1;
  }
}

async function handleFrontend(args: Args): Promise<Envelope> {
  const subcommand = args._[1] || "status";

  try {
    if (subcommand === "install" || subcommand === "update") {
      const requestedRelease = subcommand === "update" ? "latest" : args._[2] || "latest";
      const installed = await installFrontend(requestedRelease, {
        activate: !flagBool(args, "no-activate"),
      });
      const status = await getFrontendStatus();
      return ok({
        release: installed.manifest.release,
        editorVersion: installed.manifest.editorVersion,
        sourceCommit: installed.manifest.sourceCommit,
        path: installed.path,
        alreadyInstalled: installed.alreadyInstalled,
        active: status.activeRelease === installed.manifest.release,
        nextActions: [
          "Run pcbridge daemon start if it is not already running.",
          "Use the extension popup on a playcanvas.com Editor tab to select the custom frontend.",
        ],
      });
    }

    if (subcommand === "list") {
      return ok(await listFrontends() as unknown as JsonValue);
    }

    if (subcommand === "status") {
      try {
        return await fetchDaemon("/frontend/status");
      } catch {
        return ok({
          ...(await getFrontendStatus()),
          server: {
            host: DEFAULT_HOST,
            port: DEFAULT_FRONTEND_PORT,
            listening: false,
            error: "Daemon is not reachable.",
          },
        } as unknown as JsonValue);
      }
    }

    if (subcommand === "use") {
      const release = args._[2];
      if (!release) {
        return fail("INVALID_REQUEST", "frontend use requires a release name.");
      }
      return ok(await useFrontend(release) as unknown as JsonValue);
    }

    if (subcommand === "remove") {
      const release = args._[2];
      if (!release) {
        return fail("INVALID_REQUEST", "frontend remove requires a release name.");
      }
      return ok(await removeFrontend(release) as unknown as JsonValue);
    }

    return fail("UNKNOWN_COMMAND", `Unknown frontend command: ${subcommand}`);
  } catch (error) {
    if (error instanceof FrontendError) {
      return fail(error.code, error.message);
    }
    throw error;
  }
}

async function installExtension(args: Args): Promise<Envelope> {
  const session = await readOrCreateSession();
  const root = await findPackageRoot();
  const source = join(root, "extension");
  await copyDir(source, EXTENSION_INSTALL_DIR, {
    clean: true,
    ignore: new Set(["config.example.json"]),
  });
  await writeFile(
    join(EXTENSION_INSTALL_DIR, "config.json"),
    `${JSON.stringify(
      {
        host: DEFAULT_HOST,
        port: session.port || DEFAULT_PORT,
        token: session.token,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  if (!flagBool(args, "no-open")) {
    openChromeExtensions();
  }

  return ok({
    extensionPath: EXTENSION_INSTALL_DIR,
    chromeUrl: "chrome://extensions",
    nextActions: [
      "Enable Developer Mode in Chrome.",
      "Click Load unpacked.",
      `Select ${EXTENSION_INSTALL_DIR}.`,
      "Open or refresh a PlayCanvas Editor or Launch tab, then run pcbridge daemon start.",
    ],
  });
}

function openChromeExtensions(): void {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    platform === "darwin"
      ? ["-a", "Google Chrome", "chrome://extensions"]
      : platform === "win32"
        ? ["/c", "start", "chrome://extensions"]
        : ["chrome://extensions"];

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The printed chrome://extensions URL is enough when opening fails.
  }
}

async function installSkill(args: Args): Promise<Envelope> {
  const agent = flagString(args, "agent", "codex") || "codex";
  const root = await findPackageRoot();
  const installed: JsonValue[] = [];
  const agents = agent === "all" ? ["codex", "claude", "cursor", "windsurf"] : [agent];

  for (const item of agents) {
    if (item === "codex") {
      const dest = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills");
      const source = join(root, "skills", "codex", "playcanvas-agent-bridge-cli");
      const target = join(dest, "playcanvas-agent-bridge-cli");
      await copyDir(source, target, { clean: true });
      installed.push({ agent: item, path: target });
    } else if (item === "claude") {
      const target = join(homedir(), ".claude", "skills", "playcanvas-agent-bridge-cli");
      await copyDir(join(root, "skills", "claude", "playcanvas-agent-bridge-cli"), target, {
        clean: true,
      });
      installed.push({ agent: item, path: target });
    } else if (item === "cursor") {
      const target = join(homedir(), ".cursor", "rules", "playcanvas-agent-bridge-cli.mdc");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(root, "skills", "cursor", "playcanvas-agent-bridge-cli.mdc")));
      installed.push({ agent: item, path: target });
    } else if (item === "windsurf") {
      const target = join(homedir(), ".windsurf", "rules", "playcanvas-agent-bridge-cli.md");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(join(root, "skills", "windsurf", "playcanvas-agent-bridge-cli.md")));
      installed.push({ agent: item, path: target });
    } else {
      return fail("UNKNOWN_AGENT", `Unsupported agent: ${item}. Use codex, claude, cursor, windsurf, or all.`);
    }
  }

  return ok(installed as JsonValue);
}

async function handleEntity(args: Args): Promise<Envelope> {
  const subcommand = args._[1] || "list";
  if (subcommand === "list") {
    return listEnvelope(
      await rpcEval(args, entityListSnippet(), {
        name: flagString(args, "name") || null,
        component: flagString(args, "component") || null,
        tag: flagString(args, "tag") || null,
        limit: Number(flagString(args, "limit", "50")),
        offset: Number(flagString(args, "offset", "0")),
        full: flagBool(args, "full"),
      }),
    );
  }
  if (subcommand === "get") {
    const id = flagString(args, "id");
    if (!id) return fail("INVALID_REQUEST", "entity get requires --id.");
    return rpcEval(args, entityGetSnippet(), { id, full: flagBool(args, "full") });
  }
  if (subcommand === "create") {
    const file = flagString(args, "json");
    if (!file) return fail("INVALID_REQUEST", "entity create requires --json <file>.");
    const data = JSON.parse(await readFile(await resolveWorkspaceFile(args, file, "entity JSON"), "utf8")) as JsonValue;
    return rpcEval(args, entityCreateSnippet(), { data });
  }
  if (subcommand === "create-many") {
    const file = flagString(args, "json");
    if (!file) return fail("INVALID_REQUEST", "entity create-many requires --json <file>.");
    const data = JSON.parse(await readFile(await resolveWorkspaceFile(args, file, "entity JSON"), "utf8")) as JsonValue;
    const entities = Array.isArray(data)
      ? data
      : objectJson(data, "entity create-many data").entities;
    return rpcEval(args, entityCreateManySnippet(), { entities: entities || [] }, 30000);
  }
  if (subcommand === "patch") {
    const id = flagString(args, "id");
    if (!id) return fail("INVALID_REQUEST", "entity patch requires --id.");
    return rpcEval(args, entityPatchSnippet(), { id, sets: parseSets(flagList(args, "set")) });
  }
  if (subcommand === "patch-many") {
    const file = flagString(args, "json");
    if (!file) return fail("INVALID_REQUEST", "entity patch-many requires --json <file>.");
    const data = JSON.parse(await readFile(await resolveWorkspaceFile(args, file, "entity JSON"), "utf8")) as JsonValue;
    const edits = Array.isArray(data)
      ? data
      : objectJson(data, "entity patch-many data").edits;
    return rpcEval(args, entityPatchManySnippet(), { edits: edits || [] }, 30000);
  }
  if (subcommand === "duplicate") {
    const ids = flagList(args, "id");
    const id = flagString(args, "id");
    if (!ids.length && !id) return fail("INVALID_REQUEST", "entity duplicate requires --id.");
    return rpcEval(args, entityDuplicateSnippet(), {
      ids: ids as unknown as JsonValue,
      id: id || null,
      rename: !flagBool(args, "no-rename"),
      select: !flagBool(args, "no-select"),
    });
  }
  if (subcommand === "reparent") {
    const id = flagString(args, "id");
    const parent = flagString(args, "parent");
    if (!id || !parent) return fail("INVALID_REQUEST", "entity reparent requires --id and --parent.");
    return rpcEval(args, entityReparentSnippet(), {
      id,
      parent,
      index: flagString(args, "index") === undefined ? null : Number(flagString(args, "index")),
      preserveTransform: !flagBool(args, "no-preserve-transform"),
    });
  }
  if (subcommand === "delete") {
    const ids = flagList(args, "id");
    const id = flagString(args, "id");
    if (!ids.length && !id) return fail("INVALID_REQUEST", "entity delete requires --id.");
    return rpcEval(args, entityDeleteSnippet(), { ids: ids as unknown as JsonValue, id: id || null });
  }
  if (subcommand === "add-component") {
    const id = flagString(args, "id");
    const component = flagString(args, "component");
    if (!id || !component) {
      return fail("INVALID_REQUEST", "entity add-component requires --id and --component.");
    }
    const data =
      (await readJsonFlag(args, "json")) ??
      (flagString(args, "data") ? parseJsonValue(flagString(args, "data") || "{}") : {});
    return rpcEval(args, entityAddComponentSnippet(), {
      id,
      component,
      data: objectJson(data, "component data") as unknown as JsonValue,
    });
  }
  if (subcommand === "add-components") {
    const id = flagString(args, "id");
    const data = await readJsonFlag(args, "json");
    if (!id || data === undefined) {
      return fail("INVALID_REQUEST", "entity add-components requires --id and --json <file>.");
    }
    return rpcEval(args, entityAddComponentsSnippet(), {
      id,
      components: objectJson(data, "components") as unknown as JsonValue,
    });
  }
  if (subcommand === "remove-component") {
    const id = flagString(args, "id");
    const components = flagList(args, "component");
    const component = flagString(args, "component");
    if (!id || (!components.length && !component)) {
      return fail("INVALID_REQUEST", "entity remove-component requires --id and --component.");
    }
    if (components.length > 1) {
      return rpcEval(args, entityRemoveComponentsSnippet(), {
        id,
        components: components as unknown as JsonValue,
      });
    }
    return rpcEval(args, entityRemoveComponentSnippet(), { id, component: component || components[0] });
  }
  if (subcommand === "remove-components") {
    const id = flagString(args, "id");
    const components = flagList(args, "component");
    if (!id || !components.length) {
      return fail("INVALID_REQUEST", "entity remove-components requires --id and at least one --component.");
    }
    return rpcEval(args, entityRemoveComponentsSnippet(), {
      id,
      components: components as unknown as JsonValue,
    });
  }
  if (subcommand === "set-material") {
    const id = flagString(args, "id");
    const materialId = flagString(args, "material-id");
    if (!id || !materialId) {
      return fail("INVALID_REQUEST", "entity set-material requires --id and --material-id.");
    }
    return rpcEval(args, entitySetMaterialSnippet(), {
      id,
      materialId,
      slot: Number(flagString(args, "slot", "0")),
      renderType: flagString(args, "render-type", "box") || "box",
    });
  }
  if (subcommand === "add-script") {
    const id = flagString(args, "id");
    if (!id) return fail("INVALID_REQUEST", "entity add-script requires --id.");
    const scriptName = flagString(args, "script-name");
    const assetId = flagString(args, "asset-id");
    if (Boolean(scriptName) === Boolean(assetId)) {
      return fail(
        "INVALID_REQUEST",
        "entity add-script requires exactly one of --asset-id or --script-name.",
      );
    }
    const attributes =
      (await readJsonFlag(args, "attributes-json")) ??
      (flagString(args, "attributes") ? parseJsonValue(flagString(args, "attributes") || "{}") : {});
    return rpcEval(args, entityAddScriptSnippet(), {
      id,
      scriptName: scriptName || null,
      assetId: assetId || null,
      attributes: objectJson(attributes, "script attributes") as unknown as JsonValue,
      enabled: !flagBool(args, "disabled"),
    });
  }
  return fail("UNKNOWN_COMMAND", `Unknown entity command: ${subcommand}`);
}

async function handleAsset(args: Args): Promise<Envelope> {
  const subcommand = args._[1] || "list";
  if (subcommand === "list") {
    return listEnvelope(
      await rpcEval(args, assetListSnippet(), {
        name: flagString(args, "name") || null,
        type: flagString(args, "type") || null,
        tag: flagString(args, "tag") || null,
        limit: Number(flagString(args, "limit", "50")),
        offset: Number(flagString(args, "offset", "0")),
        full: flagBool(args, "full"),
      }),
    );
  }
  if (subcommand === "get") {
    const id = flagString(args, "id");
    if (!id) return fail("INVALID_REQUEST", "asset get requires --id.");
    return rpcEval(args, assetGetSnippet(), { id, full: flagBool(args, "full") });
  }
  if (subcommand === "create") {
    const file = flagString(args, "json");
    if (!file) return fail("INVALID_REQUEST", "asset create requires --json <file>.");
    const data = JSON.parse(await readFile(await resolveWorkspaceFile(args, file, "asset JSON"), "utf8")) as JsonValue;
    const assets = Array.isArray(data)
      ? data
      : objectJson(data, "asset create data").assets || [data];
    return rpcEval(args, assetCreateManySnippet(), { assets }, 60000);
  }
  if (subcommand === "folder" && args._[2] === "ensure") {
    const path = flagString(args, "path");
    if (!path) return fail("INVALID_REQUEST", "asset folder ensure requires --path.");
    return rpcEval(args, assetFolderEnsureSnippet(), { path });
  }
  if (subcommand === "instantiate") {
    const ids = flagList(args, "id");
    const id = flagString(args, "id");
    if (!ids.length && !id) return fail("INVALID_REQUEST", "asset instantiate requires --id.");
    return rpcEval(args, assetInstantiateTemplateSnippet(), {
      ids: ids as unknown as JsonValue,
      id: id || null,
    }, 60000);
  }
  if (subcommand === "upload") {
    const file = flagString(args, "file");
    if (!file) return fail("INVALID_REQUEST", "asset upload requires --file.");
    return uploadAsset(args, {
      file,
      type: flagString(args, "type"),
      mime: flagString(args, "mime"),
      name: flagString(args, "name"),
      filename: flagString(args, "filename"),
      folder: flagString(args, "folder"),
      folderId: flagString(args, "folder-id"),
      preload: !flagBool(args, "no-preload"),
    });
  }
  if (subcommand === "upload-many") {
    const manifestPath = flagString(args, "json");
    if (!manifestPath) return fail("INVALID_REQUEST", "asset upload-many requires --json <file>.");
    const safeManifestPath = await resolveWorkspaceFile(args, manifestPath, "upload manifest");
    const manifest = JSON.parse(await readFile(safeManifestPath, "utf8")) as JsonValue;
    const rawItems = Array.isArray(manifest)
      ? manifest
      : objectJson(manifest, "asset upload-many manifest").assets;
    const items = Array.isArray(rawItems) ? rawItems : [];
    if (!items.length) {
      return fail("INVALID_REQUEST", "asset upload-many manifest must contain a non-empty assets array.");
    }

    const uploads: JsonValue[] = [];
    const errors: JsonValue[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const spec = uploadSpecFromJson(items[index] as JsonValue, `assets[${index}]`);
      spec.file = resolveManifestFile(safeManifestPath, spec.file);
      const result = await uploadAsset(args, spec);
      uploads.push({
        index,
        key: spec.key || null,
        file: spec.file,
        name: spec.name || nameFromFile(spec.file),
        result: result as unknown as JsonValue,
      });
      if (!result.ok) {
        errors.push({
          index,
          file: spec.file,
          error: result.error as unknown as JsonValue,
        });
      }
    }

    if (errors.length) {
      return fail(
        "UPLOAD_MANY_FAILED",
        `${errors.length} of ${items.length} uploads failed.`,
        {
          affected: items.length - errors.length,
          failed: errors.length,
        },
        { uploads, errors } as unknown as JsonValue,
      );
    }

    return ok(
      {
        affected: uploads.length,
        uploads,
      },
      {
        affected: uploads.length,
        failed: 0,
      },
    );
  }
  if (subcommand === "delete") {
    const ids = flagList(args, "id");
    const id = flagString(args, "id");
    if (!ids.length && !id) return fail("INVALID_REQUEST", "asset delete requires --id.");
    return rpcEval(args, assetDeleteSnippet(), { ids: ids as unknown as JsonValue, id: id || null }, 30000);
  }
  return fail("UNKNOWN_COMMAND", `Unknown asset command: ${subcommand}`);
}

async function handleMaterial(args: Args): Promise<Envelope> {
  const subcommand = args._[1];
  if (subcommand === "create") {
    const name = flagString(args, "name");
    if (!name) return fail("INVALID_REQUEST", "material create requires --name.");
    const data =
      (await readJsonFlag(args, "json")) ??
      (flagString(args, "data") ? parseJsonValue(flagString(args, "data") || "{}") : {});
    return rpcEval(
      args,
      materialCreateSnippet(),
      {
        name,
        folder: flagString(args, "folder") || null,
        folderId: flagString(args, "folder-id") || null,
        diffuseMap: flagString(args, "diffuse-map") || null,
        emissiveMap: flagString(args, "emissive-map") || null,
        normalMap: flagString(args, "normal-map") || null,
        data: objectJson(data, "material data") as unknown as JsonValue,
        preload: !flagBool(args, "no-preload"),
      },
      30000,
    );
  }
  if (subcommand === "patch") {
    const assetId = flagString(args, "asset-id") || flagString(args, "id");
    if (!assetId) return fail("INVALID_REQUEST", "material patch requires --asset-id.");
    const data =
      (await readJsonFlag(args, "json")) ??
      (flagString(args, "data") ? parseJsonValue(flagString(args, "data") || "{}") : {});
    return rpcEval(args, materialPatchSnippet(), {
      assetId,
      data: objectJson(data, "material data") as unknown as JsonValue,
      sets: parseSets(flagList(args, "set")),
    });
  }
  if (subcommand === "set-diffuse") {
    const assetId = flagString(args, "asset-id") || flagString(args, "id");
    const color = flagString(args, "color");
    if (!assetId || !color) return fail("INVALID_REQUEST", "material set-diffuse requires --asset-id and --color.");
    return rpcEval(args, materialPatchSnippet(), {
      assetId,
      data: { diffuse: parseJsonValue(color) } as unknown as JsonValue,
      sets: [],
    });
  }
  return fail("UNKNOWN_COMMAND", `Unknown material command: ${subcommand || ""}`);
}

async function handleTemplate(args: Args): Promise<Envelope> {
  const subcommand = args._[1];
  if (subcommand === "create") {
    const entityId = flagString(args, "entity-id") || flagString(args, "id");
    if (!entityId) return fail("INVALID_REQUEST", "template create requires --entity-id.");
    return rpcEval(args, templateCreateSnippet(), {
      entityId,
      name: flagString(args, "name") || null,
      folder: flagString(args, "folder") || null,
      folderId: flagString(args, "folder-id") || null,
      preload: !flagBool(args, "no-preload"),
    }, 60000);
  }
  if (subcommand === "instantiate") {
    const ids = flagList(args, "id");
    const id = flagString(args, "id");
    if (!ids.length && !id) return fail("INVALID_REQUEST", "template instantiate requires --id.");
    return rpcEval(args, assetInstantiateTemplateSnippet(), {
      ids: ids as unknown as JsonValue,
      id: id || null,
    }, 60000);
  }
  if (subcommand === "overrides") {
    const entityId = flagString(args, "entity-id") || flagString(args, "id");
    if (!entityId) return fail("INVALID_REQUEST", "template overrides requires --entity-id.");
    return rpcEval(args, templateOverridesSnippet(), { entityId });
  }
  if (subcommand === "apply") {
    const entityId = flagString(args, "entity-id") || flagString(args, "id");
    if (!entityId) return fail("INVALID_REQUEST", "template apply requires --entity-id.");
    const waitTimeoutMs = readTimeoutMs(args, 60000);
    if (waitTimeoutMs === null) return invalidTimeoutEnvelope();
    return rpcEval(args, templateApplySnippet(), {
      entityId,
      waitTimeoutMs,
    }, 60000);
  }
  if (subcommand === "apply-many") {
    const input = await readJsonFlag(args, "json");
    if (input === undefined) {
      return fail("INVALID_REQUEST", "template apply-many requires --json <file>.");
    }
    const values = Array.isArray(input)
      ? input
      : Array.isArray(objectJson(input, "template apply manifest").entityIds)
        ? objectJson(input, "template apply manifest").entityIds as JsonValue[]
        : [];
    const entityIds = values.map((value) => {
      if (typeof value === "string" || typeof value === "number") return String(value);
      const item = objectJson(value, "template apply item");
      const id = item.entityId ?? item.id;
      return typeof id === "string" || typeof id === "number" ? String(id) : "";
    }).filter(Boolean);
    if (!entityIds.length) {
      return fail(
        "INVALID_REQUEST",
        "template apply-many JSON must be an array of entity ids/items or {\"entityIds\":[...] }.",
      );
    }
    const waitTimeoutMs = readTimeoutMs(args, 120000);
    if (waitTimeoutMs === null) return invalidTimeoutEnvelope();
    return rpcEval(args, templateApplySnippet(), {
      entityIds: entityIds as unknown as JsonValue,
      waitTimeoutMs,
    }, 120000);
  }
  return fail("UNKNOWN_COMMAND", `Unknown template command: ${subcommand || ""}`);
}

async function handleScript(args: Args): Promise<Envelope> {
  const subcommand = args._[1];
  if (subcommand === "upsert") {
    const filename = flagString(args, "filename") || (flagString(args, "file") ? basename(flagString(args, "file") || "") : undefined);
    const file = flagString(args, "file");
    if (!filename || !file) {
      return fail("INVALID_REQUEST", "script upsert requires --filename and --file.");
    }
    const waitTimeoutMs = readTimeoutMs(args, 60000);
    if (waitTimeoutMs === null) return invalidTimeoutEnvelope();
    return rpcEval(
      args,
      scriptUpsertSnippet(),
      {
        filename,
        text: await readFile(await resolveWorkspaceFile(args, file, "script file"), "utf8"),
        folder: flagString(args, "folder") || null,
        folderId: flagString(args, "folder-id") || null,
        preload: !flagBool(args, "no-preload"),
        parse: flagBool(args, "parse"),
        wait: flagBool(args, "wait"),
        waitTimeoutMs,
      },
      60000,
    );
  }
  if (subcommand === "create") {
    const filename = flagString(args, "filename") || (flagString(args, "file") ? basename(flagString(args, "file") || "") : undefined);
    const file = flagString(args, "file");
    if (!filename || !file) {
      return fail("INVALID_REQUEST", "script create requires --filename and --file.");
    }
    return rpcEval(
      args,
      scriptCreateSnippet(),
      {
        filename,
        text: await readFile(await resolveWorkspaceFile(args, file, "script file"), "utf8"),
        folder: flagString(args, "folder") || null,
        folderId: flagString(args, "folder-id") || null,
        preload: !flagBool(args, "no-preload"),
      },
      60000,
    );
  }
  if (subcommand === "set-text") {
    const assetId = flagString(args, "asset-id");
    const file = flagString(args, "file");
    if (!assetId || !file) {
      return fail("INVALID_REQUEST", "script set-text requires --asset-id and --file.");
    }
    const waitTimeoutMs = readTimeoutMs(args, 60000);
    if (waitTimeoutMs === null) return invalidTimeoutEnvelope();
    return rpcEval(
      args,
      scriptSetTextSnippet(),
      {
        assetId,
        filename: basename(file),
        text: await readFile(await resolveWorkspaceFile(args, file, "script file"), "utf8"),
        parse: flagBool(args, "parse"),
        wait: flagBool(args, "wait"),
        waitTimeoutMs,
      },
      60000,
    );
  }
  if (subcommand === "parse") {
    const assetId = flagString(args, "asset-id");
    if (!assetId) return fail("INVALID_REQUEST", "script parse requires --asset-id.");
    const waitTimeoutMs = readTimeoutMs(args, 60000);
    if (waitTimeoutMs === null) return invalidTimeoutEnvelope();
    return rpcEval(args, scriptParseSnippet(), { assetId, waitTimeoutMs }, 60000);
  }
  return fail("UNKNOWN_COMMAND", `Unknown script command: ${subcommand || ""}`);
}

async function handleScene(args: Args): Promise<Envelope> {
  const subcommand = args._[1];
  if (subcommand === "settings" && (args._[2] || "get") === "get") {
    return rpcEval(args, sceneSettingsGetSnippet());
  }
  if (subcommand === "settings" && args._[2] === "patch") {
    const data = (await readJsonFlag(args, "json")) ?? {};
    const sets = parseSets(flagList(args, "set"));
    if (!Object.keys(objectJson(data, "scene settings")).length && !sets.length) {
      return fail("INVALID_REQUEST", "scene settings patch requires --json <file> or --set path=value.");
    }
    return rpcEval(args, sceneSettingsPatchSnippet(), {
      settings: objectJson(data, "scene settings") as unknown as JsonValue,
      sets,
    });
  }
  return fail("UNKNOWN_COMMAND", `Unknown scene command: ${[subcommand, args._[2]].filter(Boolean).join(" ")}`);
}

async function handleStore(args: Args): Promise<Envelope> {
  const subcommand = args._[1] || "search";
  if (subcommand === "search") {
    const search = flagString(args, "search") || flagString(args, "q");
    if (!search) return fail("INVALID_REQUEST", "store search requires --search.");
    return rpcEval(args, storeSearchSnippet(), {
      search,
      order: flagString(args, "order") || null,
      skip: Number(flagString(args, "skip", "0")),
      limit: Number(flagString(args, "limit", "20")),
    }, 30000);
  }
  if (subcommand === "get") {
    const id = flagString(args, "id");
    if (!id) return fail("INVALID_REQUEST", "store get requires --id.");
    return rpcEval(args, storeGetSnippet(), { id }, 30000);
  }
  if (subcommand === "download") {
    const id = flagString(args, "id");
    const name = flagString(args, "name");
    const license = await readJsonFlag(args, "license-json");
    if (!id || !name || license === undefined) {
      return fail("INVALID_REQUEST", "store download requires --id, --name, and --license-json.");
    }
    return rpcEval(args, storeDownloadSnippet(), {
      id,
      name,
      license: objectJson(license, "license") as unknown as JsonValue,
      folderId: flagString(args, "folder-id") || null,
    }, 120000);
  }
  return fail("UNKNOWN_COMMAND", `Unknown store command: ${subcommand}`);
}

async function handleTarget(args: Args): Promise<Envelope> {
  const subcommand = args._[1];
  if (subcommand === "focus") {
    if (!flagString(args, "target")) {
      return fail("INVALID_REQUEST", "target focus requires an explicit --target selector.");
    }
    return rpcCall(args, "bridge:focusTarget");
  }
  return fail("UNKNOWN_COMMAND", `Unknown target command: ${subcommand || ""}`);
}

function launchReadinessSuggestions(data: Record<string, JsonValue>): string[] {
  const blockers = Array.isArray(data.readinessBlockers)
    ? data.readinessBlockers.map(String)
    : [];
  const suggestions: string[] = [];
  if (blockers.includes("tab-hidden")) {
    suggestions.push("Run pcbridge target focus with the same --target selector.");
  }
  if (
    blockers.includes("runtime-not-created") ||
    blockers.includes("runtime-not-started") ||
    blockers.includes("graphics-not-ready") ||
    blockers.includes("scene-not-loaded")
  ) {
    suggestions.push("Focus the Launch tab and wait; refresh it if the state remains unchanged.");
  }
  if (blockers.includes("graphics-context-lost")) {
    suggestions.push("Refresh the Launch tab to recreate its graphics context.");
  }
  if (blockers.includes("splash-visible")) {
    suggestions.push("Wait for the PlayCanvas startup splash to finish.");
  }
  return suggestions;
}

async function diagnoseLaunch(args: Args, pollTimeoutMs = 3000): Promise<Envelope> {
  const raw = await rpcCall(args, "bridge:describeTarget", {}, pollTimeoutMs, false);
  if (!raw.ok) return raw;
  const data = objectJson(raw.data, "Launch target status");
  if (data.kind !== "launch") {
    return fail(
      "INVALID_TARGET_KIND",
      `Selected target is ${String(data.kind || "unknown")}; choose launch:<sceneId> or a Launch tab:<id>.`,
      raw.meta,
      raw.data,
    );
  }
  return ok({
    ...data,
    suggestions: launchReadinessSuggestions(data),
  }, raw.meta);
}

async function handleLaunch(args: Args): Promise<Envelope> {
  const subcommand = args._[1] || "diagnose";
  if (!flagString(args, "target")) {
    return fail("INVALID_REQUEST", "launch commands require an explicit --target selector.");
  }
  if (subcommand === "diagnose") return diagnoseLaunch(args);
  if (subcommand !== "wait-ready") {
    return fail("UNKNOWN_COMMAND", `Unknown launch command: ${subcommand}`);
  }

  const timeoutMs = readTimeoutMs(args, 30000);
  if (timeoutMs === null) return invalidTimeoutEnvelope();
  if (flagBool(args, "focus")) {
    const focused = await rpcCall(args, "bridge:focusTarget", {}, 5000);
    if (!focused.ok) return focused;
  }

  const startedAt = Date.now();
  let last: Envelope | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    last = await diagnoseLaunch(args, Math.max(1, Math.min(3000, remainingMs)));
    if (!last.ok) return last;
    const data = objectJson(last.data, "Launch target status");
    if (data.ready === true) {
      return ok({
        ready: true,
        waitedMs: Date.now() - startedAt,
        target: data as unknown as JsonValue,
      }, last.meta);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  const lastData = last && last.ok
    ? objectJson(last.data, "Launch target status")
    : {};
  const blockers = Array.isArray(lastData.readinessBlockers)
    ? lastData.readinessBlockers.map(String).join(", ")
    : "unknown";
  return fail(
    "LAUNCH_NOT_READY",
    `Launch did not become ready within ${timeoutMs}ms (blockers: ${blockers}).`,
    last?.meta,
    last && last.ok ? last.data : null,
  );
}

async function handleViewport(args: Args): Promise<Envelope> {
  const subcommand = args._[1];
  if (subcommand === "focus") {
    const ids = flagList(args, "id");
    const id = flagString(args, "id");
    if (!ids.length && !id) return fail("INVALID_REQUEST", "viewport focus requires --id.");
    return rpcCall(args, "bridge:focusViewport", {
      ids: ids as unknown as JsonValue,
      id: id || null,
      view: flagString(args, "view") || null,
      yaw: flagString(args, "yaw") === undefined ? null : Number(flagString(args, "yaw")),
      pitch: flagString(args, "pitch") === undefined ? null : Number(flagString(args, "pitch")),
    });
  }

  if (subcommand !== "capture") {
    return fail("UNKNOWN_COMMAND", `Unknown viewport command: ${subcommand || ""}`);
  }

  const raw = await rpcCall(args, "bridge:captureViewport", {
    format: flagString(args, "format") || "png",
    quality: Number(flagString(args, "quality", "0.85")),
    maxWidth: Number(flagString(args, "max-width", "1200")),
  });
  if (!raw.ok) return raw;

  const data = raw.data as { base64?: string; mime?: string; width?: number; height?: number };
  const requestedOut = flagString(args, "out");
  const out = requestedOut
    ? await resolveWorkspaceFile(args, requestedOut, "viewport output")
    : undefined;
  if (out && data.base64) {
    await writeFile(out, Buffer.from(data.base64, "base64"));
    return ok(
      {
        path: out,
        mime: data.mime || null,
        width: data.width || null,
        height: data.height || null,
      },
      raw.meta,
    );
  }

  return raw;
}

async function handleLogs(args: Args): Promise<Envelope> {
  const subcommand = args._[1] || "get";

  if (subcommand === "get" || subcommand === "list") {
    return listEnvelope(
      await rpcCall(args, "bridge:getLogs", {
        level: flagString(args, "level") || null,
        limit: Number(flagString(args, "limit", "100")),
        offset: flagString(args, "offset") === undefined ? null : Number(flagString(args, "offset")),
        since: flagString(args, "since") || null,
      }),
    );
  }

  if (subcommand === "clear") {
    return rpcCall(args, "bridge:clearLogs");
  }

  return fail("UNKNOWN_COMMAND", `Unknown logs command: ${subcommand}`);
}

async function handleWorkspace(args: Args): Promise<Envelope> {
  const subcommand = args._[1] || "status";
  const target = flagString(args, "target", "current") || "current";

  if (subcommand === "status") {
    return fetchDaemon(`/workspace/status?target=${encodeURIComponent(target)}`);
  }
  if (subcommand === "path") {
    const status = await fetchDaemon(`/workspace/status?target=${encodeURIComponent(target)}`);
    if (!status.ok) return status;
    const data = objectJson(status.data, "workspace status");
    return ok({
      rootDirectory: data.rootDirectory || null,
      projectDirectory: data.projectDirectory || null,
      assetsDirectory: data.assetsDirectory || null,
      tmpDirectory: data.tmpDirectory || null,
    });
  }
  if (subcommand === "sync") {
    return fetchDaemon("/workspace/sync", {
      method: "POST",
      body: JSON.stringify({ target }),
    });
  }
  if (subcommand === "pull") {
    const assetId = flagString(args, "asset") || flagString(args, "asset-id") || flagString(args, "id");
    if (!assetId) return fail("INVALID_REQUEST", "workspace pull requires --asset <assetId>.");
    return fetchDaemon("/workspace/pull", {
      method: "POST",
      body: JSON.stringify({ target, assetId }),
    });
  }
  return fail("UNKNOWN_COMMAND", `Unknown workspace command: ${subcommand}`);
}

async function handleBuilder(args: Args): Promise<Envelope> {
  const subcommand = args._[1] || "status";
  if (subcommand === "start" || subcommand === "build") {
    const templateAssetId = flagString(args, "asset") ||
      flagString(args, "asset-id") ||
      flagString(args, "id");
    if (!templateAssetId) {
      return fail("INVALID_REQUEST", "builder start requires --asset <templateAssetId>.");
    }
    return fetchDaemon("/builder/jobs", {
      method: "POST",
      body: JSON.stringify({
        target: flagString(args, "target", "current") || "current",
        templateAssetId,
        suffix: flagString(args, "suffix") || "",
        prefix: flagString(args, "prefix") || "",
      }),
    });
  }
  if (subcommand === "status") {
    const jobId = flagString(args, "job") || flagString(args, "id");
    if (!jobId) return fail("INVALID_REQUEST", "builder status requires --job <jobId>.");
    return fetchDaemon(`/builder/jobs/${encodeURIComponent(jobId)}`);
  }
  return fail("UNKNOWN_COMMAND", `Unknown builder command: ${subcommand}`);
}

function help(group = "overview"): Envelope {
  const groups: Record<string, string[]> = {
    overview: [
      "pcbridge help core",
      "pcbridge help workspace",
      "pcbridge help builder",
      "pcbridge help frontend",
      "pcbridge help target",
      "pcbridge help entity",
      "pcbridge help asset",
      "pcbridge help material",
      "pcbridge help template",
      "pcbridge help script",
      "pcbridge help scene",
      "pcbridge help store",
      "pcbridge help viewport",
      "pcbridge help launch",
      "pcbridge help logs",
      "pcbridge help eval",
    ],
    core: [
      "pcbridge doctor",
      "pcbridge install-extension",
      "pcbridge install-skill --agent codex|claude|cursor|windsurf|all",
      "pcbridge daemon start",
      "pcbridge daemon status",
      "pcbridge targets",
      "pcbridge version",
    ],
    target: [
      "pcbridge target focus --target launch:<sceneId>",
      "pcbridge target focus --target tab:<id>",
      "Focus activates both the PlayCanvas tab and its Chrome window.",
      "Use editor:<sceneId> for writes and launch:<sceneId> for runtime checks; current can be ambiguous.",
    ],
    workspace: [
      "pcbridge workspace status --target editor:<sceneId>",
      "pcbridge workspace path --target editor:<sceneId>",
      "pcbridge workspace sync --target editor:<sceneId>",
      "pcbridge workspace pull --target editor:<sceneId> --asset <assetId>",
      "The directory where `pcbridge daemon start` runs is the workspace root.",
    ],
    builder: [
      "pcbridge builder start --target editor:<sceneId> --asset <template_asset_id> [--suffix '-${time}'] [--prefix assets]",
      "pcbridge builder status --job <build_job_id>",
      "Template assets also show a pcbridge Tiny Builder panel in the PlayCanvas Editor.",
      "S3 settings come from the project .env, then the workspace-root .env; files upload directly without a ZIP.",
    ],
    frontend: [
      "pcbridge frontend install [latest|playcanvas-editor-v<version>-r<revision>] [--no-activate]",
      "pcbridge frontend update",
      "pcbridge frontend status",
      "pcbridge frontend list",
      "pcbridge frontend use playcanvas-editor-v<version>-r<revision>",
      "pcbridge frontend remove playcanvas-editor-v<version>-r<revision>",
      "The active frontend is served from http://localhost:3487 while the daemon is running.",
    ],
    entity: [
      "pcbridge entity list --target editor:<sceneId> [--limit 50] [--offset 0] [--name Player] [--component render] [--tag enemy] [--full]",
      "pcbridge entity get --target editor:<sceneId> --id <resource_id> [--full]",
      "pcbridge entity create --target editor:<sceneId> --json ./entity.json",
      "pcbridge entity create-many --target editor:<sceneId> --json ./entities.json",
      "pcbridge entity patch --target editor:<sceneId> --id <resource_id> --set position='[0,1,0]'",
      "pcbridge entity patch-many --target editor:<sceneId> --json ./edits.json",
      "pcbridge entity duplicate --target editor:<sceneId> --id <resource_id>",
      "pcbridge entity reparent --target editor:<sceneId> --id <resource_id> --parent <parent_resource_id> [--index 0] [--no-preserve-transform]",
      "pcbridge entity add-component --target editor:<sceneId> --id <resource_id> --component render --data '{\"type\":\"box\"}'",
      "pcbridge entity add-components --target editor:<sceneId> --id <resource_id> --json ./components.json",
      "pcbridge entity remove-component --target editor:<sceneId> --id <resource_id> --component render",
      "pcbridge entity remove-components --target editor:<sceneId> --id <resource_id> --component render --component collision",
      "pcbridge entity set-material --target editor:<sceneId> --id <resource_id> --material-id <asset_id>",
      "pcbridge entity add-script --target editor:<sceneId> --id <resource_id> (--asset-id <script_asset_id> | --script-name <registered_type>) [--attributes-json ./attrs.json] [--disabled]",
      "pcbridge entity delete --target editor:<sceneId> --id <resource_id>",
    ],
    asset: [
      "pcbridge asset list --target editor:<sceneId> [--type script] [--name controller] [--tag ui] [--limit 50] [--offset 0] [--full]",
      "pcbridge asset get --target editor:<sceneId> --id <asset_id> [--full]",
      "pcbridge asset create --target editor:<sceneId> --json ./assets.json",
      "pcbridge asset folder ensure --target editor:<sceneId> --path \"AI Agent Bridge/Task/Textures\"",
      "pcbridge asset upload --target editor:<sceneId> --file ./texture.png --folder \"AI Agent Bridge/Task/Textures\"",
      "pcbridge asset upload-many --target editor:<sceneId> --json ./upload-manifest.json",
      "pcbridge asset instantiate --target editor:<sceneId> --id <template_asset_id>",
      "pcbridge asset delete --target editor:<sceneId> --id <asset_id>",
    ],
    material: [
      "pcbridge material create --target editor:<sceneId> --name Mat --diffuse-map <texture_asset_id>",
      "pcbridge material patch --target editor:<sceneId> --asset-id <asset_id> --set diffuse='[1,0,0]'",
      "pcbridge material patch --target editor:<sceneId> --asset-id <asset_id> --json ./material-data.json",
      "pcbridge material set-diffuse --target editor:<sceneId> --asset-id <asset_id> --color '[1,0,0]'",
    ],
    template: [
      "pcbridge template create --target editor:<sceneId> --entity-id <resource_id> --name TemplateName --folder \"AI Agent Bridge/Task/Templates\"",
      "pcbridge template instantiate --target editor:<sceneId> --id <template_asset_id>",
      "pcbridge template overrides --target editor:<sceneId> --entity-id <resource_id>",
      "pcbridge template apply --target editor:<sceneId> --entity-id <resource_id> [--timeout-ms 60000]",
      "pcbridge template apply-many --target editor:<sceneId> --json ./template-roots.json [--timeout-ms 120000]",
      "When apply is needed, completion requires the pipeline callback plus two zero-override observations; timeout is an error.",
      "verified covers the current Editor observer only, not persistence across a reload; apply-many runs serially.",
    ],
    script: [
      "pcbridge script upsert --target editor:<sceneId> --filename controller.js --file ./controller.js --folder \"AI Agent Bridge/Task/Scripts\" [--parse] [--wait]",
      "pcbridge script create --target editor:<sceneId> --filename controller.js --file ./controller.js",
      "pcbridge script set-text --target editor:<sceneId> --asset-id <asset_id> --file ./controller.js [--parse] [--wait]",
      "pcbridge script parse --target editor:<sceneId> --asset-id <asset_id> [--timeout-ms 60000]",
      "Combine --parse --wait for completion-checked updates; it verifies remote content and current Editor metadata, not a later workspace mirror sync.",
    ],
    scene: [
      "pcbridge scene settings get --target editor:<sceneId>",
      "pcbridge scene settings patch --target editor:<sceneId> --json ./scene-settings.json",
      "pcbridge scene settings patch --target editor:<sceneId> --set render.fog='\"linear\"' --set physics.gravity='[0,-9.8,0]'",
    ],
    store: [
      "pcbridge store search --target editor:<sceneId> --search vehicle --limit 20",
      "pcbridge store get --target editor:<sceneId> --id <store_asset_id>",
      "pcbridge store download --target editor:<sceneId> --id <store_asset_id> --name AssetName --license-json ./license.json",
    ],
    viewport: [
      "pcbridge viewport capture --target editor:<sceneId> --out ./tmp/viewport.png [--format png|webp] [--max-width 1200] [--quality 0.85]",
      "pcbridge viewport capture --target launch:<sceneId> --out ./tmp/launch.png [--format png|webp] [--max-width 1200] [--quality 0.85]",
      "pcbridge viewport focus --target editor:<sceneId> --id <resource_id> [--view perspective|top|bottom|front|back|left|right] [--yaw 45] [--pitch -25]",
      "Capture defaults to max-width 1200 and may downscale the current canvas; it does not resize Chrome or emulate DPR.",
    ],
    launch: [
      "pcbridge targets",
      "pcbridge launch diagnose --target launch:<sceneId>",
      "pcbridge launch wait-ready --target launch:<sceneId> [--focus] [--timeout-ms 30000]",
      "pcbridge target focus --target launch:<sceneId>",
      "pcbridge eval --target launch:<sceneId> --code \"return { href: location.href, runtimeCreated: !!runtimeApp, rootChildCount: runtimeApp?.root?.children?.length ?? 0 }\"",
      "pcbridge viewport capture --target launch:<sceneId> --out ./tmp/launch.png [--format png|webp]",
      "pcbridge logs get --target launch:<sceneId> [--limit 100] [--level error|warn|info|debug] [--since <seq>]",
      "pcbridge logs clear --target launch:<sceneId>",
      "Use --target tab:<id> when multiple Launch tabs are open for the same scene.",
      "ready is a best-effort heuristic requiring a visible tab, owned graphics canvas, attached scene, completed first frame, and no recognized splash.",
      "scriptsReady/scriptTypeCount are diagnostic only; they do not prove every ScriptType registered.",
    ],
    logs: [
      "pcbridge logs get --target editor:<sceneId> [--limit 100] [--offset 0] [--level error|warn|info|debug] [--since <seq>]",
      "pcbridge logs get --target launch:<sceneId> [--limit 100] [--offset 0] [--level error|warn|info|debug] [--since <seq>]",
      "pcbridge logs clear --target editor:<sceneId>",
      "pcbridge logs clear --target launch:<sceneId>",
    ],
    log: [
      "pcbridge logs get --target editor:<sceneId> [--limit 100] [--offset 0] [--level error|warn|info|debug] [--since <seq>]",
      "pcbridge logs get --target launch:<sceneId> [--limit 100] [--offset 0] [--level error|warn|info|debug] [--since <seq>]",
      "pcbridge logs clear --target editor:<sceneId>",
      "pcbridge logs clear --target launch:<sceneId>",
    ],
    eval: [
      "Use eval for custom Editor/Engine workflows, PlayCanvas Launch debugging, large multi-step scene edits, exploratory API inspection, and operations not yet structured.",
      "pcbridge eval --target editor:<sceneId> --code \"return { href: location.href, hasEditor: !!editor }\" [--timeout-ms 15000]",
      "pcbridge eval --target launch:<sceneId> --code \"return { href: location.href, runtimeCreated: !!runtimeApp, rootChildCount: runtimeApp?.root?.children?.length ?? 0 }\"",
      "pcbridge eval --target editor:<sceneId> --file ./task.js [--timeout-ms 15000]",
      "pcbridge eval --target editor:<sceneId> --file ./task.js --args-json ./task-args.json [--timeout-ms 15000]",
      "pcbridge eval --target editor:<sceneId> --stdin [--timeout-ms 15000]",
      "Add --max-depth <1..20>, --max-items <1..5000>, --max-keys <1..2000>, or --max-string <1..100000> only when a compact projection is insufficient.",
    ],
  };

  const commands = groups[group];
  if (!commands) {
    return fail("UNKNOWN_HELP_TOPIC", `Unknown help topic: ${group}.`, undefined, Object.keys(groups) as unknown as JsonValue);
  }
  return ok({
    topic: group,
    commands,
  });
}

function usage(): Envelope {
  return help("overview");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";

  if (command === "daemon") {
    await daemon(args);
    return;
  }

  try {
    if (command !== "help" && args._[1] === "help") {
      print(help(command));
    } else if (command === "help" || command === "--help" || command === "-h") {
      print(help(args._[1] || "overview"));
    } else if (command === "doctor") {
      print(await doctor());
    } else if (command === "install-extension") {
      print(await installExtension(args));
    } else if (command === "install-skill") {
      print(await installSkill(args));
    } else if (command === "frontend") {
      print(await handleFrontend(args));
    } else if (command === "targets") {
      print(await fetchDaemon("/targets"));
    } else if (command === "target") {
      print(await handleTarget(args));
    } else if (command === "workspace") {
      print(await handleWorkspace(args));
    } else if (command === "builder" || command === "build") {
      print(await handleBuilder(args));
    } else if (command === "eval") {
      const commandArgs = await readJsonFlag(args, "args-json");
      print(
        await rpcEval(
          args,
          await readCode(args),
          objectJson(commandArgs, "eval args") as Record<string, JsonValue>,
        ),
      );
    } else if (command === "entity") {
      print(await handleEntity(args));
    } else if (command === "asset") {
      print(await handleAsset(args));
    } else if (command === "material") {
      print(await handleMaterial(args));
    } else if (command === "template") {
      print(await handleTemplate(args));
    } else if (command === "script") {
      print(await handleScript(args));
    } else if (command === "scene") {
      print(await handleScene(args));
    } else if (command === "store") {
      print(await handleStore(args));
    } else if (command === "launch") {
      print(await handleLaunch(args));
    } else if (command === "viewport") {
      print(await handleViewport(args));
    } else if (command === "logs" || command === "log") {
      print(await handleLogs(args));
    } else if (command === "version" || command === "--version" || command === "-v") {
      print(ok({ version: VERSION }));
    } else {
      print(fail("UNKNOWN_COMMAND", `Unknown command: ${command}`));
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof DaemonConnectionError) {
      print(fail(
        error.diagnosis.code,
        error.diagnosis.message,
        undefined,
        { nextAction: error.diagnosis.nextAction },
      ));
      return;
    }
    print(fail("CLI_ERROR", error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;

  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entrypoint) === modulePath;
  } catch {
    return entrypoint === modulePath;
  }
}

const isMain = isCliEntrypoint();
if (isMain) {
  main();
}
