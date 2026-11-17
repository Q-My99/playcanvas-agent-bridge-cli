// Runs in the PlayCanvas Editor page once the Editor is ready.
// In scope: plugin, editor, pc, pcui, runtimeApp.

function plainAssetJson(asset) {
  if (!asset) return null;
  if (typeof asset.json === "function") return asset.json();
  if (asset.observer && typeof asset.observer.json === "function") return asset.observer.json();
  return null;
}

function collectAssetReferences(assets, value, ids, depth = 0) {
  if (!value || typeof value !== "object" || depth > 100) return;
  for (const [key, child] of Object.entries(value)) {
    if (["id", "path", "uniqueId", "scope", "testTemplate"].includes(key)) continue;
    if (Number.isInteger(child)) {
      const referenced = assets.get(Number(child));
      const id = String(child);
      if (referenced && !ids.has(id)) {
        ids.add(id);
        collectAssetReferences(assets, plainAssetJson(referenced), ids, depth + 1);
      }
    } else if (child && typeof child === "object") {
      collectAssetReferences(assets, child, ids, depth + 1);
    }
  }
}

function templateScriptNames(templateData) {
  const names = new Set();
  for (const entity of Object.values((templateData && templateData.entities) || {})) {
    const scripts = entity && entity.components && entity.components.script &&
      entity.components.script.scripts;
    for (const name of Object.keys(scripts || {})) names.add(name);
  }
  return [...names];
}

function templateChildren(templateData) {
  const ids = new Set();
  for (const entity of Object.values((templateData && templateData.entities) || {})) {
    const attributes = entity && entity.components && entity.components.script &&
      entity.components.script.scripts &&
      entity.components.script.scripts.sdsTinyRootHandler &&
      entity.components.script.scripts.sdsTinyRootHandler.attributes;
    if (attributes && attributes.type === "testTemplate" && Number.isInteger(attributes.testTemplate)) {
      ids.add(String(attributes.testTemplate));
    }
  }
  return [...ids];
}

plugin.handle("collectTemplateDependencies", (params) => {
  const assets = editor.api.globals.assets;
  const template = assets.get(Number(params.assetId));
  if (!template || template.get("type") !== "template") {
    throw new Error("Template asset not found: " + params.assetId);
  }
  const templateJson = plainAssetJson(template);
  if (!templateJson || !templateJson.data) {
    throw new Error("Template asset has no serializable data: " + params.assetId);
  }

  const ids = new Set();
  collectAssetReferences(assets, templateJson.data, ids);
  const scripts = [];
  for (const name of templateScriptNames(templateJson.data)) {
    const scriptAsset =
      (typeof assets.getAssetForScript === "function" && assets.getAssetForScript(name)) ||
      (editor.assets && typeof editor.assets.getAssetForScript === "function" &&
        editor.assets.getAssetForScript(name)) ||
      assets.list().find((asset) =>
        asset.get("type") === "script" &&
        (asset.get("name") === name || asset.get("data.scripts." + name) !== undefined)
      );
    if (!scriptAsset) continue;
    const scriptJson = plainAssetJson(scriptAsset);
    const filename = scriptJson && scriptJson.file && scriptJson.file.filename;
    if (
      name.startsWith("sds") ||
      String(filename || (scriptJson && scriptJson.name) || "").startsWith("sds")
    ) continue;
    ids.add(String(scriptAsset.get("id")));
    scripts.push({ name, assetId: String(scriptAsset.get("id")) });
  }

  return {
    template: templateJson,
    assets: [...ids].map((id) => plainAssetJson(assets.get(Number(id)))).filter(Boolean),
    scripts,
    childTemplateIds: templateChildren(templateJson.data),
    projectUrl: window.config && window.config.project && window.config.project.id
      ? new URL("/project/" + window.config.project.id + "/overview", location.href).href
      : null,
    sceneUrl: location.href
  };
});

let panel = null;
let refreshTimer = null;
let selectedTemplateId = null;
let selectedTemplateAsset = null;

function selectedAssetState() {
  try {
    const items = editor.call && editor.call("selector:items");
    if (Array.isArray(items)) return { known: true, asset: items[0] || null };
  } catch {
    // Fall through to the public selection API.
  }
  const selection = editor.api.globals.selection;
  const items = selection && (
    (Array.isArray(selection.items) && selection.items) ||
    (typeof selection.list === "function" && selection.list()) ||
    (typeof selection.get === "function" && selection.get())
  );
  return Array.isArray(items)
    ? { known: true, asset: items[0] || null }
    : { known: false, asset: null };
}

function destroyPanel() {
  if (panel && typeof panel.destroy === "function") panel.destroy();
  panel = null;
  selectedTemplateId = null;
  selectedTemplateAsset = null;
}

function panelIsAttached(layout) {
  if (!panel || panel.destroyed === true) return false;
  if (panel.dom && typeof panel.dom.isConnected === "boolean") return panel.dom.isConnected;
  if ("parent" in panel) return panel.parent === layout;
  return true;
}

function appendRow(container, labelText, control) {
  const row = new pcui.Container();
  row.flex = true;
  row.flexDirection = "row";
  row.append(new pcui.Label({ text: labelText }));
  row.append(control);
  container.append(row);
}

function showPanel(asset) {
  const type = asset && typeof asset.get === "function" ? asset.get("type") : null;
  const id = asset && typeof asset.get === "function" ? String(asset.get("id")) : null;
  if (type !== "template" || !id) {
    destroyPanel();
    return;
  }
  const layout = editor.call && editor.call("layout.attributes");
  if (!pcui || !pcui.Container || !pcui.Button || !pcui.Label || !pcui.TextInput || !layout) return;
  if (panel && selectedTemplateId === id && panelIsAttached(layout)) return;
  destroyPanel();

  const projectId = window.config && window.config.project && window.config.project.id
    ? String(window.config.project.id)
    : "project";
  const suffixKey = `pcbridge:builder:${id}:suffix`;
  const prefixKey = `pcbridge:builder:${projectId}:prefix`;
  const urlKey = `pcbridge:builder:${id}:url`;
  const container = new pcui.Container();
  container.flex = true;
  container.flexDirection = "column";
  if (container.class && typeof container.class.add === "function") {
    container.class.add("pcbridge-tiny-builder");
  }
  container.append(new pcui.Label({ text: "pcbridge Tiny Builder" }));
  const prefixInput = new pcui.TextInput({ value: localStorage.getItem(prefixKey) || "" });
  const suffixInput = new pcui.TextInput({ value: localStorage.getItem(suffixKey) || "" });
  if (typeof prefixInput.on === "function") {
    prefixInput.on("change", () => localStorage.setItem(prefixKey, String(prefixInput.value || "")));
    suffixInput.on("change", () => localStorage.setItem(suffixKey, String(suffixInput.value || "")));
  }
  appendRow(container, "上传目录", prefixInput);
  appendRow(container, "文件后缀", suffixInput);
  const pathLabel = new pcui.Label({ text: localStorage.getItem(urlKey) || "" });
  appendRow(container, "引用路径", pathLabel);
  const buildButton = new pcui.Button({ text: "构建并上传到 S3" });
  const copyButton = new pcui.Button({ text: "复制引用路径" });
  const logLabel = new pcui.Label({ text: "从项目 .env 或工作区 .env 读取 S3 配置" });
  copyButton.on("click", () => {
    if (pathLabel.text) void navigator.clipboard.writeText(pathLabel.text);
  });
  buildButton.on("click", async () => {
    buildButton.enabled = false;
    try {
      let job = await plugin.call("start", {
        templateAssetId: id,
        suffix: String(suffixInput.value || ""),
        prefix: String(prefixInput.value || "")
      });
      while (job.state !== "completed" && job.state !== "error") {
        logLabel.text = job.message || job.state;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        job = await plugin.call("status", { jobId: job.id }, 30000);
      }
      if (job.state === "error") throw new Error(job.error || "Template build failed.");
      pathLabel.text = job.publicUrl || "";
      localStorage.setItem(urlKey, pathLabel.text);
      logLabel.text = job.message || "上传完成";
    } catch (error) {
      logLabel.text = "构建失败: " + String((error && error.message) || error);
    } finally {
      buildButton.enabled = true;
    }
  });
  container.append(buildButton);
  container.append(copyButton);
  container.append(logLabel);
  layout.append(container);
  panel = container;
  selectedTemplateId = id;
  selectedTemplateAsset = asset;
}

function refreshPanel(asset) {
  const selection = selectedAssetState();
  if (selection.known) showPanel(selection.asset);
  else showPanel(asset || selectedTemplateAsset);
}

function scheduleRefresh(asset) {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshPanel(asset);
  }, 150);
}

const subscriptions = [];
for (const selection of [editor.selection, editor.api.globals.selection]) {
  if (!selection || typeof selection.on !== "function") continue;
  subscriptions.push(selection.on("add", (asset) => scheduleRefresh(asset)));
  subscriptions.push(selection.on("remove", () => scheduleRefresh()));
  subscriptions.push(selection.on("change", () => scheduleRefresh()));
}
// The Inspector rebuilds its layout on reselection, so the panel is re-attached periodically.
const attachTimer = setInterval(() => refreshPanel(), 1000);
refreshPanel();

plugin.onDispose(() => {
  clearInterval(attachTimer);
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  for (const handle of subscriptions) {
    if (handle && typeof handle.unbind === "function") handle.unbind();
  }
  destroyPanel();
});
