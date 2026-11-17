# PlayCanvas Agent Bridge CLI

## Scope

These instructions apply to the entire repository.

Keep this file focused on durable engineering constraints. Put user documentation in the
READMEs and use commits or issues for progress logs, release history, and one-off test notes.

## Product Invariants

- Keep the product CLI-first. The supported core is a normal CLI, a loopback daemon, and a
  Chrome extension; MCP must remain an optional thin adapter rather than the core interface.
- Control an already-open PlayCanvas Editor or Launch page. Do not introduce a second editor or
  require a hosted service for local automation.
- Prefer structured commands for common workflows. Keep `eval` as an explicit escape hatch.
- Preserve machine-readable JSON output and useful nonzero exit codes. Avoid unsolicited prose
  on stdout when a command returns structured data.
- Send large or binary payloads through dedicated RPC methods. Do not route base64 captures or
  uploads through generic eval serialization.

## Toolchain

- Bun 1.4.0 or newer.
- TypeScript with ESM modules.
- `bun` is the package manager and JavaScript runtime. Install monorepo dependencies at the parent root.
- Use `bun` for one-off TypeScript scripts when a repository script does not already exist.
- Write temporary artifacts under `./tmp/`; the directory is ignored by Git.

Common commands:

```bash
bun install
bun run check
bun run build
bun run test
bun run check:version
```

Run a focused test while iterating:

```bash
bun test test/<name>.test.mjs
```

## Repository Map

- `src/cli.ts`: CLI parsing, RPC handling, and workspace/processing command dispatch.
- `src/config.ts`: shared version, ports, and local configuration paths.
- `src/snippets.ts`: page-executed PlayCanvas operations used by structured commands.
- `src/daemon/`: loopback HTTP/WebSocket daemon server and target/session management.
- `src/workspace/`: event-driven bidirectional asset/scene sync (`manager.ts`) and canonical 3-way JSON merge (`json-sync.ts`).
- `src/processing/`: bounded local asset conversion executor for self-hosted deployments.
- `src/plugins/`: plugin store (`store.ts`: manifest validation, install/update/remove under `~/.pcbridge/plugins/`) and daemon plugin host (`host.ts`: node activation, action routing, page-script sync).
- `plugins/`: official plugins shipped with the package (`plugins/tinyapp-builder/` for the Tiny Builder S3 pipeline and `plugins/local-frontend/` for serving local PlayCanvas Editor builds on `playcanvas.com`).
- `extension/main.js`: MAIN-world access to PlayCanvas page APIs.
- `extension/isolated.js`: WebSocket and `postMessage` bridge.
- `extension/service-worker.js`: tab metadata and generated extension configuration.
- `extension/popup.*`: extension status and controls.
- `test/`: Bun test suite (using the node:test compatibility API) for CLI, daemon, extension, workspace, and official plugin behavior.
- `scripts/check-version.mjs`: release-version consistency check.
- `skills/`: agent-specific installation artifacts, including the `pcbridge-plugin-authoring` skill that defines the plugin format.

`dist/` is generated and ignored. Edit `src/`, then run `bun run build`; never patch `dist/`
directly.

## Architecture Boundaries

The normal request path is:

```text
CLI -> daemon HTTP API -> extension WebSocket -> isolated script -> MAIN-world script -> PlayCanvas
```

- The daemon binds to `127.0.0.1` and authenticates requests with the session token stored under
  `~/.pcbridge/`.
- Keep browser-specific access in the extension and PlayCanvas operation code in the page layer.
- Optional, user-specific features belong in a plugin, not in core. Plugin node code runs in the
  daemon and plugin page scripts run in the MAIN world; plugins never run in the isolated world,
  service worker, or popup. Pages may call plugin actions but never plugin management endpoints.
- When the plugin manifest or either plugin runtime API changes, update every
  `pcbridge-plugin-authoring` skill variant and `plugins/tinyapp-builder/` in the same change.
- Keep target selection compatible with Editor and Launch tabs and with selectors such as
  `current`, `tab:`, `scene:`, `project:`, `editor:`, and `launch:`.
- Treat Engine and Editor APIs as version-sensitive. Use feature detection and existing adapters
  instead of assuming a single global shape.
- Bound logs and serialized results. If data is truncated, report that explicitly.

## Workspace And Security

- The daemon start directory is the workspace root. Keep each PlayCanvas project isolated in its
  generated project directory.
- Synchronization is event-driven via WebSocket `workspace:delta` pushes and targeted `fs.watch`
  dirty paths (no idle polling). Within the configurable 1–10 MB direct-sync limit (default 2 MB),
  Tier 1 text assets and structured JSON data assets (`*.<type>.json`, including model-linked
  materials carrying `$pcbridge.sourceAssetId`) plus the active scene (`scenes/*.scene.json`,
  `$pcbridge.active: true`) are writable (`0o644`) and bidirectional. Inactive scenes and generated
  binary derivatives (`container`, `model`, font atlases) stay read-only (`0o444`) and backed by
  `.pcbridge/objects` or `.pcbridge/baselines`.
- Structured JSON assets and the active `.scene.json` use property-path 3-way merge against
  `.pcbridge/baselines/`; preserve conflicting edits to the same leaf property under
  `tmp/conflicts/` and never silently choose one side.
- Deleting a local Tier 1 eagerly synced file backs it up under `tmp/trash/local/` and deletes the
  remote Asset; deleting a pulled Tier 2 lazy binary file only evicts local cache. Quarantine
  confirmed remote deletions under `tmp/trash/remote/` rather than mixing them with conflicts.
- Keep file inputs and generated outputs inside the selected project unless the user explicitly
  passes `--allow-external-path`.
- Keep daemon and frontend servers loopback-only. Do not log session tokens, credentials, `.env`
  values, or signed URLs.
- Validate extension message source, shape, target, and request identifiers before executing page
  operations.

## Change And Test Rules

- Make the smallest change that solves the requested behavior and follow existing command/result
  patterns.
- Add or update a focused regression test for behavior changes. Run that test first, then
  `bun run test` before finishing when the change affects shared behavior.
- For extension JavaScript changes, also run `bun build --target browser --no-bundle` on each edited extension script.
- After extension source changes that require live validation, regenerate the local unpacked
  extension with `bun dist/cli.js install-extension --no-open`, reload it in Chrome, and refresh
  the affected Editor or Launch tab.
- Live PlayCanvas checks should use task-scoped temporary entities/assets and clean them up before
  completion. Do not modify unrelated scene content.
- Update both `README.md` and `README.zh-CN.md` when user-facing installation, commands, or behavior
  changes.

## Versions And Releases

The release version must stay synchronized in:

- `package.json`
- `src/config.ts`
- `extension/manifest.json`

`bun run check:version` enforces this. A stable `vX.Y.Z` tag triggers the npm publishing workflow.
Do not bump versions, create or move tags, publish npm packages, or create GitHub releases unless
the user explicitly requests a release.

Before committing, inspect the diff for generated files, temporary artifacts, credentials, and
unrelated edits. Do not revert user changes that are outside the task.
