import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, mkdtemp, rm, rename, lstat, chmod } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { x } from "tar";
import { CONFIG_DIR } from "../config.js";

export const TOOLS_ROOT = join(CONFIG_DIR, "asset-tools");
export const RECIPE = "asset-tools-v7";
export const MEMORY_BYTES = 1024 * 1024 * 1024;
export const hash = (data: Uint8Array, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
type FileSpec = { path: string; size: number; sha256: string };
export type ToolManifest = {
  schemaVersion: number; release: string; platform: string; arch: string;
  recipeVersion: string; targetEngine: string;
  formats: { texture: string[]; model: string[] };
  binaries: { modelConverter: FileSpec; textureConverter: FileSpec };
  runner: FileSpec; catalog: FileSpec; archive: FileSpec & { name: string; url: string };
};
export async function verifyTools(directory: string) {
  const manifest: ToolManifest = JSON.parse(await readFile(join(directory, "release.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch ||
      manifest.recipeVersion !== RECIPE || manifest.targetEngine !== "1.77.0") throw new Error("TOOLS_PLATFORM_OR_RECIPE_MISMATCH");
  for (const spec of [manifest.runner, manifest.catalog, ...Object.values(manifest.binaries)]) {
    if (!/^(bin|runner|schema)\/[a-zA-Z0-9._-]+$/.test(spec.path)) throw new Error("TOOLS_INVALID_PATH");
    const path = join(directory, spec.path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.size || spec.size > 256 * 1024 * 1024 ||
        hash(await readFile(path)) !== spec.sha256) throw new Error("TOOLS_INTEGRITY_MISMATCH");
  }
  return manifest;
}
async function readInput(source: string, maxBytes: number) {
  if (!/^https:\/\//.test(source)) {
    const info = await lstat(source);
    if (!info.isFile() || info.size > maxBytes) throw new Error("TOOLS_DOWNLOAD_TOO_LARGE");
    return readFile(source);
  }
  const response = await fetch(source, { signal: AbortSignal.timeout(120000), redirect: "follow" });
  if (!response.url.startsWith("https://") || !response.ok || !response.body) throw new Error(`TOOLS_DOWNLOAD_HTTP_${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("TOOLS_DOWNLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
// Installation is an explicit local CLI action. Browser requests cannot install executable code.
export async function installTools(source: string) {
  const manifestBytes = await readInput(source, 1024 * 1024);
  const manifest: ToolManifest = JSON.parse(manifestBytes.toString());
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(manifest.release) || !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(manifest.archive.name)) throw new Error("TOOLS_INVALID_MANIFEST");
  const archiveSource = /^https:\/\//.test(source) ? manifest.archive.url : resolve(dirname(source), manifest.archive.name);
  const archive = await readInput(archiveSource, 256 * 1024 * 1024);
  if (archive.length !== manifest.archive.size || hash(archive) !== manifest.archive.sha256) throw new Error("TOOLS_ARCHIVE_INTEGRITY_MISMATCH");
  await mkdir(TOOLS_ROOT, { recursive: true });
  const staging = await mkdtemp(join(TOOLS_ROOT, ".install-"));
  try {
    const archivePath = join(staging, "package.tgz");
    await writeFile(archivePath, archive);
    let expanded = 0;
    await x({ file: archivePath, cwd: staging, strict: true, filter: (path, entry) => {
      if (!/^(?:bin|runner|schema)\/?$|^(?:bin|runner|schema)\/[a-zA-Z0-9._-]+$|^THIRD-PARTY-LICENSES.txt$/.test(path) ||
          !("type" in entry) || !["File", "Directory"].includes(entry.type)) throw new Error("TOOLS_UNSAFE_ARCHIVE");
      expanded += entry.size;
      if (expanded > 512 * 1024 * 1024) throw new Error("TOOLS_ARCHIVE_TOO_LARGE");
      return true;
    } });
    await writeFile(join(staging, "release.json"), manifestBytes);
    await verifyTools(staging);
    for (const spec of Object.values(manifest.binaries)) await chmod(join(staging, spec.path), 0o755);
    await rm(archivePath);
    const destination = join(TOOLS_ROOT, `${manifest.release}-${manifest.archive.sha256.slice(0, 16)}`);
    try { await rename(staging, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      await verifyTools(destination);
    }
    await writeFile(join(TOOLS_ROOT, "active.json"), JSON.stringify({ directory: destination }));
    return { release: manifest.release, directory: destination };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function activeTools() {
  const active = JSON.parse(await readFile(join(TOOLS_ROOT, "active.json"), "utf8"));
  if (dirname(active.directory) !== TOOLS_ROOT) throw new Error("TOOLS_INVALID_ACTIVE_PATH");
  return { directory: active.directory as string, manifest: await verifyTools(active.directory) };
}
