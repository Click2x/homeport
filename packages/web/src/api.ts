import type {
  AuditEntry,
  Credentials,
  Goal,
  JobEvent,
  JobRow,
  PlanView,
  Settings,
  StackView,
  Status,
  StorageReport,
  SystemView,
  VpnReport,
  VpnView,
} from "./types";

/** An error with a message that is already safe and plain enough to show to a person. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        // Required on every change: it proves the request came from this page, not from another site.
        ...(method !== "GET" ? { "X-Homeport": "1" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Homeport could not be reached. Is it still running?", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Something went wrong (${res.status}).`;
    // A sign-in that fails is a normal answer, not an expired session.
    if (res.status === 401 && path !== "/login") onUnauthorized();
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const api = {
  status: () => request<Status>("GET", "/status"),
  setup: (token: string, username: string, password: string) =>
    request<{ ok: true }>("POST", "/setup", { token, username, password }),
  login: (username: string, password: string) =>
    request<{ ok: true }>("POST", "/login", { username, password }),
  logout: () => request<{ ok: true }>("POST", "/logout"),
  changePassword: (current: string, next: string) =>
    request<{ ok: true }>("POST", "/password", { current, next }),
  system: () => request<SystemView>("GET", "/system"),
  catalog: () => request<{ goals: Goal[] }>("GET", "/catalog"),
  settings: () => request<Settings>("GET", "/settings"),
  saveSettings: (changes: Partial<Settings>) => request<Settings>("PUT", "/settings", changes),
  plan: () => request<PlanView>("GET", "/plan"),
  vpn: () => request<VpnView>("GET", "/vpn"),
  saveVpn: (values: Record<string, string>) => request<VpnView>("PUT", "/vpn", { values }),
  clearVpn: () => request<VpnView>("DELETE", "/vpn"),
  checkVpn: () => request<VpnReport>("POST", "/vpn/check"),
  config: () =>
    request<{ file: string; allowUnprotected: boolean; problem: string | null; note: string }>(
      "GET",
      "/config",
    ),
  checkStorage: () => request<StorageReport>("POST", "/storage/check"),
  fixStorage: (action: string) => request<{ ok: true }>("POST", "/storage/fix", { action }),
  deploy: () => request<{ jobId: string }>("POST", "/deploy"),
  latestJob: () => request<{ job: JobRow | null; running: string | null }>("GET", "/jobs/latest"),
  job: (id: string) => request<{ job: JobRow; events: JobEvent[] }>("GET", `/jobs/${id}`),
  stack: () => request<StackView>("GET", "/stack"),
  credentials: () => request<Credentials>("GET", "/credentials"),
  audit: () => request<{ entries: AuditEntry[] }>("GET", "/audit"),
  composeText: async () => {
    const res = await fetch("/api/compose", { credentials: "same-origin" });
    if (!res.ok) throw new ApiError("Choose what you want to do first.", res.status);
    return res.text();
  },
};

/**
 * Follow a job's progress. The browser reconnects by itself and resumes where it left off, so a
 * dropped connection or a page reload does not lose anything. Returns a function that stops listening.
 */
export function watchJob(
  id: string,
  onEvent: (e: JobEvent) => void,
  onEnd: (result: { status: string; summary: string | null }) => void,
): () => void {
  const source = new EventSource(`/api/jobs/${id}/events`);
  source.addEventListener("progress", (m) => onEvent(JSON.parse((m as MessageEvent).data) as JobEvent));
  source.addEventListener("end", (m) => {
    source.close();
    onEnd(JSON.parse((m as MessageEvent).data));
  });
  return () => source.close();
}
