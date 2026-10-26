import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "@homeport/core";
import type { StorageReport, VpnReport, WgPeerStatus } from "@homeport/engine";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { DeployOps } from "../src/deploy.js";
import { Store } from "../src/store.js";

export const SETUP_CODE = "TEST-CODE-1234";
export const PASSWORD = "correct horse battery";

export const goodStorage: StorageReport = {
  tier: "good",
  copyMode: false,
  results: [],
  measured: { fsType: "ext4", freeBytes: 500 * 1024 ** 3, writeMBps: 400 },
};

export const safeVpn: VpnReport = {
  safe: true,
  exitIp: "203.0.113.9",
  checks: [{ id: "tunnel", title: "VPN connection", status: "pass", summary: "The VPN is connected." }],
};
export const unsafeVpn: VpnReport = {
  safe: false,
  exitIp: null,
  checks: [{ id: "tunnel", title: "VPN connection", status: "fail", summary: "The VPN is not connected." }],
};

/** A fake of everything that touches Docker or the apps. Records what happened, in order. */
export function fakeOps(overrides: Partial<DeployOps> = {}) {
  const calls: string[] = [];
  const wired: { selected: string[] }[] = [];
  const wgApplied: { conf: string; rules: string }[] = [];
  const wgStatus: WgPeerStatus[] = [];
  const ops: DeployOps = {
    checkDocker: async () => null,
    takenPorts: async () => new Set(),
    writeProject: async (_p, yaml) =>
      void calls.push(
        `write:${yaml.includes("gluetun") ? "vpn" : "plain"}${yaml.includes("qbittorrent:") ? "+client" : ""}`,
      ),
    pull: async () => void calls.push("pull"),
    up: async () => void calls.push("up"),
    prepareStorage: async () => void calls.push("prepare"),
    checkStorage: async () => goodStorage,
    joinNetwork: async () => void calls.push("join"),
    qbitFirstRunPassword: async () => "temp",
    runRecyclarr: async () => void calls.push("recyclarr"),
    checkVpn: async () => safeVpn,
    wireApps: async (_c, selected) => void wired.push({ selected }),
    syncProfiles: async (_c, _s, o) => void (await o.runRecyclarr?.("cfg")),
    wireRequests: async () => void calls.push("requests"),
    sleep: async () => {},
    portInUse: async () => false,
    ensureWireguardImage: async () => void calls.push("wg-image"),
    applyWireguard: async (_p, conf, rules) => void wgApplied.push({ conf, rules }),
    wireguardStatus: async () => wgStatus,
    publicIp: async () => "203.0.113.9",
    ...overrides,
  };
  return { ops, calls, wired, wgApplied, wgStatus };
}

export async function makeApp(opts: { ops?: DeployOps; toml?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "homeport-test-"));
  if (opts.toml !== undefined) writeFileSync(join(dataDir, "homeport.toml"), opts.toml);
  const store = Store.memory();
  const app: FastifyInstance = await buildApp({
    store,
    catalog: loadCatalog(),
    ops: opts.ops ?? fakeOps().ops,
    dataDir,
    version: "test",
    setupToken: SETUP_CODE,
  });
  const H = { "x-homeport": "1" };

  const cookieFrom = (res: { cookies: { name: string; value: string }[] }) => {
    const c = res.cookies.find((x) => x.name === "hp_session");
    return c ? `hp_session=${c.value}` : "";
  };
  const signUp = async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: H,
      payload: { token: SETUP_CODE, username: "admin", password: PASSWORD },
    });
    return cookieFrom(res);
  };
  /** Request helper that sends the session cookie and the required header. */
  const as = (cookie: string) => ({
    get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
    post: (url: string, payload?: unknown) =>
      app.inject({ method: "POST", url, headers: { ...H, cookie }, payload: payload as never }),
    put: (url: string, payload?: unknown) =>
      app.inject({ method: "PUT", url, headers: { ...H, cookie }, payload: payload as never }),
    del: (url: string) => app.inject({ method: "DELETE", url, headers: { ...H, cookie } }),
  });
  /** Wait for the deploy job to finish and return its final row. */
  const finish = async (cookie: string, jobId: string) => {
    for (let i = 0; i < 200; i++) {
      const r = (await as(cookie).get(`/api/jobs/${jobId}`)).json() as {
        job: { status: string; summary: string };
        events: { step: string; status: string; message: string }[];
      };
      if (r.job.status !== "running") return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("job did not finish");
  };
  return { app, store, dataDir, H, signUp, as, finish };
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;
