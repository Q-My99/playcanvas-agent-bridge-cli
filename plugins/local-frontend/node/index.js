import { createFrontendServer } from "./server.js";
import {
  DEFAULT_FRONTEND_HOST,
  DEFAULT_FRONTEND_PORT,
  FrontendError,
  installFrontend,
  listFrontends,
  readFrontendPreferences,
  removeFrontend,
  resolveFrontendRootDir,
  setFrontendPreference,
  useFrontend,
} from "./store.js";

function inferProjectId(params, target) {
  if (params && (typeof params.projectId === "string" || typeof params.projectId === "number")) {
    const raw = String(params.projectId).trim();
    if (/^\d+$/.test(raw)) return raw;
  }
  if (target && target.projectId && /^\d+$/.test(String(target.projectId))) {
    return String(target.projectId);
  }
  if (target && typeof target.url === "string") {
    const match = target.url.match(/\/editor\/project\/(\d+)(?:\/|[?#]|$)/);
    if (match) return match[1];
  }
  return null;
}

function isOfficialPlayCanvasEditor(target) {
  if (!target || target.kind !== "editor" || typeof target.url !== "string") return false;
  try {
    const url = new URL(target.url);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname === "playcanvas.com" &&
      url.pathname.startsWith("/editor")
    );
  } catch {
    return false;
  }
}

export async function activate(plugin) {
  const rootDir = resolveFrontendRootDir(plugin.dir);
  const hostVersion = typeof plugin.hostVersion === "string" ? plugin.hostVersion : "0.8.0";
  const requestedPort =
    process.env.PCBRIDGE_FRONTEND_PORT !== undefined
      ? Number(process.env.PCBRIDGE_FRONTEND_PORT)
      : DEFAULT_FRONTEND_PORT;

  const server = createFrontendServer({
    host: DEFAULT_FRONTEND_HOST,
    port: Number.isFinite(requestedPort) ? requestedPort : DEFAULT_FRONTEND_PORT,
    rootDir,
    hostVersion,
    log: (message) => plugin.log(message),
  });

  plugin.onDispose(() => server.close());

  await server.listen().catch((error) => {
    plugin.log(`frontend server unavailable: ${String(error)}`);
  });

  async function ensureListening() {
    const current = await server.status();
    if (!current.server.listening) {
      await server.listen().catch(() => undefined);
    }
    return server.status();
  }

  plugin.handle("status", async (params, { target }) => {
    const [current, preferences] = await Promise.all([
      server.status(),
      readFrontendPreferences({ rootDir }),
    ]);
    const projectId = inferProjectId(params, target);
    return {
      ...current,
      preferences,
      projectId,
      preference: projectId ? preferences[projectId] || null : null,
    };
  });

  plugin.handle("list", async () => listFrontends({ rootDir, hostVersion }));

  plugin.handle("install", async (params = {}) => {
    const release = typeof params.release === "string" && params.release.trim()
      ? params.release.trim()
      : "latest";
    const activateRelease = params.activate !== false;
    const installed = await installFrontend(release, {
      rootDir,
      hostVersion,
      activate: activateRelease,
    });
    const current = await ensureListening();
    return {
      release: installed.manifest.release,
      editorVersion: installed.manifest.editorVersion,
      sourceCommit: installed.manifest.sourceCommit,
      path: installed.path,
      alreadyInstalled: installed.alreadyInstalled,
      active: current.activeRelease === installed.manifest.release,
      server: current.server,
    };
  });

  plugin.handle("update", async () => {
    const installed = await installFrontend("latest", {
      rootDir,
      hostVersion,
      activate: true,
    });
    const current = await ensureListening();
    return {
      release: installed.manifest.release,
      editorVersion: installed.manifest.editorVersion,
      sourceCommit: installed.manifest.sourceCommit,
      path: installed.path,
      alreadyInstalled: installed.alreadyInstalled,
      active: current.activeRelease === installed.manifest.release,
      server: current.server,
    };
  });

  plugin.handle("use", async (params = {}) => {
    if (typeof params.release !== "string" || !params.release.trim()) {
      throw new FrontendError("INVALID_REQUEST", "use requires release.");
    }
    await useFrontend(params.release.trim(), { rootDir, hostVersion });
    return ensureListening();
  });

  plugin.handle("remove", async (params = {}) => {
    if (typeof params.release !== "string" || !params.release.trim()) {
      throw new FrontendError("INVALID_REQUEST", "remove requires release.");
    }
    await removeFrontend(params.release.trim(), { rootDir, hostVersion });
    return server.status();
  });

  plugin.handle("mode", async (params = {}, { target }) => {
    const projectId = inferProjectId(params, target);
    if (params.mode === undefined) {
      const preferences = await readFrontendPreferences({ rootDir });
      return {
        projectId,
        mode: projectId ? preferences[projectId] || null : null,
        preferences,
      };
    }

    const rawMode = String(params.mode).trim();
    if ((rawMode === "local" || rawMode === "custom") && !params.force) {
      const current = await ensureListening();
      if (!current.ready) {
        throw new FrontendError(
          "FRONTEND_NOT_INSTALLED",
          "No active local frontend release is installed. Run: pcbridge plugin call local-frontend install",
        );
      }
      if (!current.server.listening) {
        throw new FrontendError(
          "FRONTEND_SERVER_UNAVAILABLE",
          `Local frontend server on port ${current.server.port} is not listening${current.server.error ? `: ${current.server.error}` : "."}`,
        );
      }
    }

    let saved = { projectId, mode: rawMode === "clear" ? null : (rawMode === "custom" ? "local" : rawMode) };
    if (projectId) {
      saved = await setFrontendPreference(projectId, rawMode, { rootDir });
    } else if (rawMode !== "local" && rawMode !== "custom" && rawMode !== "official" && rawMode !== "clear") {
      throw new FrontendError(
        "INVALID_FRONTEND_MODE",
        "mode must be 'local', 'official', or 'clear'.",
      );
    }

    let navigation = { navigated: false, url: null };
    if (
      params.navigate !== false &&
      (saved.mode === "local" || saved.mode === "official") &&
      isOfficialPlayCanvasEditor(target)
    ) {
      const pageResult = await plugin.callPage(target, "navigateMode", { mode: saved.mode });
      if (pageResult && typeof pageResult === "object") {
        navigation = {
          navigated: Boolean(pageResult.redirected),
          url: typeof pageResult.url === "string" ? pageResult.url : null,
        };
      }
    }

    return {
      projectId: saved.projectId,
      mode: saved.mode,
      ...navigation,
    };
  });
}
