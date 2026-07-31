import { createReadStream } from "node:fs";
import http from "node:http";
import { realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import {
  CONFIG_DIR,
  DEFAULT_FRONTEND_PORT,
  DEFAULT_HOST,
} from "../config.js";
import { getFrontendStatus, type FrontendStatus } from "./store.js";

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export type FrontendServerRuntime = {
  host: string;
  port: number;
  listening: boolean;
  error: string | null;
};

export type FrontendServerStatus = FrontendStatus & {
  server: FrontendServerRuntime;
};

export type FrontendServer = {
  listen: () => Promise<void>;
  close: () => Promise<void>;
  status: () => Promise<FrontendServerStatus>;
};

type FrontendServerOptions = {
  host?: string;
  port?: number;
  rootDir?: string;
  log?: (message: string) => void;
};

function writeHeaders(
  res: http.ServerResponse,
  statusCode: number,
  headers: Record<string, string | number> = {},
): void {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Cache-Control": "no-cache, must-revalidate",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  headOnly = false,
): void {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  writeHeaders(res, statusCode, {
    "Content-Length": payload.length,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(headOnly ? undefined : payload);
}

function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function resolveStaticFile(root: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) return null;
  const rootPath = await realpath(root);
  const candidate = resolve(rootPath, `.${decoded}`);
  const relation = relative(rootPath, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`)) return null;

  const filePath = await realpath(candidate).catch(() => null);
  if (!filePath) return null;
  const realRelation = relative(rootPath, filePath);
  if (realRelation === ".." || realRelation.startsWith(`..${sep}`)) return null;

  const info = await stat(filePath).catch(() => null);
  return info?.isFile() ? filePath : null;
}

export function createFrontendServer(
  options: FrontendServerOptions = {},
): FrontendServer {
  const host = options.host || DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_FRONTEND_PORT;
  const rootDir = options.rootDir || CONFIG_DIR;
  const log = options.log || (() => undefined);
  let actualPort = requestedPort;
  let listening = false;
  let runtimeError: string | null = null;

  const runtime = (): FrontendServerRuntime => ({
    host,
    port: actualPort,
    listening,
    error: runtimeError,
  });

  const status = async (): Promise<FrontendServerStatus> => ({
    ...(await getFrontendStatus({ rootDir })),
    server: runtime(),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const headOnly = req.method === "HEAD";
      if (!hostAllowed(req.headers.host)) {
        writeJson(res, 403, { ready: false, error: "Invalid Host header." }, headOnly);
        return;
      }

      if (req.method === "OPTIONS") {
        writeHeaders(res, 204);
        res.end();
        return;
      }
      if (req.method !== "GET" && !headOnly) {
        writeJson(res, 405, { ready: false, error: "Method not allowed." });
        return;
      }

      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (url.pathname === "/__pcbridge_frontend__/health") {
        const current = await status();
        writeJson(res, current.ready ? 200 : 503, current, headOnly);
        return;
      }

      const current = await getFrontendStatus({ rootDir });
      if (!current.activePath) {
        writeJson(
          res,
          503,
          {
            ready: false,
            error: "No active PlayCanvas Editor frontend is installed.",
          },
          headOnly,
        );
        return;
      }

      const filePath = await resolveStaticFile(current.activePath, url.pathname);
      if (!filePath) {
        writeJson(res, 404, { ready: false, error: "Frontend asset not found." }, headOnly);
        return;
      }

      const info = await stat(filePath);
      writeHeaders(res, 200, {
        "Content-Length": info.size,
        "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
      });
      if (headOnly) {
        res.end();
        return;
      }
      createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      writeJson(res, 500, { ready: false, error: String(error) });
    }
  });

  return {
    status,
    listen: () =>
      new Promise((resolveListen, reject) => {
        const onError = (error: Error) => {
          runtimeError = error.message;
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (address && typeof address !== "string") actualPort = address.port;
          listening = true;
          runtimeError = null;
          log(`frontend server listening on http://${host}:${actualPort}`);
          resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(requestedPort, host);
      }),
    close: () =>
      new Promise((resolveClose, reject) => {
        if (!server.listening) {
          listening = false;
          resolveClose();
          return;
        }
        server.close((error) => {
          listening = false;
          if (error) {
            reject(error);
          } else {
            resolveClose();
          }
        });
      }),
  };
}
