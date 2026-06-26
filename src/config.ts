import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.2.3";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 17329;
export const CONFIG_DIR = join(homedir(), ".pcbridge");
export const SESSION_FILE = join(CONFIG_DIR, "session.json");
export const EXTENSION_INSTALL_DIR = join(CONFIG_DIR, "extension");

export type SessionConfig = {
  token: string;
  port: number;
  createdAt: string;
};

export async function readOrCreateSession(): Promise<SessionConfig> {
  await mkdir(CONFIG_DIR, { recursive: true });

  try {
    const parsed = JSON.parse(await readFile(SESSION_FILE, "utf8")) as SessionConfig;
    if (typeof parsed.token === "string" && parsed.token.length >= 24) {
      return {
        token: parsed.token,
        port: Number(parsed.port || DEFAULT_PORT),
        createdAt: parsed.createdAt || new Date().toISOString(),
      };
    }
  } catch {
    // Create a new local token below.
  }

  const session: SessionConfig = {
    token: randomBytes(32).toString("hex"),
    port: DEFAULT_PORT,
    createdAt: new Date().toISOString(),
  };

  await writeFile(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
  return session;
}

export async function readSessionIfExists(): Promise<SessionConfig | null> {
  try {
    const parsed = JSON.parse(await readFile(SESSION_FILE, "utf8")) as SessionConfig;
    if (typeof parsed.token === "string") {
      return {
        token: parsed.token,
        port: Number(parsed.port || DEFAULT_PORT),
        createdAt: parsed.createdAt || "",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function writeSession(session: SessionConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function findPackageRoot(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, ".."),
    resolve(here, "..", ".."),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, "package.json")) &&
      existsSync(join(candidate, "extension"))
    ) {
      return candidate;
    }
  }

  throw new Error("Cannot locate package root with bundled extension directory.");
}

export async function copyDir(
  source: string,
  destination: string,
  options: { clean?: boolean; ignore?: Set<string> } = {},
): Promise<void> {
  if (options.clean) {
    await rm(destination, { force: true, recursive: true });
  }
  await mkdir(destination, { recursive: true });

  const entries = await readdir(source);
  for (const entry of entries) {
    if (options.ignore?.has(entry)) continue;

    const from = join(source, entry);
    const to = join(destination, entry);
    const info = await stat(from);

    if (info.isDirectory()) {
      await copyDir(from, to, { ignore: options.ignore });
    } else if (info.isFile()) {
      await copyFile(from, to);
    }
  }
}
