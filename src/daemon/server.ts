import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { DEFAULT_HOST, DEFAULT_PORT, VERSION } from "../config.js";
import { TargetRegistry } from "./target-registry.js";
import {
  fail,
  normalizeError,
  ok,
  type Envelope,
  type ExtensionRequest,
  type ExtensionResponse,
  type JsonValue,
  type RpcRequest,
  type TargetInfo,
} from "../shared/protocol.js";

type DaemonOptions = {
  host?: string;
  port?: number;
  token: string;
  log?: (message: string) => void;
};

type PendingRequest = {
  resolve: (value: Envelope) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
  targetId: string;
};

type IncomingWsMessage =
  | {
      type: "target:update";
      target?: Partial<TargetInfo> & { clientId: string };
    }
  | ExtensionResponse;

export type DaemonServer = {
  host: string;
  port: number;
  registry: TargetRegistry;
  close: () => Promise<void>;
  listen: () => Promise<void>;
};

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  body: Envelope | Record<string, unknown>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function createDaemonServer(options: DaemonOptions): DaemonServer {
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port || DEFAULT_PORT);
  const registry = new TargetRegistry();
  const pending = new Map<string, PendingRequest>();
  const log = options.log || (() => undefined);

  function requireToken(req: http.IncomingMessage): boolean {
    return req.headers["x-pcbridge-token"] === options.token;
  }

  async function sendToTarget(request: RpcRequest): Promise<Envelope> {
    if (!request.method) {
      return fail("INVALID_REQUEST", "RPC method is required.");
    }

    const resolved = registry.resolve(request.target || "current");
    if (!resolved.ok) {
      return fail(
        resolved.code,
        resolved.message,
        undefined,
        (resolved.candidates || []) as unknown as JsonValue,
      );
    }

    const timeoutMs = Math.min(Math.max(Number(request.timeoutMs || 15000), 1000), 120000);
    const id = `req_${randomUUID()}`;
    const message: ExtensionRequest = {
      id,
      type: "request",
      method: request.method,
      params: request.params,
      timeoutMs,
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(
          fail("REQUEST_TIMEOUT", `Timed out after ${timeoutMs}ms.`, {
            target: resolved.target.info.id,
          }),
        );
      }, timeoutMs + 250);

      pending.set(id, {
        resolve,
        timer,
        startedAt: Date.now(),
        targetId: resolved.target.info.id,
      });

      resolved.target.ws.send(JSON.stringify(message), (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          resolve(
            fail("WEBSOCKET_SEND_FAILED", error.message, {
              target: resolved.target.info.id,
            }),
          );
        }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

      if (url.pathname === "/health" && req.method === "GET") {
        if (!requireToken(req)) {
          writeJson(res, 403, fail("BAD_TOKEN", "Invalid pcbridge token."));
          return;
        }
        writeJson(
          res,
          200,
          ok({
            version: VERSION,
            host,
            port,
            targetCount: registry.list().filter((target) => target.connected).length,
          }),
        );
        return;
      }

      if (url.pathname === "/targets" && req.method === "GET") {
        if (!requireToken(req)) {
          writeJson(res, 403, fail("BAD_TOKEN", "Invalid pcbridge token."));
          return;
        }
        writeJson(res, 200, ok(registry.list() as unknown as JsonValue));
        return;
      }

      if (url.pathname === "/rpc" && req.method === "POST") {
        if (!requireToken(req)) {
          writeJson(res, 403, fail("BAD_TOKEN", "Invalid pcbridge token."));
          return;
        }
        const body = await readBody(req);
        if (!isJsonObject(body)) {
          writeJson(res, 400, fail("INVALID_REQUEST", "JSON body is required."));
          return;
        }
        const response = await sendToTarget(body as RpcRequest);
        writeJson(res, response.ok ? 200 : 400, response);
        return;
      }

      writeJson(res, 404, fail("NOT_FOUND", `Unknown endpoint ${url.pathname}.`));
    } catch (error) {
      writeJson(res, 500, fail("DAEMON_ERROR", String(error)));
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname !== "/extension" || url.searchParams.get("token") !== options.token) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    log("extension connected");

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as IncomingWsMessage;

        if (message.type === "target:update" && message.target?.clientId) {
          const info = registry.upsert(message.target, ws);
          log(`target ${info.id} kind=${info.kind || "unknown"} ready=${info.ready} url=${info.url}`);
          return;
        }

        if (message.type === "response" && message.id) {
          const waiter = pending.get(message.id);
          if (!waiter) return;

          pending.delete(message.id);
          clearTimeout(waiter.timer);
          const durationMs = Date.now() - waiter.startedAt;

          if (message.ok) {
            waiter.resolve(
              ok((message.data ?? null) as JsonValue, {
                ...(message.meta || {}),
                target: waiter.targetId,
                durationMs,
              }),
            );
          } else {
            const error = normalizeError(message.error);
            waiter.resolve(
              fail(error.code, error.message, {
                ...(message.meta || {}),
                target: waiter.targetId,
                durationMs,
              }),
            );
          }
        }
      } catch (error) {
        log(`bad websocket message: ${String(error)}`);
      }
    });

    ws.on("close", () => {
      registry.markDisconnected(ws);
      log("extension disconnected");
    });
  });

  return {
    host,
    port,
    registry,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}
