import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { activeTools, MEMORY_BYTES, RECIPE, TOOLS_ROOT } from "./tools.js";
import type { TargetInfo } from "../shared/protocol.js";

export const CHUNK_BYTES = 256 * 1024;
type Output = { path: string; size: number; hash: string; filename: string; mime: string; role: string; artifactId: string; artifactType?: string; variant?: string };
type Task = {
  id: string; targetId: string; clientId?: string; branchId?: string; jobId: string; directory: string;
  source: { filename: string; size: number; hash: string }; offset: number;
  state: string; phase: string; progress: number; touched: number; error?: string;
  manifest?: Record<string, unknown>; files: Record<string, Output>; process?: ChildProcess;
  busy: boolean; memoryBytes: number; timeoutMs: number; job: { filename: string; kind: string; options: unknown };
};
async function digest(path: string) {
  const h = createHash("md5");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}
export class ProcessingManager {
  private tasks = new Map<string, Task>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private projectDirectory: (target: TargetInfo) => string | null) {
    this.timer = setInterval(() => {
      for (const task of this.tasks.values()) if (Date.now() - task.touched > 90000) void this.remove(task);
      if (this.tasks.size) void readFile(join(TOOLS_ROOT, "settings.json"), "utf8").then(text => {
        if (JSON.parse(text).enabled !== true) for (const task of this.tasks.values()) void this.remove(task);
      }).catch(() => { for (const task of this.tasks.values()) void this.remove(task); });
    }, 10000);
    this.timer.unref();
  }
  async capabilities() {
    const config = JSON.parse(await readFile(join(TOOLS_ROOT, "settings.json"), "utf8").catch(() => '{}'));
    const memoryBytes = Number(config.memoryBytes || MEMORY_BYTES);
    const timeoutMs = Number(config.timeoutMs || 600000);
    if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 64 * 1024 * 1024 || memoryBytes > MEMORY_BYTES ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error("INVALID_PROCESSING_LIMITS");
    const base = { bridgeProtocolVersion: 1, processingProtocolVersion: 1, recipeVersion: RECIPE,
      targetEngine: "1.77.0", memoryBudgetBytes: memoryBytes, timeoutMs, enabled: config.enabled === true,
      toolRelease: null as string | null, toolFingerprints: [] as string[], busy: this.tasks.size > 0, available: false, formats: { texture: [] as string[], model: [] as string[] } };
    if (!base.enabled) return { ...base, reason: "LOCAL_DISABLED" };
    try {
      const { manifest } = await activeTools();
      return { ...base, available: !base.busy, formats: manifest.formats, toolRelease: manifest.release,
        toolFingerprints: Object.values(manifest.binaries).map(spec => spec.sha256), reason: base.busy ? "LOCAL_BUSY" : null };
    } catch { return { ...base, reason: "TOOLS_UNAVAILABLE" }; }
  }
  private requireTask(target: TargetInfo, id: unknown) {
    const task = typeof id === "string" ? this.tasks.get(id) : null;
    if (!task || task.targetId !== target.id || task.clientId !== target.clientId || task.branchId !== target.branchId) throw new Error("PROCESSING_TARGET_MISMATCH");
    task.touched = Date.now();
    return task;
  }
  async request(target: TargetInfo, action: string, body: Record<string, any>) {
    if (target.kind !== "editor" || target.platform !== "selfhost") throw new Error("SELFHOST_EDITOR_REQUIRED");
    if (target.processingProtocolVersion !== 1) throw new Error("PROCESSING_EDITOR_UNSUPPORTED");
    if (action === "capabilities") return this.capabilities();
    if (action === "begin") {
      const caps = await this.capabilities();
      if (!caps.available || this.tasks.size) throw new Error("LOCAL_UNAVAILABLE");
      const source = body.source;
      if (!source || !/^[^/\\\x00-\x1f]{1,200}$/.test(source.filename) || source.filename === "." || source.filename === ".." ||
          !Number.isSafeInteger(source.size) || source.size < 1 || source.size > caps.memoryBudgetBytes / 2 ||
          !/^[a-f0-9]{32}$/.test(source.hash) || !["model", "texture"].includes(body.kind) ||
          typeof body.jobId !== "string" || body.jobId.length > 100) throw new Error("INVALID_PROCESSING_TASK");
      // Only copy the allowlisted fields; server leases and signed URLs never enter a task.
      const project = this.projectDirectory(target);
      if (!project) throw new Error("WORKSPACE_NOT_READY");
      const root = join(project, "tmp", "processing");
      await mkdir(root, { recursive: true });
      if (!(await realpath(root)).startsWith((await realpath(project)) + sep)) throw new Error("PROCESSING_PATH_ESCAPE");
      for (const name of await readdir(root)) {
        if (!name.startsWith("job-")) continue;
        const stale = join(root, name);
        if (Date.now() - (await stat(stale)).mtimeMs > 7 * 86400000) await rm(stale, { recursive: true, force: true });
      }
      const directory = await mkdtemp(join(root, "job-"));
      if (this.tasks.size) { await rm(directory, { recursive: true }); throw new Error("LOCAL_BUSY"); }
      const task: Task = { id: randomUUID(), targetId: target.id, clientId: target.clientId, branchId: target.branchId, jobId: body.jobId,
        directory, source: { filename: source.filename, size: source.size, hash: source.hash }, offset: 0,
        state: "receiving", phase: "download", progress: 0, touched: Date.now(), files: {}, busy: false, memoryBytes: caps.memoryBudgetBytes, timeoutMs: caps.timeoutMs,
        job: { filename: source.filename, kind: body.kind, options: body.options || {} } };
      this.tasks.set(task.id, task);
      await writeFile(join(directory, "source"), Buffer.alloc(0));
      return { transferId: task.id, chunkBytes: CHUNK_BYTES };
    }
    const task = this.requireTask(target, body.transferId);
    if (action === "cancel" || action === "finish") { await this.remove(task); return { removed: true }; }
    if (action === "status") return { state: task.state, phase: task.phase, progress: task.progress, error: task.error,
      manifest: task.manifest, files: Object.fromEntries(Object.entries(task.files).map(([id, { path, ...file }]) => [id, file])) };
    if (task.busy) throw new Error("PROCESSING_TRANSFER_BUSY");
    task.busy = true;
    try {
      if (action === "chunk") {
        if (task.state !== "receiving" || !Number.isSafeInteger(body.offset) || body.offset < 0 ||
            typeof body.data !== "string" || body.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new Error("INVALID_PROCESSING_CHUNK");
        const bytes = Buffer.from(body.data, "base64");
        if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString("base64") !== body.data || body.offset + bytes.length > task.source.size) throw new Error("INVALID_PROCESSING_CHUNK");
        const file = await open(join(task.directory, "source"), "r+");
        try {
          if (body.offset < task.offset) {
            const old = Buffer.alloc(bytes.length);
            await file.read(old, 0, old.length, body.offset);
            if (body.offset + bytes.length > task.offset || !old.equals(bytes)) throw new Error("PROCESSING_CHUNK_CONFLICT");
          } else {
            if (body.offset !== task.offset) throw new Error("PROCESSING_CHUNK_ORDER");
            await file.write(bytes, 0, bytes.length, task.offset);
            task.offset += bytes.length;
          }
        } finally { await file.close(); }
        return { offset: task.offset };
      }
      if (action === "run") {
        if (task.state !== "receiving" || task.offset !== task.source.size || await digest(join(task.directory, "source")) !== task.source.hash) throw new Error("PROCESSING_SOURCE_INTEGRITY");
        task.state = "running";
        void this.convert(task).catch(error => { task.state = "failed"; task.error = String(error).slice(0, 2000); });
        return { state: task.state };
      }
      if (action === "read") {
        const file = task.files[body.fileId];
        if (task.state !== "computed" || !file || !Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset >= file.size) throw new Error("INVALID_PROCESSING_READ");
        const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, file.size - body.offset));
        const handle = await open(file.path, "r");
        try { await handle.read(bytes, 0, bytes.length, body.offset); } finally { await handle.close(); }
        return { offset: body.offset, data: bytes.toString("base64") };
      }
      throw new Error("UNKNOWN_PROCESSING_ACTION");
    } finally { task.busy = false; }
  }
  private async convert(task: Task) {
    const { directory, manifest } = await activeTools();
    const config = { job: task.job, input: join(task.directory, "source"), directory: task.directory,
      memoryBytes: task.memoryBytes, executable: join(directory, manifest.binaries.modelConverter.path),
      textureExecutable: join(directory, manifest.binaries.textureConverter.path),
      catalogPath: join(directory, manifest.catalog.path), includeThumbnails: true };
    const configPath = join(task.directory, "input.json");
    await writeFile(configPath, JSON.stringify(config));
    const require = createRequire(import.meta.url);
    const sharpModules = dirname(dirname(dirname(require.resolve("sharp"))));
    if (!this.tasks.has(task.id)) return;
    const proc = spawn(process.execPath, [join(directory, manifest.runner.path), configPath], {
      cwd: task.directory, detached: process.platform !== "win32",
      env: { PATH: process.env.PATH || "/usr/bin:/bin", NODE_PATH: sharpModules,
        IMPORT_WORKER_MEMORY_BYTES: String(task.memoryBytes) }, stdio: ["ignore", "pipe", "pipe"]
    });
    task.process = proc;
    let errorOutput = "", pending = "";
    proc.stderr?.on("data", chunk => { errorOutput = (errorOutput + chunk).slice(-2000); });
    proc.stdout?.on("data", chunk => {
      pending = (pending + chunk).slice(-8000);
      const lines = pending.split("\n"); pending = lines.pop() || "";
      for (const line of lines) try {
        const progress = JSON.parse(line);
        if (Number.isFinite(progress.progress)) task.progress = Math.min(.9, Math.max(0, progress.progress));
        if (typeof progress.phase === "string") task.phase = progress.phase.slice(0, 80);
      } catch { /* native diagnostics are not protocol messages */ }
    });
    const timeout = setTimeout(() => this.kill(task), task.timeoutMs);
    try {
      const code = await new Promise<number | null>((resolveExit, reject) => { proc.once("error", reject); proc.once("exit", resolveExit); });
      if (code !== 0) throw new Error(`CONVERTER_FAILED: ${errorOutput}`);
    } finally { clearTimeout(timeout); task.process = undefined; }
    if (!this.tasks.has(task.id)) return;
    const resultPath = join(task.directory, "result.json");
    if ((await stat(resultPath)).size > 32 * 1024 * 1024) throw new Error("PROCESSING_MANIFEST_TOO_LARGE");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (!Array.isArray(result.artifacts) || result.artifacts.length > 10000) throw new Error("PROCESSING_ARTIFACT_LIMIT");
    let total = 0;
    const addFile = async (artifact: any, artifactId: string, role: string, variant?: string) => {
      const path = await realpath(artifact.localFile);
      if (relative(task.directory, path).startsWith("..") || !path.startsWith(task.directory + sep)) throw new Error("PROCESSING_OUTPUT_ESCAPE");
      const size = (await stat(path)).size;
      total += size;
      if (size > 256 * 1024 * 1024 || total > MEMORY_BYTES * 2) throw new Error("PROCESSING_OUTPUT_BUDGET");
      const id = randomUUID();
      task.files[id] = { path, size, hash: await digest(path), filename: artifact.filename, mime: artifact.mime || "application/octet-stream", role, artifactId, artifactType: artifact.type, variant };
      delete artifact.localFile;
      artifact.fileId = id;
    };
    for (const [i, artifact] of result.artifacts.entries()) {
      if (artifact.localFile) await addFile(artifact, String(i), "derived");
      for (const [variant, thumb] of Object.entries<any>(artifact.thumbnails || {})) await addFile(thumb, String(i), "thumbnail", variant);
    }
    task.manifest = result;
    task.state = "computed";
    task.phase = "upload";
    task.progress = .9;
  }
  private kill(task: Task) {
    if (!task.process?.pid) return;
    try { process.kill(process.platform === "win32" ? task.process.pid : -task.process.pid, "SIGKILL"); } catch { /* already exited */ }
  }
  private async remove(task: Task) {
    this.tasks.delete(task.id);
    this.kill(task);
    await rm(task.directory, { recursive: true, force: true });
  }
  async close() { clearInterval(this.timer); await Promise.all([...this.tasks.values()].map(task => this.remove(task))); }
}
