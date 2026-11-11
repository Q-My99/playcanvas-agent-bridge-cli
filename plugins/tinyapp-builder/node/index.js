import { BuilderManager } from "./builder.js";

export function activate(plugin) {
  const builder = new BuilderManager({
    rootDir: plugin.workspace.rootDir,
    workspace: plugin.workspace,
    collectDependencies: (target, assetId) =>
      plugin.callPage(target, "collectTemplateDependencies", { assetId }, 60000),
  });
  plugin.onDispose(() => builder.close());

  plugin.handle("start", (params, { target }) => {
    if (!target || target.kind !== "editor") {
      throw new Error("Tiny Builder requires a ready PlayCanvas Editor target.");
    }
    if (typeof params.templateAssetId !== "string" || !params.templateAssetId) {
      throw new Error("start requires templateAssetId.");
    }
    return builder.start(target, params.templateAssetId, {
      suffix: typeof params.suffix === "string" ? params.suffix : undefined,
      prefix: typeof params.prefix === "string" ? params.prefix : undefined,
    });
  });

  plugin.handle("status", (params) => {
    const job = builder.get(String(params.jobId));
    if (!job) throw new Error(`Build job ${params.jobId} was not found.`);
    return job;
  });
}
