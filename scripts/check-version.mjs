import { readFileSync } from "node:fs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
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

process.stdout.write(`Version ${packageVersion} is synchronized.\n`);
