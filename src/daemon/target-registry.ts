import type { TargetInfo } from "../shared/protocol.js";
import type { WebSocket } from "ws";

export type TargetConnection = {
  info: TargetInfo;
  ws: WebSocket;
};

export type ResolveResult =
  | { ok: true; target: TargetConnection }
  | { ok: false; code: string; message: string; candidates?: TargetInfo[] };

export type UpsertResult = {
  info: TargetInfo;
  connected: boolean;
  changed: boolean;
};

export class TargetRegistry {
  #targets = new Map<string, TargetConnection>();
  #clientToTarget = new Map<string, string>();

  upsert(info: Partial<TargetInfo> & { clientId: string }, ws: WebSocket): UpsertResult {
    const targetId = info.tabId !== undefined ? `tab:${info.tabId}` : `client:${info.clientId}`;
    const now = new Date().toISOString();
    const existing = this.#targets.get(targetId)?.info;
    const kind = info.kind || existing?.kind || "unknown";
    const launchValue = <T>(value: T | undefined, previous: T | undefined): T | undefined =>
      kind === "launch" ? value ?? previous : undefined;
    const next: TargetInfo = {
      id: targetId,
      clientId: info.clientId,
      tabId: info.tabId,
      windowId: info.windowId,
      kind,
      url: info.url || existing?.url || "",
      title: info.title || existing?.title,
      projectId: info.projectId || existing?.projectId,
      projectName: info.projectName || existing?.projectName,
      sceneId: info.sceneId || existing?.sceneId,
      sceneName: info.sceneName || existing?.sceneName,
      branchId: info.branchId || existing?.branchId,
      branchName: info.branchName || existing?.branchName,
      extensionVersion: info.extensionVersion || existing?.extensionVersion,
      hasEditor: info.hasEditor ?? existing?.hasEditor,
      hasPc: info.hasPc ?? existing?.hasPc,
      hasRuntimeApp: info.hasRuntimeApp ?? existing?.hasRuntimeApp,
      runtimeAppSource: launchValue(info.runtimeAppSource, existing?.runtimeAppSource),
      runtimeAppAmbiguous: launchValue(info.runtimeAppAmbiguous, existing?.runtimeAppAmbiguous),
      runtimeAppCandidateSources: launchValue(
        info.runtimeAppCandidateSources,
        existing?.runtimeAppCandidateSources,
      ),
      runtimeCanvasId: launchValue(info.runtimeCanvasId, existing?.runtimeCanvasId),
      engineVersion: launchValue(info.engineVersion, existing?.engineVersion),
      readinessMode: launchValue(info.readinessMode, existing?.readinessMode),
      pageReady: launchValue(info.pageReady, existing?.pageReady),
      visibilityState: launchValue(info.visibilityState, existing?.visibilityState),
      lifecycleReady: launchValue(info.lifecycleReady, existing?.lifecycleReady),
      runtimeCreated: launchValue(info.runtimeCreated, existing?.runtimeCreated),
      graphicsReady: launchValue(info.graphicsReady, existing?.graphicsReady),
      graphicsContextLost: launchValue(info.graphicsContextLost, existing?.graphicsContextLost),
      runtimeStarted: launchValue(info.runtimeStarted, existing?.runtimeStarted),
      runtimeFrame: launchValue(info.runtimeFrame, existing?.runtimeFrame),
      sceneLoaded: launchValue(info.sceneLoaded, existing?.sceneLoaded),
      scriptsReady: launchValue(info.scriptsReady, existing?.scriptsReady),
      scriptTypeCount: launchValue(info.scriptTypeCount, existing?.scriptTypeCount),
      splashVisible: launchValue(info.splashVisible, existing?.splashVisible),
      rootChildCount: launchValue(info.rootChildCount, existing?.rootChildCount),
      readinessBlockers: launchValue(info.readinessBlockers, existing?.readinessBlockers),
      canvasCount: info.canvasCount ?? existing?.canvasCount,
      ready: Boolean(info.ready),
      connected: true,
      lastSeen: now,
    };

    this.#targets.set(targetId, { info: next, ws });
    this.#clientToTarget.set(info.clientId, targetId);
    const comparable = (target: TargetInfo | undefined) => target ? {
      ...target,
      lastSeen: undefined,
      connected: undefined,
    } : null;
    return {
      info: next,
      connected: !existing?.connected,
      changed: JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(next)),
    };
  }

  markDisconnected(ws: WebSocket): TargetInfo[] {
    const disconnected: TargetInfo[] = [];
    for (const [id, connection] of this.#targets.entries()) {
      if (connection.ws === ws && connection.info.connected) {
        connection.info.connected = false;
        connection.info.ready = false;
        connection.info.lastSeen = new Date().toISOString();
        this.#targets.set(id, connection);
        disconnected.push(connection.info);
      }
    }
    return disconnected;
  }

  getByTabId(tabId: number): TargetInfo | undefined {
    return this.#targets.get(`tab:${tabId}`)?.info;
  }

  list(): TargetInfo[] {
    return Array.from(this.#targets.values())
      .map((entry) => entry.info)
      .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen));
  }

  resolve(selector = "current"): ResolveResult {
    const targets = Array.from(this.#targets.values()).filter(
      (target) => target.info.connected,
    );
    const readyTargets = targets.filter((target) => target.info.ready);

    if (selector === "current") {
      const target = readyTargets.sort((left, right) =>
        right.info.lastSeen.localeCompare(left.info.lastSeen),
      )[0];
      if (!target) {
        return {
          ok: false,
          code: "NO_READY_TARGET",
          message: "No ready PlayCanvas target is connected.",
          candidates: this.list(),
        };
      }
      return { ok: true, target };
    }

    if (selector.startsWith("client:")) {
      const id = this.#clientToTarget.get(selector.slice("client:".length));
      const target = id ? this.#targets.get(id) : undefined;
      if (target?.info.connected) return { ok: true, target };
      return {
        ok: false,
        code: "TARGET_NOT_FOUND",
        message: `No connected target matches ${selector}.`,
        candidates: this.list(),
      };
    }

    if (selector.startsWith("tab:")) {
      const target = this.#targets.get(selector);
      if (target?.info.connected) return { ok: true, target };
      return {
        ok: false,
        code: "TARGET_NOT_FOUND",
        message: `No connected target matches ${selector}.`,
        candidates: this.list(),
      };
    }

    const [kind, value] = selector.split(":", 2);
    if ((kind === "scene" || kind === "project") && value) {
      const matches = targets.filter((target) =>
        kind === "scene"
          ? target.info.sceneId === value
          : target.info.projectId === value,
      );

      if (matches.length === 1) return { ok: true, target: matches[0] };
      if (matches.length > 1) {
        return {
          ok: false,
          code: "AMBIGUOUS_TARGET",
          message: `${selector} matches multiple connected targets.`,
          candidates: matches.map((target) => target.info),
        };
      }
    }

    if ((kind === "editor" || kind === "launch") && value) {
      const matches = targets.filter(
        (target) => target.info.kind === kind && target.info.sceneId === value,
      );

      if (matches.length === 1) return { ok: true, target: matches[0] };
      if (matches.length > 1) {
        return {
          ok: false,
          code: "AMBIGUOUS_TARGET",
          message: `${selector} matches multiple connected targets.`,
          candidates: matches.map((target) => target.info),
        };
      }
    }

    return {
      ok: false,
      code: "TARGET_NOT_FOUND",
      message: `No connected target matches ${selector}.`,
      candidates: this.list(),
    };
  }
}
