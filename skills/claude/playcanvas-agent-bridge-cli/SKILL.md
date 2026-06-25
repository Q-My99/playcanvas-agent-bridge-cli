---
name: playcanvas-agent-bridge-cli
description: Control an already-open PlayCanvas Editor scene through pcbridge CLI commands and the bundled Chrome extension. Use for PlayCanvas Editor inspection, entity/asset/script edits, eval snippets, and viewport captures without DevTools or browser automation.
---

# PlayCanvas Agent Bridge CLI

Use `pcbridge` as the only interface. Start with:

```bash
pcbridge doctor
pcbridge daemon status
pcbridge targets
```

If the daemon is offline, ask the user to run `pcbridge daemon start` in another terminal. If no PlayCanvas target appears, ask the user to run `pcbridge install-extension`, load the printed directory in `chrome://extensions`, and refresh the Editor tab.

Prefer structured commands:

```bash
pcbridge entity list --target current --limit 50
pcbridge entity create --target current --json ./entity.json
pcbridge entity patch --target current --id <resource_id> --set position='[0,1,0]'
pcbridge asset list --target current --type script
pcbridge script set-text --target current --asset-id <id> --file ./script.js
pcbridge viewport capture --target current --out /tmp/playcanvas.webp
```

Use `pcbridge eval` for custom work:

```bash
pcbridge eval --target current --code "return { href: location.href, entityCount: editor.api.globals.entities.list().length }"
```

Eval snippets run in an async function with `editor`, `pc`, `pcui`, `window`, `document`, `command`, and `serialize`. Return compact JSON only. Do not return raw PlayCanvas Editor objects. Use `{ history: true }` for Editor mutations when available, and verify changes with a read-only command.
