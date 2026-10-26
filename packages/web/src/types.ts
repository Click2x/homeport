// Shapes of what the Homeport API returns. Kept by hand, small, and checked by the end-to-end test.

export interface Status {
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
}

export interface CatalogApp {
  id: string;
  name: string;
  purpose: string;
  needsVpn: boolean;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  apps: CatalogApp[];
}

export type DataLocation = { mode: "volume" } | { mode: "bind"; source: string };

export interface Settings {
  goals: string[];
  project: string;
  hostPorts: Record<string, Record<string, number>>;
  data: DataLocation;
  timezone: string;
  puid: number;
  pgid: number;
  apps: string[];
}

export interface VpnDecision {
  vpn: boolean;
  hold: string[];
  unprotected: boolean;
  message?: string;
}
export interface PlanView {
  services: { id: string; name: string; purpose: string }[];
  vpn: VpnDecision;
  ramMB: number;
}

export interface VpnView {
  configured: boolean;
  verified: boolean;
  provider: string | null;
  type: string | null;
  filled: string[];
  needed: boolean;
  unprotected: boolean;
  downloadsOnHold: boolean;
  message: string | null;
  configProblem: string | null;
}

export interface VpnReport {
  safe: boolean;
  exitIp: string | null;
  checks: { id: string; title: string; status: "pass" | "fail"; summary: string }[];
}

export type Fix =
  | { kind: "auto"; action: string; label: string }
  | { kind: "guided"; label: string; steps: string[] };
export interface StorageResult {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  fix?: Fix;
}
export type Tier = "best" | "good" | "compatible" | "blocked";
export interface StorageReport {
  tier: Tier;
  results: StorageResult[];
  copyMode: boolean;
  measured: { fsType: string; freeBytes: number; writeMBps: number | null };
}

export interface JobEvent {
  seq: number;
  at: string;
  step: string;
  status: "running" | "done" | "warn" | "error" | "info";
  message: string;
}
export interface JobRow {
  id: string;
  kind: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
}

export interface DeployResult {
  ports: Record<string, Record<string, number>>;
  held: string[];
  warnings: string[];
  storage: { tier: Tier; copyMode: boolean };
}
export interface StackView {
  deployed: { at: string; result: DeployResult } | null;
  containers: { service: string; state: string; health: string }[];
}

export interface Credentials {
  jellyfin: { user: string; password: string | null };
  qbittorrent: { user: string; password: string | null };
  note: string;
}

export interface SystemView {
  docker: {
    ok: boolean;
    problem?: string;
    version?: string | null;
    desktop?: boolean;
    memoryGB?: number | null;
    cpus?: number | null;
  };
  version?: string;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: string;
}
