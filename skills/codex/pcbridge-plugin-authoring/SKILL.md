---
name: pcbridge-plugin-authoring
description: Create, test, and manage pcbridge plugins: optional packages that add local Node code to the pcbridge daemon and inject scripts into PlayCanvas Editor or Launch pages. Use when asked to build or change a pcbridge plugin, add Editor UI or tooling through pcbridge, connect a local application such as Blender to PlayCanvas, or add, enable, disable, update, or debug plugins.
---

# pcbridge Plugin Authoring

A pcbridge plugin is an optional package that users add, enable, disable, and remove
independently. It is **not** the Chrome extension: the extension is a fixed part of pcbridge,
while plugins are loaded by the pcbridge daemon and delivered to pages through that extension.
Different users enable different plugins (a modeller's Blender sync, a programmer's Editor
buttons), so never add plugin features to pcbridge core or to the extension source.

## Where plugin code runs

| Runtime | Entry in the manifest | Runs in | Use it for |
| --- | --- | --- | --- |
| node | `node` | The local pcbridge daemon (Bun) | Files, network, credentials, child processes, local apps (Blender, DCC tools), heavy work |
| page | `page.editor`, `page.launch` | The PlayCanvas Editor / Launch page (MAIN world) | Editor UI, `editor.api.globals` reads and writes, runtime inspection |
| extension | none | Isolated world, service worker, popup | Not extensible. It only relays messages and hosts the **Plugins** management tab |

Plugins cannot ship code into the extension runtime: Manifest V3 forbids running code that is not
packaged with the extension, and that runtime holds the daemon session token. A page script
therefore has no `chrome.*` API and no token; anything privileged goes through a node action.

```text
pcbridge plugin call <id> <action>  ─┐
page: plugin.call(action, params)   ─┴─>  node: plugin.handle(action, fn)
node: plugin.callPage(target, name, params)  ──>  page: plugin.handle(name, fn)
```

## Package layout

```text
my-plugin/
  pcbridge-plugin.json   # manifest (required)
  node/index.js          # optional node entry
  page/editor.js         # optional Editor page script
  page/launch.js         # optional Launch page script
  package.json           # optional; only when the node side has npm dependencies
```

`pcbridge-plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "minPcbridgeVersion": "0.7.0",
  "description": "One sentence shown in plugin lists.",
  "node": "node/index.js",
  "page": { "editor": "page/editor.js", "launch": "page/launch.js" },
  "actions": {
    "export": {
      "description": "What the action does and returns.",
      "params": { "assetId": "Asset id (required).", "format": "glb or fbx; default glb." }
    }
  }
}
```

Manifest rules:

- `id`: 2-49 characters, lowercase letters, digits, and hyphens. It names the plugin in the CLI,
  in RPC routes, and in the install directory; never change it after release.
- `name`, `version` (semantic version), and `apiVersion: 1` are required.
- `minPcbridgeVersion` (optional semantic version) declares the minimum `pcbridge` core version required to install or update this plugin.
- At least one of `node`, `page.editor`, `page.launch` is required. Every entry is a relative path
  to an existing file inside the plugin directory.
- `actions` documents the node actions for other agents (`pcbridge plugin info <id>`). Keep it in
  step with the `plugin.handle` calls in the node entry.
- Bump `version` on every released change.

## Node entry

An ES module (JavaScript or TypeScript; the daemon runs on Bun) that exports `activate(plugin)`.
`activate` may be async. It runs when the daemon starts and whenever the plugin is added, enabled,
updated, or reloaded.

```js
export function activate(plugin) {
  plugin.handle("export", async (params, { target }) => {
    if (!target || target.kind !== "editor") throw new Error("export requires an Editor target.");
    const selection = await plugin.callPage(target, "selection");
    return { exported: selection.length };
  });
  const timer = setInterval(() => { /* ... */ }, 5000);
  plugin.onDispose(() => clearInterval(timer));
}
```

| Member | Purpose |
| --- | --- |
| `plugin.id`, `plugin.version`, `plugin.dir` | Identity and the absolute plugin directory |
| `plugin.handle(name, fn)` | Register an action. `fn(params, { target })` returns JSON-serializable data or throws an `Error` (an optional string `code` becomes the CLI error code) |
| `plugin.callPage(target, name, params?, timeoutMs?)` | Call a handler registered by this plugin's page script; resolves with its result |
| `plugin.rpc(target, method, params?, timeoutMs?)` | Call a built-in bridge method, for example `bridge:eval` with `{ code, args }` |
| `plugin.targets()` | Connected targets (`id`, `kind`, `ready`, `projectId`, `sceneId`, ...) for node-initiated work |
| `plugin.workspace.rootDir` | The daemon workspace root |
| `plugin.workspace.status(target)` | Workspace status, including `projectDirectory` and `tmpDirectory` |
| `plugin.workspace.prepareAssetFiles(target, assetIds)` | Materialize asset files locally; returns `{ projectDirectory, tmpDirectory, assets: [{ id, name, type, filename, path, hash }] }` |
| `plugin.workspace.prepareAssetResources(target, requests)` | Materialize auxiliary files such as texture variants: `[{ assetId, filename, url, hash? }]` |
| `plugin.log(message)` | Write to the daemon log |
| `plugin.onDispose(fn)` | Register cleanup; runs on disable, remove, reload, update, and daemon stop |

`target` in an action context is the `--target` of the CLI call, the calling tab for a page call,
otherwise the most recent ready target, otherwise `null`. Functions that take a target accept that
object or a selector string such as `tab:5` or `editor:<sceneId>`.

## Page script

A single classic script. pcbridge runs its text as the body of an async function once the target
is ready (Editor: `editor.api.globals` exists; Launch: the app has started in a visible tab), with
`plugin`, `editor`, `pc`, `pcui`, and `runtimeApp` in scope. `import` and `export` are not
available; bundle to one file if you need modules.

```js
const button = new pcui.Button({ text: "Export selection" });
button.class.add("my-plugin-export");
editor.call("layout.toolbar").append(button);
button.on("click", async () => {
  const result = await plugin.call("export", { format: "glb" });
  console.info("[my-plugin] exported", result.exported);
});

plugin.handle("selection", () =>
  editor.api.globals.selection.items.map((item) => String(item.get("resource_id") || item.get("id"))));

plugin.onDispose(() => button.destroy());
```

| Member | Purpose |
| --- | --- |
| `plugin.id`, `plugin.version`, `plugin.kind` | Identity; `kind` is `"editor"` or `"launch"` |
| `plugin.handle(name, fn)` | Register a handler for `plugin.callPage` on the node side; return plain JSON |
| `plugin.call(action, params?, timeoutMs?)` | Call a node action of the same plugin; the target is this tab |
| `plugin.onDispose(fn)` | Register cleanup; runs when the plugin is disabled, removed, or its code changes |

Enabling, disabling, and reloading take effect in open pages immediately; no page refresh is
needed. A script whose text is unchanged is not re-run.

## Rules

1. **Split by capability.** Credentials, file paths, and network calls to other services stay in
   node. Page scripts only touch the page. Never send secrets to a page or return them from an
   action.
2. **Everything is disposable.** Whatever `activate` or a page script creates (timers, sockets,
   servers, child processes, DOM and pcui elements, event subscriptions via `handle.unbind()`)
   must be undone in `onDispose`. A reload must not leave duplicates.
3. **Top level must be fast.** Page activation times out after 10 seconds and `activate` blocks
   other plugin operations; start long work in the background and report it through an action
   such as `status`.
4. **Plain JSON across boundaries.** Never return Observers, Entities, DOM nodes, or class
   instances. Pass asset ids and local paths instead of file contents.
5. **Catch errors in your own callbacks.** An uncaught exception in a node timer or socket callback
   can stop the daemon. If a plugin prevents the daemon from starting, stop the daemon and run
   `pcbridge plugin disable <id>`; management commands work on disk while the daemon is down.
6. **Namespace by plugin id.** CSS classes, `localStorage` keys, and global names start with the id.
7. **Feature-detect Editor and Engine APIs** and use `{ history: true }` for Editor mutations when
   available, as in `pcbridge eval` snippets.
8. **Declare npm dependencies** in the plugin's own `package.json` `dependencies`. pcbridge runs
   `bun install --production` when the plugin is added or updated. For `--link` plugins run
   `bun install` in the directory yourself. Do not rely on pcbridge's own dependencies.
9. Keep plugin source outside any project `assets/` directory; the workspace watcher uploads files
   created there.

## Develop and verify

```bash
pcbridge plugin add ./my-plugin --link      # use the directory in place
pcbridge plugin list                        # state must be "active"; read error and pages[]
pcbridge plugin call my-plugin export --target editor:<sceneId> --params '{"format":"glb"}'
pcbridge plugin reload my-plugin            # after every edit to node or page files
pcbridge eval --target editor:<sceneId> --code "return !!document.querySelector('.my-plugin-export')"
pcbridge logs get --target editor:<sceneId> --level error
```

`plugin list` and `plugin info <id>` report `state` (`active`, `error`, `disabled`, or `stopped`
when the daemon is not running), the node activation `error`, and one `pages[]` entry per connected
target with the page script result. Treat a plugin as working only when the state is `active`,
every `pages[]` entry is `ok`, each action returns the expected data, and the page effect is
confirmed with `eval` or a viewport capture. `--params-json <file>` reads parameters from a file
inside the project workspace.

Other management commands, also available in the extension popup under **Plugins**:

```bash
pcbridge plugin enable|disable|remove <id>
pcbridge plugin update <id>     # re-fetch from the recorded source, reinstall dependencies, reload
pcbridge plugin update --all    # update all outdated installed plugins
pcbridge plugin list --refresh  # refresh remote official plugin catalog and versions
pcbridge help plugin
```

## Distribute through GitHub

Publish the plugin directory in a public GitHub repository, at the root or in a subdirectory, and
tag releases. Users install and update with:

```bash
pcbridge plugin add github:<owner>/<repo>                       # default branch, plugin at the root
pcbridge plugin add github:<owner>/<repo>/plugins/my-plugin#v1.2.0   # subdirectory, pinned tag
pcbridge plugin update my-plugin                                 # same source and ref again
```

A source without `#ref` follows the default branch, so `update` picks up new commits; a pinned
`#ref` only changes when the plugin is removed and added again with another ref. Commit built
output if the plugin needs a build step, because pcbridge installs the repository files as they
are. Plugins run with full local and page access; tell users to add only sources they trust.

## Reference implementation

`tinyapp-builder` is the official plugin shipped with pcbridge (`pcbridge plugin add
tinyapp-builder`, source under `plugins/tinyapp-builder/` of the pcbridge package). It shows a
node entry with background jobs and npm dependencies, an Editor page script that injects an
Inspector panel and serves `callPage` requests, and a complete `actions` section.
When adding or bumping an official plugin under `plugins/<id>/`, run `bun run plugins:sync` to
synchronize `plugins/index.json` (`bun run check:version` enforces this).
