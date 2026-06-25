export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type BridgeError = {
  code: string;
  message: string;
  details?: JsonValue;
};

export type Envelope<T = JsonValue> =
  | {
      ok: true;
      data: T;
      meta?: Record<string, JsonValue>;
    }
  | {
      ok: false;
      error: BridgeError;
      meta?: Record<string, JsonValue>;
    };

export type TargetInfo = {
  id: string;
  clientId: string;
  tabId?: number;
  windowId?: number;
  url: string;
  title?: string;
  projectId?: string;
  sceneId?: string;
  branchId?: string;
  extensionVersion?: string;
  ready: boolean;
  connected: boolean;
  lastSeen: string;
};

export type RpcRequest = {
  target?: string;
  method: string;
  params?: Record<string, JsonValue>;
  timeoutMs?: number;
};

export type ExtensionRequest = {
  id: string;
  type: "request";
  method: string;
  params?: Record<string, JsonValue>;
  timeoutMs: number;
};

export type ExtensionResponse = {
  id: string;
  type: "response";
  ok: boolean;
  data?: JsonValue;
  error?: BridgeError | JsonValue;
  meta?: Record<string, JsonValue>;
};

export function ok<T extends JsonValue>(
  data: T,
  meta?: Record<string, JsonValue>,
): Envelope<T> {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}

export function fail(
  code: string,
  message: string,
  meta?: Record<string, JsonValue>,
  details?: JsonValue,
): Envelope<never> {
  const error: BridgeError = details
    ? { code, message, details }
    : { code, message };
  return meta ? { ok: false, error, meta } : { ok: false, error };
}

export function normalizeError(value: unknown): BridgeError {
  if (value && typeof value === "object") {
    const candidate = value as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
    if (typeof candidate.message === "string") {
      return { code: "PAGE_ERROR", message: candidate.message };
    }
  }

  return { code: "PAGE_ERROR", message: String(value) };
}
