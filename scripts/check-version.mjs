import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function collectOfficialPlugins() {
  const pluginsDir = "plugins";
  if (!existsSync(pluginsDir)) return [];
  const entries = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  return entries.map((dirName) => {
    const manifestPath = join(pluginsDir, dirName, "pcbridge-plugin.json");
    if (!existsSync(manifestPath)) {
      fail(`Missing ${manifestPath} for official plugin directory ${dirName}.`);
    }
    const manifest = readJson(manifestPath);
    if (manifest.id !== dirName) {
      fail(`${manifestPath} id "${manifest.id}" does not match directory "${dirName}".`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version || "")) {
      fail(`${manifestPath} contains an invalid stable version: ${manifest.version}`);
    }
    if (
      manifest.minPcbridgeVersion !== undefined &&
      !/^\d+\.\d+\.\d+$/.test(manifest.minPcbridgeVersion)
    ) {
      fail(`${manifestPath} contains an invalid minPcbridgeVersion: ${manifest.minPcbridgeVersion}`);
    }
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      ...(manifest.minPcbridgeVersion ? { minPcbridgeVersion: manifest.minPcbridgeVersion } : {}),
      description: manifest.description || "",
      subdir: `plugins/${dirName}`,
    };
  });
}

const args = process.argv.slice(2);
const bumpIndex = args.indexOf("--bump");
if (bumpIndex !== -1) {
  const nextVersion = args[bumpIndex + 1];
  if (!nextVersion || !/^\d+\.\d+\.\d+$/.test(nextVersion)) {
    fail("Usage: bun scripts/check-version.mjs --bump <X.Y.Z>");
  }
  const pkg = readJson("package.json");
  pkg.version = nextVersion;
  writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

  const ext = readJson("extension/manifest.json");
  ext.version = nextVersion;
  writeFileSync("extension/manifest.json", `${JSON.stringify(ext, null, 2)}\n`);

  const configText = readFileSync("src/config.ts", "utf8").replace(
    /^export const VERSION = "[^"]+";$/m,
    `export const VERSION = "${nextVersion}";`,
  );
  writeFileSync("src/config.ts", configText);
}

if (args.includes("--sync-plugins")) {
  const plugins = collectOfficialPlugins();
  writeFileSync("plugins/index.json", `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`);
}

const packageJson = readJson("package.json");
const extensionManifest = readJson("extension/manifest.json");
const configSource = readFileSync("src/config.ts", "utf8");
const cliVersion = configSource.match(/^export const VERSION = "([^"]+)";$/m)?.[1];
const packageVersion = packageJson.version;

if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  fail(`package.json contains an invalid stable version: ${packageVersion}`);
}
if (cliVersion !== packageVersion) {
  fail(`src/config.ts version ${cliVersion || "missing"} does not match ${packageVersion}.`);
}
if (extensionManifest.version !== packageVersion) {
  fail(
    `extension/manifest.json version ${extensionManifest.version} does not match ${packageVersion}.`,
  );
}

const releaseTag = process.env.PCBRIDGE_RELEASE_TAG;
if (releaseTag && releaseTag !== `v${packageVersion}`) {
  fail(`Release tag ${releaseTag} does not match package version v${packageVersion}.`);
}

const expectedCatalog = {
  schemaVersion: 1,
  plugins: collectOfficialPlugins(),
};
if (!existsSync("plugins/index.json")) {
  fail("plugins/index.json is missing. Run: bun scripts/check-version.mjs --sync-plugins");
}
const actualCatalog = readJson("plugins/index.json");
if (JSON.stringify(actualCatalog) !== JSON.stringify(expectedCatalog)) {
  fail(
    "plugins/index.json is out of sync with plugins/*/pcbridge-plugin.json. Run: bun scripts/check-version.mjs --sync-plugins",
  );
}

process.stdout.write(`Version ${packageVersion} is synchronized.\n`);
