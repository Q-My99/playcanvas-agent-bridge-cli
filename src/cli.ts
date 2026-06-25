#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR,
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
  storeDownloadSnippet,
  storeGetSnippet,
  storeSearchSnippet,
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
  if (file) return readFile(file, "utf8");
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
  const response = await fetch(`http://${DEFAULT_HOST}:${session.port || DEFAULT_PORT}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-PCBridge-Token": session.token,
      ...(init.headers || {}),
    },
  });
  const body = (await response.json()) as Envelope;
  return body;
}

async function rpcCall(
  args: Args,
  method: string,
  params: Record<string, JsonValue> = {},
  defaultTimeoutMs = 15000,
): Promise<Envelope> {
  const timeoutMs = Number(flagString(args, "timeout-ms", String(defaultTimeoutMs)));
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

async function rpcEval(
  args: Args,
  code: string,
  commandArgs: Record<string, JsonValue> = {},
  defaultTimeoutMs = 15000,
): Promise<Envelope> {
  return rpcCall(args, "bridge:eval", {
    code,
    args: commandArgs as JsonValue,
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
  return JSON.parse(await readFile(file, "utf8")) as JsonValue;
}

function objectJson(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, JsonValue>;
}

async function doctor(): Promise<Envelope> {
  const session = await readSessionIfExists();
  const checks: JsonValue[] = [];
  const nextActions: string[] = [];
  const major = Number(process.versions.node.split(".", 1)[0]);

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
    checks.push({
      name: "daemon",
      ok: health.ok,
      message: health.ok ? "Daemon is reachable." : health.error.message,
      data: health.ok ? health.data : null,
    });
  } catch (error) {
    checks.push({
      name: "daemon",
      ok: false,
      message: "Daemon is not reachable.",
    });
    nextActions.push("Run pcbridge daemon start in a terminal.");
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
      checks.push({
        name: "connected-extension-version",
        ok: mismatched.length === 0,
        versions: connectedVersions as unknown as JsonValue,
        expectedVersion: VERSION,
        message: mismatched.length
          ? "One or more connected Editor tabs are using an older extension version."
          : "Connected extension versions match the package version.",
      });
      if (mismatched.length) {
        nextActions.push("Reload the unpacked extension and refresh the PlayCanvas Editor tab.");
      }
    }
  } catch {
    // Daemon reachability is already reported above.
  }

  return ok({
    version: VERSION,
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
        extensionPath: EXTENSION_INSTALL_DIR,
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
      "Open or refresh a PlayCanvas Editor tab, then run pcbridge daemon start.",
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
    const data = JSON.parse(await readFile(file, "utf8")) as JsonValue;
    return rpcEval(args, entityCreateSnippet(), { data });
  }
  if (subcommand === "create-many") {
    const file = flagString(args, "json");
    if (!file) return fail("INVALID_REQUEST", "entity create-many requires --json <file>.");
    const data = JSON.parse(await readFile(file, "utf8")) as JsonValue;
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
    const data = JSON.parse(await readFile(file, "utf8")) as JsonValue;
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
    const attributes =
      (await readJsonFlag(args, "attributes-json")) ??
      (flagString(args, "attributes") ? parseJsonValue(flagString(args, "attributes") || "{}") : {});
    return rpcEval(args, entityAddScriptSnippet(), {
      id,
      scriptName: flagString(args, "script-name") || null,
      assetId: flagString(args, "asset-id") || null,
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
    const data = JSON.parse(await readFile(file, "utf8")) as JsonValue;
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
    const fileBuffer = await readFile(file);
    const type = flagString(args, "type") || inferAssetType(file);
    if (!type) return fail("INVALID_REQUEST", "asset upload requires --type for this file.");
    const filename = flagString(args, "filename") || basename(file);
    return rpcCall(
      args,
      "bridge:uploadAsset",
      {
        base64: fileBuffer.toString("base64"),
        mime: flagString(args, "mime") || inferMime(file),
        name: flagString(args, "name") || nameFromFile(file),
        filename,
        type,
        folder: flagString(args, "folder") || null,
        folderId: flagString(args, "folder-id") || null,
        preload: !flagBool(args, "no-preload"),
      },
      120000,
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

async function handleScript(args: Args): Promise<Envelope> {
  const subcommand = args._[1];
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
        text: await readFile(file, "utf8"),
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
    return rpcEval(args, scriptSetTextSnippet(), {
      assetId,
      text: await readFile(file, "utf8"),
    });
  }
  if (subcommand === "parse") {
    const assetId = flagString(args, "asset-id");
    if (!assetId) return fail("INVALID_REQUEST", "script parse requires --asset-id.");
    return rpcEval(args, scriptParseSnippet(), { assetId });
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
  const out = flagString(args, "out");
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

function help(group = "overview"): Envelope {
  const groups: Record<string, string[]> = {
    overview: [
      "pcbridge help core",
      "pcbridge help entity",
      "pcbridge help asset",
      "pcbridge help material",
      "pcbridge help script",
      "pcbridge help scene",
      "pcbridge help store",
      "pcbridge help viewport",
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
    entity: [
      "pcbridge entity list --target current --limit 50 [--name Player] [--component render] [--tag enemy] [--full]",
      "pcbridge entity get --target current --id <resource_id> [--full]",
      "pcbridge entity create --target current --json ./entity.json",
      "pcbridge entity create-many --target current --json ./entities.json",
      "pcbridge entity patch --target current --id <resource_id> --set position='[0,1,0]'",
      "pcbridge entity patch-many --target current --json ./edits.json",
      "pcbridge entity duplicate --target current --id <resource_id> [--no-rename]",
      "pcbridge entity reparent --target current --id <resource_id> --parent <parent_resource_id> [--index 0] [--no-preserve-transform]",
      "pcbridge entity add-component --target current --id <resource_id> --component render --data '{\"type\":\"box\"}'",
      "pcbridge entity add-components --target current --id <resource_id> --json ./components.json",
      "pcbridge entity remove-component --target current --id <resource_id> --component render",
      "pcbridge entity set-material --target current --id <resource_id> --material-id <asset_id>",
      "pcbridge entity add-script --target current --id <resource_id> --asset-id <script_asset_id> --attributes-json ./attrs.json",
      "pcbridge entity delete --target current --id <resource_id>",
    ],
    asset: [
      "pcbridge asset list --target current [--type script] [--name controller] [--tag ui] [--limit 50] [--full]",
      "pcbridge asset get --target current --id <asset_id> [--full]",
      "pcbridge asset create --target current --json ./assets.json",
      "pcbridge asset folder ensure --target current --path \"AI Agent Bridge/Task/Textures\"",
      "pcbridge asset upload --target current --file ./texture.png --folder \"AI Agent Bridge/Task/Textures\"",
      "pcbridge asset instantiate --target current --id <template_asset_id>",
      "pcbridge asset delete --target current --id <asset_id>",
    ],
    material: [
      "pcbridge material create --target current --name Mat --diffuse-map <texture_asset_id>",
      "pcbridge material patch --target current --asset-id <asset_id> --set diffuse='[1,0,0]'",
      "pcbridge material patch --target current --asset-id <asset_id> --json ./material-data.json",
      "pcbridge material set-diffuse --target current --asset-id <asset_id> --color '[1,0,0]'",
    ],
    script: [
      "pcbridge script create --target current --filename controller.js --file ./controller.js",
      "pcbridge script set-text --target current --asset-id <asset_id> --file ./controller.js",
      "pcbridge script parse --target current --asset-id <asset_id>",
    ],
    scene: [
      "pcbridge scene settings get --target current",
      "pcbridge scene settings patch --target current --json ./scene-settings.json",
      "pcbridge scene settings patch --target current --set render.fog='\"linear\"' --set physics.gravity='[0,-9.8,0]'",
    ],
    store: [
      "pcbridge store search --target current --search vehicle --limit 20",
      "pcbridge store get --target current --id <store_asset_id>",
      "pcbridge store download --target current --id <store_asset_id> --name AssetName --license-json ./license.json",
    ],
    viewport: [
      "pcbridge viewport capture --target current --out ./tmp/viewport.png [--format png|webp]",
      "pcbridge viewport focus --target current --id <resource_id> [--view perspective|top|bottom|front|back|left|right]",
    ],
    eval: [
      "Use eval for custom Editor/Engine workflows, large multi-step scene edits, exploratory API inspection, and operations not yet structured.",
      "pcbridge eval --target current --code \"return { href: location.href, hasEditor: !!editor }\"",
      "pcbridge eval --target current --file ./task.js",
      "pcbridge eval --target current --stdin",
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
    } else if (command === "targets") {
      print(await fetchDaemon("/targets"));
    } else if (command === "eval") {
      print(await rpcEval(args, await readCode(args)));
    } else if (command === "entity") {
      print(await handleEntity(args));
    } else if (command === "asset") {
      print(await handleAsset(args));
    } else if (command === "material") {
      print(await handleMaterial(args));
    } else if (command === "script") {
      print(await handleScript(args));
    } else if (command === "scene") {
      print(await handleScene(args));
    } else if (command === "store") {
      print(await handleStore(args));
    } else if (command === "viewport") {
      print(await handleViewport(args));
    } else if (command === "version" || command === "--version" || command === "-v") {
      print(ok({ version: VERSION }));
    } else {
      print(fail("UNKNOWN_COMMAND", `Unknown command: ${command}`));
      process.exitCode = 1;
    }
  } catch (error) {
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
