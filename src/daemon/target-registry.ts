import type { TargetInfo } from "../shared/protocol.js";
import type { WebSocket } from "ws";

export type TargetConnection = {
  info: TargetInfo;
  ws: WebSocket;
};

export type ResolveResult =
  | { ok: true; target: TargetConnection }
  | { ok: false; code: string; message: string; candidates?: TargetInfo[] };

export class TargetRegistry {
  #targets = new Map<string, TargetConnection>();
  #clientToTarget = new Map<string, string>();

  upsert(info: Partial<TargetInfo> & { clientId: string }, ws: WebSocket): TargetInfo {
    const targetId = info.tabId !== undefined ? `tab:${info.tabId}` : `client:${info.clientId}`;
    const now = new Date().toISOString();
    const existing = this.#targets.get(targetId)?.info;
    const next: TargetInfo = {
      id: targetId,
      clientId: info.clientId,
      tabId: info.tabId,
      windowId: info.windowId,
      url: info.url || existing?.url || "",
      title: info.title || existing?.title,
      projectId: info.projectId || existing?.projectId,
      sceneId: info.sceneId || existing?.sceneId,
      branchId: info.branchId || existing?.branchId,
      ready: Boolean(info.ready),
      connected: true,
      lastSeen: now,
    };

    this.#targets.set(targetId, { info: next, ws });
    this.#clientToTarget.set(info.clientId, targetId);
    return next;
  }

  markDisconnected(ws: WebSocket): void {
    for (const [id, connection] of this.#targets.entries()) {
      if (connection.ws === ws) {
        connection.info.connected = false;
        connection.info.ready = false;
        connection.info.lastSeen = new Date().toISOString();
        this.#targets.set(id, connection);
      }
    }
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
          message: "No ready PlayCanvas Editor target is connected.",
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

    return {
      ok: false,
      code: "TARGET_NOT_FOUND",
      message: `No connected target matches ${selector}.`,
      candidates: this.list(),
    };
  }
}
