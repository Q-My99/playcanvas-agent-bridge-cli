// Runs in the PlayCanvas Editor page once the Editor is ready.
// In scope: plugin, editor, pc, pcui, runtimeApp.

function parseOfficialEditorUrl(rawHref) {
  try {
    const url = new URL(rawHref);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hostname !== "playcanvas.com" ||
      !url.pathname.startsWith("/editor")
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function buildModeUrl(rawHref, mode) {
  const url = parseOfficialEditorUrl(rawHref);
  if (!url || (mode !== "local" && mode !== "official")) return null;
  const hadLocal = url.searchParams.has("use_local_frontend");
  if (mode === "local") url.searchParams.set("use_local_frontend", "");
  else url.searchParams.delete("use_local_frontend");
  return {
    changed: hadLocal !== url.searchParams.has("use_local_frontend"),
    url: url.toString()
  };
}

function navigateToUrl(targetUrl) {
  if (location && typeof location.replace === "function") {
    location.replace(targetUrl);
  } else if (location) {
    location.href = targetUrl;
  }
}

const isSelfhost = Boolean(window.config && window.config.selfhost);
const initialEditorUrl = !isSelfhost ? parseOfficialEditorUrl(location.href) : null;

plugin.handle("navigateMode", (params) => {
  const mode = params && params.mode === "custom" ? "local" : params && params.mode;
  if (!initialEditorUrl) {
    return { ok: false, redirected: false, reason: "official-playcanvas-only" };
  }
  const next = buildModeUrl(location.href, mode);
  if (!next) return { ok: false, redirected: false, reason: "invalid-mode" };
  if (next.changed) navigateToUrl(next.url);
  return { ok: true, redirected: next.changed, url: next.url };
});

if (initialEditorUrl) {
  const projectMatch = initialEditorUrl.pathname.match(/^\/editor\/project\/(\d+)(?:\/|$)/);
  const projectId =
    window.config && window.config.project && window.config.project.id
      ? String(window.config.project.id)
      : projectMatch
        ? projectMatch[1]
        : null;

  let disposed = false;
  let currentStatus = null;
  let busy = false;
  const cleanup = [];

  plugin.onDispose(() => {
    disposed = true;
    for (const fn of cleanup.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // Ignore cleanup errors during hot reload.
      }
    }
  });

  try {
    currentStatus = await plugin.call("status", projectId ? { projectId } : {});
  } catch {
    currentStatus = null;
  }

  if (!disposed && currentStatus) {
    const currentlyLocal = new URL(location.href).searchParams.has("use_local_frontend");
    const serverReady = Boolean(
      currentStatus.ready && currentStatus.server && currentStatus.server.listening
    );
    if (currentStatus.preference === "local" && !currentlyLocal && serverReady) {
      const next = buildModeUrl(location.href, "local");
      if (next && next.changed) {
        navigateToUrl(next.url);
        return;
      }
    }
    if (currentStatus.preference === "official" && currentlyLocal) {
      const next = buildModeUrl(location.href, "official");
      if (next && next.changed) {
        navigateToUrl(next.url);
        return;
      }
    }
  }

  const toolbar = editor && typeof editor.call === "function" ? editor.call("layout.toolbar") : null;
  const toolbarDom = (toolbar && toolbar.dom) || null;
  if (!disposed && typeof document !== "undefined" && document.body && toolbarDom) {
    const style = document.createElement("style");
    style.dataset.pcbridgePlugin = "local-frontend";
    style.textContent = [
      ".local-frontend-button {",
      "  position: relative; width: 36px; height: 36px; margin: 2px auto; padding: 0;",
      "  display: flex; align-items: center; justify-content: center;",
      "  background: transparent; border: 0; border-radius: 4px; color: #b1b8ba; cursor: pointer;",
      "}",
      ".local-frontend-button:hover { background: #293538; color: #fff; }",
      ".local-frontend-button[data-mode='local'] { color: #4ade80; }",
      ".local-frontend-button[data-warning='true'] { color: #facc15; }",
      ".local-frontend-popover {",
      "  position: fixed; z-index: 10000; width: 268px; padding: 12px;",
      "  background: #20292b; border: 1px solid #364346; border-radius: 8px;",
      "  box-shadow: 0 10px 28px rgba(0,0,0,0.45); color: #e2e8ea;",
      "  font: 12px/1.45 Inter, -apple-system, BlinkMacSystemFont, sans-serif;",
      "}",
      ".local-frontend-popover[hidden] { display: none !important; }",
      ".local-frontend-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #9aa6a9; margin-bottom: 8px; }",
      ".local-frontend-row { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; }",
      ".local-frontend-row span:first-child { color: #9aa6a9; flex-shrink: 0; }",
      ".local-frontend-row span:last-child { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: SFMono-Regular, Consolas, monospace; font-size: 11px; }",
      ".local-frontend-note { margin: 6px 0 0; color: #facc15; font-size: 11px; }",
      ".local-frontend-note[hidden] { display: none !important; }",
      ".local-frontend-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }",
      ".local-frontend-actions button, .local-frontend-update {",
      "  background: #2c393c; border: 1px solid #415155; border-radius: 5px; color: #fff;",
      "  padding: 6px 8px; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;",
      "}",
      ".local-frontend-actions button.primary { background: #2563eb; border-color: #3b82f6; }",
      ".local-frontend-actions button:disabled, .local-frontend-update:disabled { opacity: 0.45; cursor: not-allowed; }",
      ".local-frontend-update { width: 100%; margin-top: 6px; }"
    ].join("\n");
    (document.head || document.body).appendChild(style);
    cleanup.push(() => style.remove());

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "local-frontend-button";
    btn.title = "pcbridge Local Frontend";
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="2" y="3" width="20" height="14" rx="2"/>' +
      '<path d="M8 21h8"/><path d="M12 17v4"/><path d="m9 8-2 2 2 2"/><path d="m15 8 2 2-2 2"/>' +
      "</svg>";
    toolbarDom.appendChild(btn);
    cleanup.push(() => btn.remove());

    const popover = document.createElement("div");
    popover.className = "local-frontend-popover";
    popover.hidden = true;

    const title = document.createElement("div");
    title.className = "local-frontend-title";
    title.textContent = "Local Frontend";
    popover.appendChild(title);

    function makeRow(label) {
      const row = document.createElement("div");
      row.className = "local-frontend-row";
      const key = document.createElement("span");
      key.textContent = label;
      const val = document.createElement("span");
      row.append(key, val);
      popover.appendChild(row);
      return val;
    }

    const modeVal = makeRow("Mode");
    const releaseVal = makeRow("Release");
    const serverVal = makeRow("Server");
    const prefVal = makeRow("Preference");

    const noteEl = document.createElement("p");
    noteEl.className = "local-frontend-note";
    noteEl.hidden = true;
    popover.appendChild(noteEl);

    const actions = document.createElement("div");
    actions.className = "local-frontend-actions";
    const useLocalBtn = document.createElement("button");
    useLocalBtn.type = "button";
    useLocalBtn.className = "primary local-frontend-use-local";
    useLocalBtn.textContent = "Use local";
    const useOfficialBtn = document.createElement("button");
    useOfficialBtn.type = "button";
    useOfficialBtn.className = "local-frontend-use-official";
    useOfficialBtn.textContent = "Use official";
    actions.append(useLocalBtn, useOfficialBtn);
    popover.appendChild(actions);

    const updateBtn = document.createElement("button");
    updateBtn.type = "button";
    updateBtn.className = "local-frontend-update";
    updateBtn.textContent = "Install / Update Latest";
    popover.appendChild(updateBtn);

    document.body.appendChild(popover);
    cleanup.push(() => popover.remove());

    function render() {
      const isLocal = new URL(location.href).searchParams.has("use_local_frontend");
      const ready = Boolean(currentStatus && currentStatus.ready);
      const listening = Boolean(ready && currentStatus.server && currentStatus.server.listening);
      const pref = currentStatus && currentStatus.preference;
      btn.dataset.mode = isLocal ? "local" : "official";
      btn.dataset.warning = String(Boolean((isLocal || pref === "local") && !listening));
      modeVal.textContent = isLocal ? "Local" : "Official";
      releaseVal.textContent = (currentStatus && currentStatus.activeRelease) || "Not installed";
      serverVal.textContent = listening
        ? `localhost:${currentStatus.server.port}`
        : currentStatus && currentStatus.server && currentStatus.server.error
          ? "Port unavailable"
          : ready
            ? "Stopped"
            : "No release";
      prefVal.textContent = pref
        ? `${pref === "local" ? "Local" : "Official"} · saved`
        : "Follow URL";

      if (!busy) {
        const warn = !currentStatus
          ? "Cannot reach pcbridge daemon."
          : !ready
            ? "Click Install / Update Latest to download a frontend release."
            : !listening
              ? `Port ${currentStatus.server.port} unavailable: ${currentStatus.server.error || "not listening"}`
              : "";
        noteEl.textContent = warn;
        noteEl.hidden = !warn;
      }

      useLocalBtn.disabled = busy || isLocal || !listening;
      useOfficialBtn.disabled = busy || !isLocal;
      updateBtn.disabled = busy;
    }

    async function refreshStatus() {
      try {
        currentStatus = await plugin.call("status", projectId ? { projectId } : {});
      } catch (error) {
        noteEl.textContent = String((error && error.message) || error);
        noteEl.hidden = false;
      }
      render();
    }

    useLocalBtn.addEventListener("click", async () => {
      busy = true;
      render();
      try {
        await plugin.call("mode", { mode: "local", projectId, navigate: false });
        const next = buildModeUrl(location.href, "local");
        if (next) navigateToUrl(next.url);
      } catch (error) {
        busy = false;
        noteEl.textContent = String((error && error.message) || error);
        noteEl.hidden = false;
        render();
      }
    });

    useOfficialBtn.addEventListener("click", async () => {
      busy = true;
      render();
      try {
        await plugin.call("mode", { mode: "official", projectId, navigate: false }).catch(() => undefined);
        const next = buildModeUrl(location.href, "official");
        if (next) navigateToUrl(next.url);
      } finally {
        busy = false;
        render();
      }
    });

    updateBtn.addEventListener("click", async () => {
      busy = true;
      noteEl.textContent = "Downloading and verifying latest frontend release…";
      noteEl.hidden = false;
      render();
      try {
        const result = await plugin.call("update", {}, 120000);
        busy = false;
        await refreshStatus();
        noteEl.textContent = `Activated ${result.release}.`;
        noteEl.hidden = false;
      } catch (error) {
        busy = false;
        noteEl.textContent = String((error && error.message) || error);
        noteEl.hidden = false;
        render();
      }
    });

    btn.addEventListener("click", () => {
      popover.hidden = !popover.hidden;
      if (!popover.hidden) {
        const rect = typeof btn.getBoundingClientRect === "function"
          ? btn.getBoundingClientRect()
          : { right: 44, top: 80 };
        popover.style.left = `${Math.round(rect.right + 8)}px`;
        popover.style.top = `${Math.max(8, Math.round(rect.top))}px`;
        void refreshStatus();
      }
    });

    const onOutsideMouseDown = (event) => {
      if (popover.hidden) return;
      const targetNode = event && event.target;
      if (targetNode && (popover.contains(targetNode) || btn.contains(targetNode))) return;
      popover.hidden = true;
    };
    if (typeof window.addEventListener === "function") {
      window.addEventListener("mousedown", onOutsideMouseDown);
      cleanup.push(() => window.removeEventListener("mousedown", onOutsideMouseDown));
    }

    render();
  }
}
