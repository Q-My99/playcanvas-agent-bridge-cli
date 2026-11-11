import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Envelope, JsonValue, TargetInfo } from "../shared/protocol.js";
import type { WorkspaceManager } from "../workspace/manager.js";
import {
  PluginError,
  summarizePlugin,
  type AvailablePlugin,
  type InstalledPlugin,
  type PluginSource,
  type PluginStore,
  type PluginSummary,
} from "./store.js";

type TargetRequest = (
  target: string,
  method: string,
  params?: Record<string, JsonValue>,
  timeoutMs?: number,
) => Promise<Envelope>;

type PluginHostOptions = {
  store: PluginStore;
  workspace: WorkspaceManager;
  requestTarget: TargetRequest;
  listTargets: () => TargetInfo[];
  log: (message: string) => void;
};

type ActionHandler = (
  params: Record<string, JsonValue>,
  context: { target: TargetInfo | null },
) => unknown;

type PageKind = "editor" | "launch";

type PageResult = { id: string; ok: boolean; error?: string };

type Runtime = {
  handlers: Map<string, ActionHandler>;
  disposers: Array<() => unknown>;
  pages: Partial<Record<PageKind, { version: string; code: string }>>;
  error: string | null;
};

export type PluginStatus = PluginSummary & {
  pages: Array<{ target: string; ok: boolean; error: string | null }>;
};

const require = createRequire(import.meta.url);

function targetId(target: TargetInfo | string): string {
  return typeof target === "string" ? target : target.id;
}

async function unwrap(response: Promise<Envelope>): Promise<JsonValue> {
  const envelope = await response;
  if (envelope.ok) return envelope.data;
  throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code });
}

export class PluginHost {
  #store: PluginStore;
  #workspace: WorkspaceManager;
  #requestTarget: TargetRequest;
  #listTargets: () => TargetInfo[];
  #log: (message: string) => void;
  #active = new Map<string, Runtime>();
  #revision = 0;
  #synced = new Map<string, string>();
  #pageResults = new Map<string, PageResult[]>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: PluginHostOptions) {
    this.#store = options.store;
    this.#workspace = options.workspace;
    this.#requestTarget = options.requestTarget;
    this.#listTargets = options.listTargets;
    this.#log = options.log;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  start(): Promise<void> {
    return this.#serial(async () => {
      for (const plugin of await this.#store.list()) {
        if (plugin.enabled) await this.#activate(plugin);
      }
      await this.#resync();
    });
  }

  close(): Promise<void> {
    return this.#serial(async () => {
      for (const id of [...this.#active.keys()]) await this.#deactivate(id);
    });
  }

  async #activate(plugin: InstalledPlugin): Promise<void> {
    const runtime: Runtime = { handlers: new Map(), disposers: [], pages: {}, error: plugin.error };
    this.#active.set(plugin.id, runtime);
    const manifest = plugin.manifest;
    if (!manifest) return;
    const requestTarget = this.#requestTarget;
    const workspace = this.#workspace;
    try {
      const directory = await realpath(plugin.path);
      if (manifest.node) {
        for (const key of Object.keys(require.cache)) {
          if (key.startsWith(`${directory}${sep}`) && !key.includes(`${sep}node_modules${sep}`)) {
            delete require.cache[key];
          }
        }
        const module = await import(pathToFileURL(join(directory, manifest.node)).href) as {
          activate?: (api: unknown) => unknown;
        };
        if (typeof module.activate !== "function") {
          throw new Error(`${manifest.node} must export an activate(plugin) function.`);
        }
        await module.activate({
          id: plugin.id,
          version: manifest.version,
          dir: directory,
          workspace: {
            rootDir: workspace.rootDir,
            status: (target: TargetInfo) => workspace.statusForTarget(target),
            prepareAssetFiles: (target: TargetInfo, assetIds: Array<string | number>) =>
              workspace.prepareAssetFiles(target, assetIds),
            prepareAssetResources: (
              target: TargetInfo,
              requests: Parameters<WorkspaceManager["prepareAssetResources"]>[1],
            ) => workspace.prepareAssetResources(target, requests),
          },
          targets: () => this.#listTargets().filter((target) => target.connected),
          handle: (name: string, handler: ActionHandler) => { runtime.handlers.set(name, handler); },
          onDispose: (dispose: () => unknown) => { runtime.disposers.push(dispose); },
          callPage: (
            target: TargetInfo | string,
            name: string,
            params: Record<string, JsonValue> = {},
            timeoutMs = 15000,
          ) => unwrap(requestTarget(targetId(target), `plugin:${plugin.id}:${name}`, params, timeoutMs)),
          rpc: (
            target: TargetInfo | string,
            method: string,
            params: Record<string, JsonValue> = {},
            timeoutMs = 15000,
          ) => unwrap(requestTarget(targetId(target), method, params, timeoutMs)),
          log: (message: string) => this.#log(`[plugin ${plugin.id}] ${message}`),
        });
      }
      for (const kind of ["editor", "launch"] as const) {
        const file = manifest.page?.[kind];
        if (file) {
          runtime.pages[kind] = {
            version: manifest.version,
            code: await readFile(join(directory, file), "utf8"),
          };
        }
      }
    } catch (error) {
      await this.#dispose(plugin.id, runtime);
      runtime.pages = {};
      runtime.error = error instanceof Error ? error.message : String(error);
      this.#log(`plugin ${plugin.id} failed to activate: ${runtime.error}`);
    }
  }

  async #dispose(id: string, runtime: Runtime): Promise<void> {
    runtime.handlers.clear();
    for (const dispose of runtime.disposers.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        this.#log(`plugin ${id} dispose failed: ${String(error)}`);
      }
    }
  }

  async #deactivate(id: string): Promise<void> {
    const runtime = this.#active.get(id);
    if (!runtime) return;
    this.#active.delete(id);
    await this.#dispose(id, runtime);
  }

  async #restart(id: string): Promise<void> {
    await this.#deactivate(id);
    const plugin = await this.#store.get(id);
    if (plugin.enabled) await this.#activate(plugin);
    await this.#resync();
  }

  async #syncTarget(info: TargetInfo): Promise<void> {
    if (!info.connected || !info.ready || (info.kind !== "editor" && info.kind !== "launch")) return;
    const signature = `${info.clientId}:${this.#revision}`;
    if (this.#synced.get(info.id) === signature) return;
    this.#synced.set(info.id, signature);
    const kind = info.kind;
    const plugins = [...this.#active].flatMap(([id, runtime]) => {
      const page = runtime.pages[kind];
      return page ? [{ id, version: page.version, code: page.code }] : [];
    });
    const response = await this.#requestTarget(info.id, "bridge:syncPlugins", { plugins }, 20000);
    if (this.#synced.get(info.id) !== signature) return;
    this.#pageResults.set(
      info.id,
      response.ok
        ? (response.data as { plugins: PageResult[] }).plugins
        : plugins.map((plugin) => ({ id: plugin.id, ok: false, error: response.error.message })),
    );
  }

  async #resync(): Promise<void> {
    this.#revision += 1;
    await Promise.all(this.#listTargets().map((info) => this.#syncTarget(info)));
  }

  handleTarget(info: TargetInfo): void {
    void this.#syncTarget(info);
  }

  forgetTarget(info: TargetInfo): void {
    this.#synced.delete(info.id);
    this.#pageResults.delete(info.id);
  }

  #status(plugin: InstalledPlugin): PluginStatus {
    const summary = summarizePlugin(plugin);
    const runtime = this.#active.get(plugin.id);
    const pages: PluginStatus["pages"] = [];
    for (const [target, results] of this.#pageResults) {
      const result = results.find((item) => item.id === plugin.id);
      if (result) pages.push({ target, ok: result.ok, error: result.error || null });
    }
    if (!runtime) return { ...summary, pages };
    return {
      ...summary,
      state: runtime.error ? "error" : "active",
      error: runtime.error,
      pages,
    };
  }

  async list(): Promise<{ plugins: PluginStatus[]; available: AvailablePlugin[] }> {
    return {
      plugins: (await this.#store.list()).map((plugin) => this.#status(plugin)),
      available: await this.#store.available(),
    };
  }

  async get(id: string): Promise<PluginStatus> {
    return this.#status(await this.#store.get(id));
  }

  add(source: PluginSource): Promise<PluginStatus> {
    return this.#serial(async () => {
      const plugin = await this.#store.add(source);
      await this.#restart(plugin.id);
      return this.get(plugin.id);
    });
  }

  remove(id: string): Promise<{ id: string; removed: true }> {
    return this.#serial(async () => {
      await this.#store.remove(id);
      await this.#deactivate(id);
      await this.#resync();
      return { id, removed: true };
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<PluginStatus> {
    return this.#serial(async () => {
      await this.#store.setEnabled(id, enabled);
      await this.#restart(id);
      return this.get(id);
    });
  }

  update(id: string): Promise<PluginStatus & { previousVersion: string | null }> {
    return this.#serial(async () => {
      const { previousVersion } = await this.#store.update(id);
      await this.#restart(id);
      return { ...(await this.get(id)), previousVersion };
    });
  }

  reload(id: string): Promise<PluginStatus> {
    return this.#serial(async () => {
      await this.#restart(id);
      return this.get(id);
    });
  }

  async callAction(
    id: string,
    action: string,
    params: Record<string, JsonValue>,
    target: TargetInfo | null,
  ): Promise<JsonValue> {
    const runtime = this.#active.get(id);
    if (!runtime) {
      await this.#store.get(id);
      throw new PluginError("PLUGIN_DISABLED", `Plugin ${id} is disabled. Run pcbridge plugin enable ${id}.`);
    }
    if (runtime.error) throw new PluginError("PLUGIN_ERROR", runtime.error);
    const handler = runtime.handlers.get(action);
    if (!handler) {
      throw new PluginError(
        "PLUGIN_ACTION_NOT_FOUND",
        `Plugin ${id} has no action ${action}. Available: ${[...runtime.handlers.keys()].join(", ") || "none"}.`,
      );
    }
    return (await handler(params, { target }) ?? null) as JsonValue;
  }
}
