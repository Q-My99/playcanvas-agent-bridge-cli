import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import {
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { parse as parseEnv } from "dotenv";
import type { Envelope, JsonValue, TargetInfo } from "../shared/protocol.js";
import type { WorkspaceManager } from "../workspace/manager.js";

type TargetRequest = (
  target: string,
  method: string,
  params?: Record<string, JsonValue>,
  timeoutMs?: number,
) => Promise<Envelope>;

type BuilderOptions = {
  rootDir: string;
  requestTarget: TargetRequest;
  workspace: WorkspaceManager;
};

type TemplateBuildOptions = {
  suffix?: string;
  prefix?: string;
};

type AssetJson = {
  id: string | number;
  name: string;
  type: string;
  data?: Record<string, unknown>;
  file?: null | {
    filename?: string;
    hash?: string;
    url?: string;
    variants?: Record<string, {
      filename?: string;
      hash?: string;
      url?: string;
    }>;
  };
  [key: string]: unknown;
};

type TemplateDescriptor = {
  template: AssetJson;
  assets: AssetJson[];
  scripts: Array<{ name: string; assetId: string }>;
  childTemplateIds: string[];
  projectUrl: string | null;
  sceneUrl: string | null;
};

type UploadFile = {
  key: string;
  path: string;
  contentType: string;
  hash: string;
};

type S3Settings = {
  client: S3Client;
  bucket: string;
  defaultPrefix: string;
  publicBaseUrl: string;
  source: "project" | "workspace" | "environment";
};

export type BuildJobStatus = {
  id: string;
  target: string;
  templateAssetId: string;
  state: "queued" | "collecting" | "syncing" | "preparing" | "uploading" | "completed" | "error";
  message: string;
  completedFiles: number;
  totalFiles: number;
  createdAt: string;
  updatedAt: string;
  outputPath: string | null;
  publicUrl: string | null;
  configSource: string | null;
  error: string | null;
};

type BuildJob = BuildJobStatus & {
  info: TargetInfo;
  options: TemplateBuildOptions;
};

const OMITTED_ASSET_FIELDS = new Set([
  "uniqueId",
  "createdAt",
  "modifiedAt",
  "scope",
  "user_id",
  "source_asset_id",
  "source",
  "revision",
  "region",
  "task",
  "path",
  "has_thumbnail",
  "thumbnail",
  "thumbnails",
]);

const ENV_EXAMPLE = `# Copy to .env and fill in the values. A project .env overrides the workspace .env.\n\
PCBRIDGE_S3_ENDPOINT=https://s3.example.com\n\
PCBRIDGE_S3_REGION=us-east-1\n\
PCBRIDGE_S3_BUCKET=my-bucket\n\
PCBRIDGE_S3_ACCESS_KEY_ID=\n\
PCBRIDGE_S3_SECRET_ACCESS_KEY=\n\
# PCBRIDGE_S3_SESSION_TOKEN=\n\
PCBRIDGE_S3_PUBLIC_BASE_URL=https://cdn.example.com\n\
PCBRIDGE_S3_PREFIX=assets\n\
PCBRIDGE_S3_FORCE_PATH_STYLE=false\n`;

function md5(value: Buffer | string): string {
  return createHash("md5").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function envValue(env: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function booleanValue(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizePrefix(value: string | undefined): string {
  const parts = String(value || "assets")
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("S3 upload prefix cannot contain . or .. path segments.");
  }
  return parts.join("/");
}

function safeSegment(value: string, fallback: string): string {
  const result = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return result || fallback;
}

function timestamp(): string {
  const date = new Date();
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}_${part(date.getMonth() + 1)}_${part(date.getDate())}-` +
    `${part(date.getHours())}_${part(date.getMinutes())}_${part(date.getSeconds())}`;
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".bin": "application/octet-stream",
    ".css": "text/css",
    ".gif": "image/gif",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".wasm": "application/wasm",
    ".webm": "video/webm",
    ".webp": "image/webp",
  };
  return types[extname(path).toLowerCase()] || "application/octet-stream";
}

function publicObjectUrl(base: string, key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${base.replace(/\/$/, "")}/${encoded}`;
}

function sanitizeAsset(asset: AssetJson): AssetJson {
  const result = clone(asset);
  for (const field of OMITTED_ASSET_FIELDS) delete result[field];
  if (result.type === "material") {
    result.data ||= {};
    if (!result.data.shader) result.data.shader = "blinn";
  }
  return result;
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  return parseEnv(await readFile(path, "utf8"));
}

async function loadS3Settings(rootDir: string, projectDirectory: string): Promise<S3Settings> {
  const workspacePath = join(rootDir, ".env");
  const projectPath = join(projectDirectory, ".env");
  if (!existsSync(workspacePath) && !existsSync(projectPath)) {
    await writeFile(join(rootDir, ".env.example"), ENV_EXAMPLE, { flag: "wx" }).catch(() => undefined);
  }
  const processValues = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const workspaceValues = await readEnvFile(workspacePath);
  const projectValues = await readEnvFile(projectPath);
  const env = { ...processValues, ...workspaceValues, ...projectValues };
  const source = existsSync(projectPath)
    ? "project"
    : existsSync(workspacePath) ? "workspace" : "environment";
  const endpoint = envValue(env, "PCBRIDGE_S3_ENDPOINT", "S3_ENDPOINT");
  const region = envValue(env, "PCBRIDGE_S3_REGION", "AWS_REGION", "S3_REGION") || "us-east-1";
  const bucket = envValue(env, "PCBRIDGE_S3_BUCKET", "S3_BUCKET");
  const accessKeyId = envValue(env, "PCBRIDGE_S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID");
  const secretAccessKey = envValue(
    env,
    "PCBRIDGE_S3_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "S3_SECRET_ACCESS_KEY",
  );
  const sessionToken = envValue(env, "PCBRIDGE_S3_SESSION_TOKEN", "AWS_SESSION_TOKEN", "S3_SESSION_TOKEN");
  if (!bucket) throw new Error("Missing PCBRIDGE_S3_BUCKET in the project or workspace .env file.");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing PCBRIDGE_S3_ACCESS_KEY_ID or PCBRIDGE_S3_SECRET_ACCESS_KEY in the project or workspace .env file.",
    );
  }
  const configuredBase = envValue(env, "PCBRIDGE_S3_PUBLIC_BASE_URL", "S3_PUBLIC_BASE_URL");
  let publicBaseUrl = configuredBase;
  if (!publicBaseUrl && endpoint) publicBaseUrl = `${endpoint.replace(/\/$/, "")}/${bucket}`;
  if (!publicBaseUrl) publicBaseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;
  return {
    client: new S3Client({
      region,
      endpoint,
      forcePathStyle: booleanValue(
        envValue(env, "PCBRIDGE_S3_FORCE_PATH_STYLE", "S3_FORCE_PATH_STYLE"),
        false,
      ),
      credentials: { accessKeyId, secretAccessKey, sessionToken },
    }),
    bucket,
    defaultPrefix: normalizePrefix(envValue(env, "PCBRIDGE_S3_PREFIX", "S3_PREFIX")),
    publicBaseUrl,
    source,
  };
}

function descriptorFrom(value: JsonValue): TemplateDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PlayCanvas returned an invalid Template dependency descriptor.");
  }
  const candidate = value as unknown as TemplateDescriptor;
  if (!candidate.template || !Array.isArray(candidate.assets)) {
    throw new Error("PlayCanvas returned an incomplete Template dependency descriptor.");
  }
  return {
    template: candidate.template,
    assets: candidate.assets,
    scripts: Array.isArray(candidate.scripts) ? candidate.scripts : [],
    childTemplateIds: Array.isArray(candidate.childTemplateIds) ? candidate.childTemplateIds.map(String) : [],
    projectUrl: typeof candidate.projectUrl === "string" ? candidate.projectUrl : null,
    sceneUrl: typeof candidate.sceneUrl === "string" ? candidate.sceneUrl : null,
  };
}

export class BuilderManager {
  readonly rootDir: string;
  #requestTarget: TargetRequest;
  #workspace: WorkspaceManager;
  #jobs = new Map<string, BuildJob>();

  constructor(options: BuilderOptions) {
    this.rootDir = options.rootDir;
    this.#requestTarget = options.requestTarget;
    this.#workspace = options.workspace;
  }

  start(info: TargetInfo, templateAssetId: string, options: TemplateBuildOptions = {}): BuildJobStatus {
    const now = new Date().toISOString();
    const job: BuildJob = {
      id: `build_${randomUUID()}`,
      target: info.id,
      templateAssetId,
      state: "queued",
      message: "Queued",
      completedFiles: 0,
      totalFiles: 0,
      createdAt: now,
      updatedAt: now,
      outputPath: null,
      publicUrl: null,
      configSource: null,
      error: null,
      info,
      options,
    };
    this.#jobs.set(job.id, job);
    while (this.#jobs.size > 100) this.#jobs.delete(this.#jobs.keys().next().value!);
    void this.#run(job);
    return this.#publicJob(job);
  }

  get(jobId: string): BuildJobStatus | null {
    const job = this.#jobs.get(jobId);
    return job ? this.#publicJob(job) : null;
  }

  #update(job: BuildJob, values: Partial<BuildJobStatus>): void {
    Object.assign(job, values, { updatedAt: new Date().toISOString() });
  }

  #publicJob(job: BuildJob): BuildJobStatus {
    const { info: _info, options: _options, ...status } = job;
    return status;
  }

  async #descriptor(info: TargetInfo, assetId: string): Promise<TemplateDescriptor> {
    const response = await this.#requestTarget(
      info.id,
      "bridge:collectTemplateDependencies",
      { assetId },
      60000,
    );
    if (!response.ok) throw new Error(response.error.message);
    return descriptorFrom(response.data);
  }

  async #cacheRemoteFile(
    info: TargetInfo,
    projectDirectory: string,
    assetId: string,
    filename: string,
    url: string,
    expectedHash?: string,
  ): Promise<{ path: string; hash: string }> {
    const path = join(
      projectDirectory,
      "tmp",
      "cache",
      "assets",
      safeSegment(assetId, "asset"),
      safeSegment(filename, "file.bin"),
    );
    if (existsSync(path)) {
      const content = await readFile(path);
      const hash = md5(content);
      if (!expectedHash || hash === expectedHash) return { path, hash };
    }
    const response = await this.#requestTarget(
      info.id,
      "bridge:readAssetResource",
      { assetId, url },
      120000,
    );
    if (!response.ok) throw new Error(response.error.message);
    const data = response.data as Record<string, JsonValue>;
    const base64 = typeof data.base64 === "string" ? data.base64 : "";
    if (!base64) throw new Error(`Asset ${assetId} resource ${filename} returned no data.`);
    const content = Buffer.from(base64, "base64");
    const hash = md5(content);
    if (expectedHash && hash !== expectedHash) {
      throw new Error(`Asset ${assetId} resource ${filename} did not match its PlayCanvas MD5.`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return { path, hash };
  }

  async #run(job: BuildJob): Promise<void> {
    let activeClient: S3Client | null = null;
    try {
      this.#update(job, { state: "collecting", message: "Collecting Template dependencies" });
      const descriptors = new Map<string, TemplateDescriptor>();
      const visit = async (assetId: string, stack: Set<string>): Promise<void> => {
        if (descriptors.has(assetId)) return;
        if (stack.has(assetId)) throw new Error(`Template dependency cycle detected at asset ${assetId}.`);
        const nextStack = new Set(stack).add(assetId);
        const descriptor = await this.#descriptor(job.info, assetId);
        descriptors.set(assetId, descriptor);
        for (const childId of descriptor.childTemplateIds) await visit(childId, nextStack);
      };
      await visit(job.templateAssetId, new Set());

      this.#update(job, { state: "syncing", message: "Synchronizing dependency files" });
      const allAssetIds = new Set<string>();
      for (const descriptor of descriptors.values()) {
        for (const asset of descriptor.assets) allAssetIds.add(String(asset.id));
      }
      const prepared = await this.#workspace.prepareAssetFiles(job.info, [...allAssetIds]);
      const preparedById = new Map(prepared.assets.map((asset) => [asset.id, asset]));
      const settings = await loadS3Settings(this.rootDir, prepared.projectDirectory);
      activeClient = settings.client;
      job.configSource = settings.source;
      const prefix = normalizePrefix(job.options.prefix || settings.defaultPrefix);
      const uploads = new Map<string, UploadFile>();
      const built = new Map<string, { key: string; publicUrl: string; buildName: string }>();

      const buildTemplate = async (assetId: string): Promise<{ key: string; publicUrl: string; buildName: string }> => {
        const existing = built.get(assetId);
        if (existing) return existing;
        const descriptor = descriptors.get(assetId);
        if (!descriptor) throw new Error(`Missing descriptor for Template ${assetId}.`);
        for (const childId of descriptor.childTemplateIds) await buildTemplate(childId);

        const suffix = String(job.options.suffix || "").replaceAll("${time}", timestamp());
        const buildName = safeSegment(`${descriptor.template.name}${suffix}`, `template-${assetId}`);
        const buildRoot = join(prepared.tmpDirectory, "builds", buildName);
        await mkdir(buildRoot, { recursive: true });
        const rootData: Record<string, unknown> = {
          projectUrl: descriptor.projectUrl,
          sceneUrl: descriptor.sceneUrl,
          template: clone(descriptor.template.data || {}),
          assets: {},
        };
        const templateData = rootData.template as Record<string, unknown>;
        const entities = templateData.entities && typeof templateData.entities === "object"
          ? templateData.entities as Record<string, Record<string, unknown>>
          : {};
        for (const entity of Object.values(entities)) {
          const attributes = (entity.components as Record<string, unknown> | undefined)?.script as
            | Record<string, unknown>
            | undefined;
          const scripts = attributes?.scripts as Record<string, unknown> | undefined;
          const handler = scripts?.sdsTinyRootHandler as Record<string, unknown> | undefined;
          const values = handler?.attributes as Record<string, unknown> | undefined;
          const childId = values && Number.isInteger(values.testTemplate)
            ? String(values.testTemplate)
            : null;
          if (!childId || !built.has(childId)) continue;
          delete values!.testTemplate;
          values!.type = "TinyApp";
          values!.tinyAppUrl = built.get(childId)!.publicUrl;
        }

        const assetOutput = rootData.assets as Record<string, AssetJson>;
        const scriptIds = new Set(descriptor.scripts.map((script) => script.assetId));
        for (const asset of descriptor.assets) {
          const id = String(asset.id);
          if (scriptIds.has(id) || asset.type === "script") continue;
          const output = sanitizeAsset(asset);
          const originalFileUrl = asset.file?.url;
          const originalFilename = asset.file?.filename;
          const local = preparedById.get(id);
          if (output.file && local?.path && local.filename) {
            const key = `${prefix}/${buildName}/${id}/${safeSegment(local.filename, `asset-${id}`)}`;
            output.file.url = publicObjectUrl(settings.publicBaseUrl, key);
            uploads.set(key, {
              key,
              path: local.path,
              contentType: contentType(local.path),
              hash: local.hash || md5(await readFile(local.path)),
            });
          }
          for (const variant of Object.values(output.file?.variants || {})) {
            if (!variant.url || !variant.filename) continue;
            const cached = await this.#cacheRemoteFile(
              job.info,
              prepared.projectDirectory,
              id,
              variant.filename,
              variant.url,
              variant.hash,
            );
            const key = `${prefix}/${buildName}/${id}/${safeSegment(variant.filename, "variant.bin")}`;
            variant.url = publicObjectUrl(settings.publicBaseUrl, key);
            uploads.set(key, {
              key,
              path: cached.path,
              contentType: contentType(cached.path),
              hash: cached.hash,
            });
          }
          const fontMaps = asset.type === "font" && Array.isArray(asset.data?.info &&
            (asset.data.info as Record<string, unknown>).maps)
            ? (asset.data!.info as Record<string, unknown>).maps as unknown[]
            : [];
          if (originalFileUrl && originalFilename && fontMaps.length > 1) {
            for (let index = 1; index < fontMaps.length; index += 1) {
              const filename = originalFilename.replace(/(\.[^.]*)$/, `${index}$1`);
              const url = originalFileUrl.replace(/(\.[^.]*)$/, `${index}$1`);
              const cached = await this.#cacheRemoteFile(
                job.info,
                prepared.projectDirectory,
                id,
                filename,
                url,
              );
              const key = `${prefix}/${buildName}/${id}/${safeSegment(filename, `font-map-${index}`)}`;
              uploads.set(key, {
                key,
                path: cached.path,
                contentType: contentType(cached.path),
                hash: cached.hash,
              });
            }
          }
          assetOutput[id] = output;
        }

        let scriptText = "";
        for (const script of descriptor.scripts) {
          const local = preparedById.get(script.assetId);
          if (!local?.path) continue;
          scriptText += `\n//-----script:${script.name}-----\n`;
          scriptText += await readFile(local.path, "utf8");
          scriptText += "\n";
        }
        if (scriptText.trim()) {
          const scriptPath = join(buildRoot, "gamescript.js");
          await writeFile(scriptPath, scriptText);
          const key = `${prefix}/${buildName}/gamescript.js`;
          rootData.scriptUrl = publicObjectUrl(settings.publicBaseUrl, key);
          uploads.set(key, {
            key,
            path: scriptPath,
            contentType: contentType(scriptPath),
            hash: md5(scriptText),
          });
        }

        const rootPath = join(buildRoot, "tinyapp.json");
        const rootContent = `${JSON.stringify(rootData)}\n`;
        await writeFile(rootPath, rootContent);
        const key = `${prefix}/${buildName}/tinyapp.json`;
        const result = { key, publicUrl: publicObjectUrl(settings.publicBaseUrl, key), buildName };
        uploads.set(key, {
          key,
          path: rootPath,
          contentType: contentType(rootPath),
          hash: md5(rootContent),
        });
        built.set(assetId, result);
        return result;
      };

      this.#update(job, { state: "preparing", message: "Preparing upload manifest" });
      const root = await buildTemplate(job.templateAssetId);
      job.totalFiles = uploads.size;
      const uploadFiles = [...uploads.values()];
      this.#update(job, { state: "uploading", message: `Uploading 0/${uploadFiles.length} files` });
      const concurrency = Math.min(4, Math.max(1, uploadFiles.length));
      let cursor = 0;
      const worker = async () => {
        while (cursor < uploadFiles.length) {
          const file = uploadFiles[cursor++];
          const info = await stat(file.path);
          const input: PutObjectCommandInput = {
            Bucket: settings.bucket,
            Key: file.key,
            Body: createReadStream(file.path),
            ContentLength: info.size,
            ContentType: file.contentType,
            Metadata: { "pcbridge-md5": file.hash },
          };
          await settings.client.send(new PutObjectCommand(input));
          job.completedFiles += 1;
          this.#update(job, {
            message: `Uploading ${job.completedFiles}/${uploadFiles.length} files`,
          });
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      this.#update(job, {
        state: "completed",
        message: `Uploaded ${uploadFiles.length} files`,
        outputPath: join(prepared.tmpDirectory, "builds", root.buildName, "tinyapp.json"),
        publicUrl: root.publicUrl,
      });
    } catch (error) {
      this.#update(job, {
        state: "error",
        message: "Build failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      activeClient?.destroy();
    }
  }
}
