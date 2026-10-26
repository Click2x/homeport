import { type WireContext, wait } from "./context.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type JsonClient = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

/** A small JSON client for one app. Errors say which call failed and what the app answered. */
export function jsonClient(
  ctx: WireContext,
  base: string,
  headers: Record<string, string> = {},
  label = base,
): JsonClient {
  const f = ctx.fetch ?? fetch;
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await f(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok)
      throw new HttpError(
        res.status,
        `${label}: ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : null) as T;
  };
}

/** Retry until a call succeeds, for apps that are still starting. */
export async function waitUntil(
  ctx: WireContext,
  name: string,
  probe: () => Promise<unknown>,
  { tries = 90, delayMs = 2000 } = {},
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await probe();
      return;
    } catch {
      await wait(ctx, delayMs);
    }
  }
  throw new Error(`${name} did not become ready in time`);
}

/** An *arr "fields" array: set the named values, leave every default alone. */
export interface SchemaField {
  name: string;
  value?: unknown;
}
export function fillFields<T extends { fields: SchemaField[] }>(
  schema: T,
  values: Record<string, unknown>,
): T {
  const out = structuredClone(schema);
  for (const f of out.fields) if (f.name in values) f.value = values[f.name];
  return out;
}
