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

- Node.js 20 or newer.
- TypeScript with ESM modules.
- `pnpm` is the package manager.
- Use `bun` for one-off TypeScript scripts when a repository script does not already exist.
- Write temporary artifacts under `./tmp/`; the directory is ignored by Git.

Common commands:

```bash
pnpm install
pnpm check
pnpm build
pnpm test
pnpm check:version
```

Run a focused test while iterating:

```bash
node --test test/<name>.test.mjs
```

## Repository Map

- `src/cli.ts`: CLI parsing, daemon, RPC handling, workspace/frontend orchestration.
- `src/config.ts`: shared version, ports, and local configuration paths.
- `src/snippets.ts`: page-executed PlayCanvas operations used by structured commands.
- `extension/main.js`: MAIN-world access to PlayCanvas page APIs.
- `extension/isolated.js`: WebSocket and `postMessage` bridge.
- `extension/service-worker.js`: tab metadata and generated extension configuration.
- `extension/popup.*`: extension status and controls.
- `test/`: Node test suite for CLI, daemon, extension, workspace, and frontend behavior.
- `scripts/check-version.mjs`: release-version consistency check.
- `skills/`: agent-specific installation artifacts.

`dist/` is generated and ignored. Edit `src/`, then run `pnpm build`; never patch `dist/`
directly.

## Architecture Boundaries

The normal request path is:

```text
CLI -> daemon HTTP API -> extension WebSocket -> isolated script -> MAIN-world script -> PlayCanvas
```

- The daemon binds to `127.0.0.1` and authenticates requests with the session token stored under
  `~/.pcbridge/`.
- Keep browser-specific access in the extension and PlayCanvas operation code in the page layer.
- Keep target selection compatible with Editor and Launch tabs and with selectors such as
  `current`, `tab:`, `scene:`, `project:`, `editor:`, and `launch:`.
- Treat Engine and Editor APIs as version-sensitive. Use feature detection and existing adapters
  instead of assuming a single global shape.
- Bound logs and serialized results. If data is truncated, report that explicitly.

## Workspace And Security

- The daemon start directory is the workspace root. Keep each PlayCanvas project isolated in its
  generated project directory.
- Source and standalone projections may be writable. Generated derived projections stay
  read-only and content-addressed under `.pcbridge/objects`.
- Preserve simultaneous local and remote changes as conflicts; never silently choose one side.
- Quarantine confirmed remote deletions under the project trash area rather than mixing them with
  content conflicts.
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
  `pnpm test` before finishing when the change affects shared behavior.
- For extension JavaScript changes, also run `node --check` on each edited extension script.
- After extension source changes that require live validation, regenerate the local unpacked
  extension with `node dist/cli.js install-extension --no-open`, reload it in Chrome, and refresh
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

`pnpm check:version` enforces this. A stable `vX.Y.Z` tag triggers the npm publishing workflow.
Do not bump versions, create or move tags, publish npm packages, or create GitHub releases unless
the user explicitly requests a release.

Before committing, inspect the diff for generated files, temporary artifacts, credentials, and
unrelated edits. Do not revert user changes that are outside the task.
