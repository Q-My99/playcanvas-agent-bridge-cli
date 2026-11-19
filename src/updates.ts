import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  compareSemver,
  CONFIG_DIR,
  EXTENSION_INSTALL_DIR,
  findPackageRoot,
  INSTALLED_SKILLS_FILE,
  PACKAGE_NAME,
  UPDATE_STATE_FILE,
  VERSION,
} from "./config.js";
import {
  PluginStore,
  type AvailablePlugin,
  type OfficialPluginCatalogEntry,
  type PluginSummary,
} from "./plugins/store.js";
import type { JsonValue } from "./shared/protocol.js";

export const UPDATE_CACHE_TTL_MS = 60 * 60 * 1000;
export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

export type InstallKind = "source" | "bun-global" | "npm-global" | "pnpm-global";

export type CachedUpdateState = {
  schemaVersion: 1;
  checkedAt: string;
  latestCoreVersion: string | null;
  officialCatalog: OfficialPluginCatalogEntry[];
};

export type InstalledSkillTarget = {
  agent: "codex" | "claude" | "cursor" | "windsurf";
  customParent: string | null;
};

export type CoreUpdateStatus = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  installKind: InstallKind;
  canSelfUpdate: boolean;
  daemonVersion: string | null;
  daemonRestartRequired: boolean;
  generatedExtensionVersion: string | null;
  extensionRegenerateRequired: boolean;
  connectedExtensionVersions: string[];
  extensionReloadRequired: boolean;
  tabRefreshRequired: boolean;
  command: string;
};

export type PluginUpdateStatus = {
  id: string;
  name: string;
  enabled: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  compatible: boolean;
  minPcbridgeVersion: string | null;
  sourceType: string;
  command: string;
};

export type UpdateReport = {
  checkedAt: string | null;
  hasUpdates: boolean;
  core: CoreUpdateStatus;
  plugins: PluginUpdateStatus[];
  availableOfficialPlugins: AvailablePlugin[];
  nextActions: string[];
};

export async function detectInstallKind(packageRoot?: string): Promise<InstallKind> {
  const mocked = process.env.PCBRIDGE_UPDATE_MOCK_INSTALL_KIND;
  if (
    mocked === "source" ||
    mocked === "bun-global" ||
    mocked === "npm-global" ||
    mocked === "pnpm-global"
  ) {
    return mocked;
  }
  try {
    const root = packageRoot || (await findPackageRoot());
    if (existsSync(join(root, ".git"))) {
      return "source";
    }
    const normalized = root.replaceAll("\\", "/");
    if (normalized.includes("/.bun/") || normalized.includes("/bun/install/global")) {
      return "bun-global";
    }
    if (normalized.includes("/pnpm")) {
      return "pnpm-global";
    }
    if (normalized.includes("/node_modules/")) {
      return process.versions.bun ? "bun-global" : "npm-global";
    }
  } catch {
    // Fall through to default below.
  }
  return "bun-global";
}

export function globalInstallCommand(
  installKind: InstallKind,
  targetVersion = "latest",
  registry?: string,
): { command: string; args: string[]; display: string } {
  const spec = `${PACKAGE_NAME}@${targetVersion}`;
  const registryArgs = registry ? [`--registry=${registry}`] : [];
  const registrySuffix = registry ? ` --registry=${registry}` : "";
  if (installKind === "pnpm-global") {
    return {
      command: "pnpm",
      args: ["add", "--global", spec, ...registryArgs],
      display: `pnpm add --global ${spec}${registrySuffix}`,
    };
  }
  if (installKind === "npm-global") {
    return {
      command: "npm",
      args: ["install", "--global", spec, ...registryArgs],
      display: `npm install --global ${spec}${registrySuffix}`,
    };
  }
  return {
    command: process.execPath,
    args: ["add", "--global", spec, ...registryArgs],
    display: `bun add --global ${spec}${registrySuffix}`,
  };
}

export function isRegistryVersionLagError(output: string): boolean {
  return /no (?:matching )?version|ETARGET|ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_FETCH_404|E404|404 Not Found|failed to resolve/i.test(
    output,
  );
}

export async function readGeneratedExtensionVersion(
  extensionDir = EXTENSION_INSTALL_DIR,
): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await readFile(join(extensionDir, "manifest.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

export async function readCachedUpdateState(
  stateFile = UPDATE_STATE_FILE,
): Promise<CachedUpdateState | null> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as CachedUpdateState;
    if (parsed && parsed.schemaVersion === 1 && typeof parsed.checkedAt === "string") {
      return {
        schemaVersion: 1,
        checkedAt: parsed.checkedAt,
        latestCoreVersion:
          typeof parsed.latestCoreVersion === "string" ? parsed.latestCoreVersion : null,
        officialCatalog: Array.isArray(parsed.officialCatalog) ? parsed.officialCatalog : [],
      };
    }
  } catch {
    // Ignore missing or invalid cache.
  }
  return null;
}

export async function writeCachedUpdateState(
  state: CachedUpdateState,
  stateFile = UPDATE_STATE_FILE,
): Promise<void> {
  const dir = resolve(stateFile, "..");
  await mkdir(dir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tempFile, stateFile);
}

export async function fetchLatestNpmVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url =
    process.env.PCBRIDGE_NPM_LATEST_URL !== undefined
      ? process.env.PCBRIDGE_NPM_LATEST_URL
      : `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
  if (!url) return null;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.npm.install-v1+json, application/json",
        "User-Agent": `${PACKAGE_NAME}/${VERSION}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { version?: unknown };
    if (typeof parsed.version === "string" && /^\d+\.\d+\.\d+/.test(parsed.version)) {
      return parsed.version;
    }
  } catch {
    // Offline or unreachable registry degrades gracefully.
  }
  return null;
}

export async function getUpdateReport(
  options: {
    refresh?: boolean;
    allowNetwork?: boolean;
    configDir?: string;
    store?: PluginStore;
    daemonVersion?: string | null;
    connectedExtensionVersions?: string[];
    fetch?: typeof fetch;
  } = {},
): Promise<UpdateReport> {
  const configDir = options.configDir || CONFIG_DIR;
  const stateFile = join(configDir, "update-state.json");
  const extensionDir = join(configDir, "extension");
  const fetchImpl = options.fetch || fetch;
  const store =
    options.store ||
    new PluginStore(join(configDir, "plugins"), { fetch: fetchImpl });

  let cached = await readCachedUpdateState(stateFile);
  const cacheAge = cached?.checkedAt ? Date.now() - Date.parse(cached.checkedAt) : Infinity;
  const shouldFetch =
    options.allowNetwork !== false &&
    (options.refresh === true || !cached || Number.isNaN(cacheAge) || cacheAge > UPDATE_CACHE_TTL_MS);

  if (shouldFetch) {
    const [latestCoreVersion, catalogMap] = await Promise.all([
      fetchLatestNpmVersion(fetchImpl),
      store.catalog({ refresh: true }),
    ]);
    cached = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      latestCoreVersion: latestCoreVersion || cached?.latestCoreVersion || null,
      officialCatalog: [...catalogMap.values()],
    };
    await writeCachedUpdateState(cached, stateFile).catch(() => undefined);
  }

  const [installKind, generatedExtensionVersion, summaries, availableOfficialPlugins] =
    await Promise.all([
      detectInstallKind(),
      readGeneratedExtensionVersion(extensionDir),
      store.summaries({ refresh: false, allowNetwork: false }),
      store.available({ refresh: false, allowNetwork: false }),
    ]);

  const currentVersion = VERSION;
  const latestVersion = cached?.latestCoreVersion || null;
  const updateAvailable = Boolean(
    latestVersion && compareSemver(latestVersion, currentVersion) > 0,
  );
  const targetCoreVersion =
    updateAvailable && latestVersion ? latestVersion : currentVersion;

  const daemonVersion = options.daemonVersion ?? null;
  const daemonRestartRequired = Boolean(
    daemonVersion && daemonVersion !== targetCoreVersion,
  );
  const extensionRegenerateRequired = Boolean(
    generatedExtensionVersion && generatedExtensionVersion !== targetCoreVersion,
  );
  const connectedExtensionVersions = (options.connectedExtensionVersions || []).filter(Boolean);
  const mismatchedConnected = connectedExtensionVersions.filter(
    (ver) => ver !== targetCoreVersion,
  );
  const extensionReloadRequired =
    extensionRegenerateRequired || mismatchedConnected.length > 0;
  const tabRefreshRequired = mismatchedConnected.length > 0;

  const coreNeedsAttention =
    updateAvailable ||
    daemonRestartRequired ||
    extensionRegenerateRequired ||
    extensionReloadRequired;

  const plugins: PluginUpdateStatus[] = summaries.map((item: PluginSummary) => ({
    id: item.id,
    name: item.name,
    enabled: item.enabled,
    currentVersion: item.version,
    latestVersion: item.latestVersion,
    updateAvailable: item.updateAvailable,
    compatible: item.compatible,
    minPcbridgeVersion: item.minPcbridgeVersion,
    sourceType: item.source.type,
    command: `pcbridge plugin update ${item.id}`,
  }));

  const outdatedPlugins = plugins.filter((item) => item.updateAvailable);
  const nextActions: string[] = [];

  if (updateAvailable) {
    if (installKind === "source") {
      nextActions.push(
        `pcbridge v${latestVersion} is available on npm (running from source checkout v${currentVersion}). Pull latest git changes and run bun run build.`,
      );
    } else {
      nextActions.push(
        `Run pcbridge update to upgrade CLI, daemon, skills, and Chrome extension from v${currentVersion} to v${latestVersion}.`,
      );
    }
  } else if (daemonRestartRequired || extensionReloadRequired) {
    nextActions.push(
      "Run pcbridge update to synchronize the local daemon, unpacked Chrome extension, and open PlayCanvas tabs.",
    );
  }

  if (outdatedPlugins.length === 1) {
    const item = outdatedPlugins[0];
    if (item.compatible) {
      nextActions.push(
        `Run pcbridge plugin update ${item.id} to upgrade ${item.name} from v${item.currentVersion} to v${item.latestVersion}.`,
      );
    } else {
      nextActions.push(
        `Plugin ${item.id} v${item.latestVersion} requires pcbridge v${item.minPcbridgeVersion}+; run pcbridge update first.`,
      );
    }
  } else if (outdatedPlugins.length > 1) {
    nextActions.push(
      `Run pcbridge plugin update --all to upgrade ${outdatedPlugins.length} outdated plugins (${outdatedPlugins.map((p) => p.id).join(", ")}).`,
    );
  }

  return {
    checkedAt: cached?.checkedAt || null,
    hasUpdates: coreNeedsAttention || outdatedPlugins.length > 0,
    core: {
      currentVersion,
      latestVersion,
      updateAvailable,
      installKind,
      canSelfUpdate: installKind !== "source",
      daemonVersion,
      daemonRestartRequired,
      generatedExtensionVersion,
      extensionRegenerateRequired,
      connectedExtensionVersions,
      extensionReloadRequired,
      tabRefreshRequired,
      command: "pcbridge update",
    },
    plugins,
    availableOfficialPlugins,
    nextActions,
  };
}

export function compactUpdatesMeta(report: UpdateReport): Record<string, JsonValue> | null {
  if (!report.hasUpdates) return null;
  const outdatedPlugins = report.plugins.filter((item) => item.updateAvailable);
  const coreNeedsAction =
    report.core.updateAvailable ||
    report.core.daemonRestartRequired ||
    report.core.extensionReloadRequired;
  const result: Record<string, JsonValue> = {};
  if (coreNeedsAction) {
    result.pcbridge = {
      currentVersion: report.core.currentVersion,
      latestVersion: report.core.latestVersion,
      updateAvailable: report.core.updateAvailable,
      daemonVersion: report.core.daemonVersion,
      daemonRestartRequired: report.core.daemonRestartRequired,
      extensionReloadRequired: report.core.extensionReloadRequired,
      tabRefreshRequired: report.core.tabRefreshRequired,
      command: report.core.command,
    };
  }
  if (outdatedPlugins.length > 0) {
    result.plugins = outdatedPlugins.map((item) => ({
      id: item.id,
      name: item.name,
      currentVersion: item.currentVersion,
      latestVersion: item.latestVersion,
      compatible: item.compatible,
      minPcbridgeVersion: item.minPcbridgeVersion,
      command: item.command,
    }));
  }
  if (report.nextActions.length > 0) {
    result.nextActions = report.nextActions;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function formatHumanUpdateHint(report: UpdateReport): string | null {
  if (!report.hasUpdates) return null;
  const parts: string[] = [];
  if (report.core.updateAvailable && report.core.latestVersion) {
    parts.push(`pcbridge v${report.core.currentVersion} -> v${report.core.latestVersion}`);
  } else if (report.core.daemonRestartRequired || report.core.extensionReloadRequired) {
    parts.push(`pcbridge local components out of sync (v${report.core.currentVersion})`);
  }
  for (const plugin of report.plugins) {
    if (plugin.updateAvailable && plugin.latestVersion) {
      parts.push(`plugin ${plugin.id} v${plugin.currentVersion} -> v${plugin.latestVersion}`);
    }
  }
  if (parts.length === 0) return null;
  const cmd =
    report.core.updateAvailable ||
    report.core.daemonRestartRequired ||
    report.core.extensionReloadRequired
      ? report.plugins.some((p) => p.updateAvailable)
        ? "pcbridge update --plugins"
        : "pcbridge update"
      : report.plugins.filter((p) => p.updateAvailable).length > 1
        ? "pcbridge plugin update --all"
        : `pcbridge plugin update ${report.plugins.find((p) => p.updateAvailable)!.id}`;
  return `[pcbridge] Update available: ${parts.join(", ")}. Run: ${cmd}`;
}

export async function recordInstalledSkills(
  targets: InstalledSkillTarget[],
  skillsFile = INSTALLED_SKILLS_FILE,
): Promise<void> {
  const existing = await readRecordedSkills(skillsFile);
  const map = new Map<string, InstalledSkillTarget>();
  for (const item of [...existing, ...targets]) {
    const key = `${item.agent}:${item.customParent || ""}`;
    map.set(key, item);
  }
  await mkdir(resolve(skillsFile, ".."), { recursive: true });
  await writeFile(
    skillsFile,
    `${JSON.stringify({ version: 1, targets: [...map.values()] }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function readRecordedSkills(
  skillsFile = INSTALLED_SKILLS_FILE,
): Promise<InstalledSkillTarget[]> {
  try {
    const parsed = JSON.parse(await readFile(skillsFile, "utf8")) as {
      targets?: InstalledSkillTarget[];
    };
    if (Array.isArray(parsed.targets)) {
      return parsed.targets.filter(
        (item): item is InstalledSkillTarget =>
          Boolean(
            item &&
              ["codex", "claude", "cursor", "windsurf"].includes(item.agent) &&
              (item.customParent === null || typeof item.customParent === "string"),
          ),
      );
    }
  } catch {
    // Ignore missing file.
  }
  return [];
}

export async function detectInstalledSkills(
  skillsFile = INSTALLED_SKILLS_FILE,
): Promise<InstalledSkillTarget[]> {
  const recorded = await readRecordedSkills(skillsFile);
  const map = new Map<string, InstalledSkillTarget>();
  for (const item of recorded) {
    if (!item.customParent || existsSync(item.customParent)) {
      map.set(`${item.agent}:${item.customParent || ""}`, item);
    }
  }

  if (process.env.PCBRIDGE_SKIP_HOME_SKILL_PROBE !== "1") {
    const defaults: Array<{ agent: InstalledSkillTarget["agent"]; checkPath: string }> = [
      {
        agent: "codex",
        checkPath: join(
          process.env.CODEX_HOME || join(homedir(), ".codex"),
          "skills",
          "playcanvas-agent-bridge-cli",
        ),
      },
      {
        agent: "claude",
        checkPath: join(homedir(), ".claude", "skills", "playcanvas-agent-bridge-cli"),
      },
      {
        agent: "cursor",
        checkPath: join(homedir(), ".cursor", "rules", "playcanvas-agent-bridge-cli.mdc"),
      },
      {
        agent: "windsurf",
        checkPath: join(homedir(), ".windsurf", "rules", "playcanvas-agent-bridge-cli.md"),
      },
    ];
    for (const candidate of defaults) {
      if (existsSync(candidate.checkPath)) {
        map.set(`${candidate.agent}:`, { agent: candidate.agent, customParent: null });
      }
    }
  }
  return [...map.values()];
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-4000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      resolveRun({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export async function installGlobalPackage(
  installKind: InstallKind,
  targetVersion: string,
  configDir: string,
  runner: typeof runCommand = runCommand,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const customCmd = process.env.PCBRIDGE_UPDATE_INSTALL_CMD;
  if (customCmd) {
    return runner(
      process.platform === "win32" ? "cmd" : "sh",
      process.platform === "win32" ? ["/c", customCmd] : ["-c", customCmd],
      { ...process.env, PCBRIDGE_TARGET_VERSION: targetVersion, PCBRIDGE_CONFIG_DIR: configDir },
    );
  }
  const childEnv = { ...process.env, PCBRIDGE_CONFIG_DIR: configDir };
  const primarySpec = globalInstallCommand(installKind, targetVersion);
  const primaryResult = await runner(primarySpec.command, primarySpec.args, childEnv);
  if (primaryResult.code === 0) {
    return primaryResult;
  }
  const fallbackRegistry =
    process.env.PCBRIDGE_NPM_FALLBACK_REGISTRY !== undefined
      ? process.env.PCBRIDGE_NPM_FALLBACK_REGISTRY
      : OFFICIAL_NPM_REGISTRY;
  if (
    fallbackRegistry &&
    isRegistryVersionLagError(`${primaryResult.stderr}\n${primaryResult.stdout}`)
  ) {
    const fallbackSpec = globalInstallCommand(installKind, targetVersion, fallbackRegistry);
    return runner(fallbackSpec.command, fallbackSpec.args, childEnv);
  }
  return primaryResult;
}

export type ExecuteUpdateResult = {
  previousVersion: string;
  version: string;
  latestVersion: string | null;
  installKind: InstallKind;
  packageUpdated: boolean;
  extensionPath: string;
  extensionVersion: string | null;
  extensionReloadTriggered: boolean;
  tabsReloadRequested: boolean;
  skillsRefreshed: number;
  daemonRestartTriggered: boolean;
  pluginsUpdated: {
    updated: Array<{ id: string; previousVersion: string | null; version: string | null }>;
    skipped: Array<{ id: string; reason: string }>;
  } | null;
  nextActions: string[];
};

export async function executeOneClickUpdate(options: {
  configDir?: string;
  store?: PluginStore;
  includePlugins?: boolean;
  reloadTabs?: boolean;
  daemonVersion?: string | null;
  connectedExtensionVersions?: string[];
  reloadConnectedExtension?: (reloadTabs: boolean) => Promise<boolean>;
  restartDaemon?: () => Promise<boolean>;
  updatePlugins?: () => Promise<{
    updated: Array<{ id: string; previousVersion: string | null; version: string | null }>;
    skipped: Array<{ id: string; reason: string }>;
  }>;
  fetch?: typeof fetch;
} = {}): Promise<ExecuteUpdateResult> {
  const configDir = options.configDir || CONFIG_DIR;
  const store =
    options.store ||
    new PluginStore(join(configDir, "plugins"), { fetch: options.fetch });
  const reloadTabs = options.reloadTabs !== false;
  const before = await getUpdateReport({
    refresh: true,
    configDir,
    store,
    daemonVersion: options.daemonVersion,
    connectedExtensionVersions: options.connectedExtensionVersions,
    fetch: options.fetch,
  });

  let packageUpdated = false;
  if (before.core.updateAvailable && before.core.canSelfUpdate) {
    const targetVersion = before.core.latestVersion || "latest";
    const installResult = await installGlobalPackage(
      before.core.installKind,
      targetVersion,
      configDir,
    );
    if (installResult.code !== 0) {
      throw Object.assign(
        new Error(
          `Global package update failed (exit ${installResult.code}): ${installResult.stderr || installResult.stdout || "unknown error"}`,
        ),
        { code: "UPDATE_INSTALL_FAILED" },
      );
    }
    packageUpdated = true;
  }

  const cliEntry =
    process.env.PCBRIDGE_UPDATE_CLI_PATH ||
    (process.argv[1] && existsSync(process.argv[1])
      ? process.argv[1]
      : join(await findPackageRoot(), "dist", "cli.js"));
  const childEnv = { ...process.env, PCBRIDGE_CONFIG_DIR: configDir };

  const extRun = await runCommand(
    process.execPath,
    [cliEntry, "install-extension", "--no-open"],
    childEnv,
  );
  if (extRun.code !== 0) {
    throw Object.assign(
      new Error(`Extension directory update failed: ${extRun.stderr || extRun.stdout}`),
      { code: "EXTENSION_UPDATE_FAILED" },
    );
  }

  let skillsRefreshed = 0;
  const skillRun = await runCommand(
    process.execPath,
    [cliEntry, "install-skill", "--refresh-installed"],
    childEnv,
  );
  if (skillRun.code === 0 && skillRun.stdout) {
    try {
      const parsed = JSON.parse(skillRun.stdout) as { ok?: boolean; data?: unknown[] };
      if (parsed.ok && Array.isArray(parsed.data)) {
        skillsRefreshed = parsed.data.length;
      }
    } catch {
      // Ignore non-JSON output.
    }
  }

  let pluginsUpdated: ExecuteUpdateResult["pluginsUpdated"] = null;
  if (options.includePlugins) {
    pluginsUpdated = options.updatePlugins
      ? await options.updatePlugins()
      : await store.updateAll();
  }

  const extensionPath = join(configDir, "extension");
  const extensionVersion = await readGeneratedExtensionVersion(extensionPath);
  const effectiveVersion =
    extensionVersion ||
    (packageUpdated && before.core.latestVersion
      ? before.core.latestVersion
      : before.core.currentVersion);

  let extensionReloadTriggered = false;
  if (
    options.reloadConnectedExtension &&
    (packageUpdated ||
      before.core.extensionReloadRequired ||
      before.core.connectedExtensionVersions.some((v) => v !== effectiveVersion))
  ) {
    extensionReloadTriggered = await options
      .reloadConnectedExtension(reloadTabs)
      .catch(() => false);
  }

  let daemonRestartTriggered = false;
  if (
    options.restartDaemon &&
    options.daemonVersion &&
    (packageUpdated || options.daemonVersion !== effectiveVersion)
  ) {
    daemonRestartTriggered = await options.restartDaemon().catch(() => false);
  }

  const nextActions: string[] = [];
  if (before.core.updateAvailable && !before.core.canSelfUpdate) {
    nextActions.push(
      `pcbridge is running from a git checkout (v${before.core.currentVersion}); pull latest git commits and run bun run build to update source to v${before.core.latestVersion}.`,
    );
  }
  if (!extensionReloadTriggered && before.core.connectedExtensionVersions.length === 0) {
    nextActions.push(
      "Open or refresh a PlayCanvas Editor/Launch tab in Chrome; if the extension was not loaded yet, load ~/.pcbridge/extension in chrome://extensions.",
    );
  } else if (extensionReloadTriggered && !reloadTabs) {
    nextActions.push("Refresh open PlayCanvas Editor and Launch tabs to attach the reloaded extension.");
  }

  return {
    previousVersion: before.core.currentVersion,
    version: effectiveVersion,
    latestVersion: before.core.latestVersion,
    installKind: before.core.installKind,
    packageUpdated,
    extensionPath,
    extensionVersion,
    extensionReloadTriggered,
    tabsReloadRequested: reloadTabs,
    skillsRefreshed,
    daemonRestartTriggered,
    pluginsUpdated,
    nextActions,
  };
}
