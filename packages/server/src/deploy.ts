import { join } from "node:path";
import type { WireContext, WireOptions } from "@homeport/connectors";
import type { Catalog } from "@homeport/core";
import {
  type CheckOptions,
  type ComposeProject,
  composeToYaml,
  type DataLocation,
  decideVpn,
  expandPlan,
  generateCompose,
  type HomeportConfig,
  hostPort,
  keyVar,
  type Plan,
  type StorageReport,
  serviceHost,
  type VpnReport,
  type WgPeerStatus,
} from "@homeport/engine";
import type { JobReporter } from "./jobs.js";
import { allocatePorts } from "./ports.js";
import { buildFiles, loadRemoteSettings } from "./remote.js";
import { appsForGoals, buildPlan, loadSettings, SETTINGS_KEY, UserError } from "./settings.js";
import type { Store } from "./store.js";
import { setVpnVerified, vpnConfigured, vpnEnv, vpnVerified } from "./vpn-settings.js";

/** Everything deploy needs from the outside world. Real versions live in ops.ts; tests pass fakes. */
export interface DeployOps {
  checkDocker(): Promise<string | null>;
  takenPorts(project: string): Promise<Set<number>>;
  writeProject(p: ComposeProject, composeYaml: string, dotEnv: string): Promise<void>;
  pull(p: ComposeProject): Promise<unknown>;
  up(p: ComposeProject): Promise<unknown>;
  prepareStorage(location: DataLocation, owner: CheckOptions): Promise<void>;
  checkStorage(location: DataLocation, owner: CheckOptions): Promise<StorageReport>;
  /** Make Homeport's own container reachable from the stack's network, so it can talk to the apps by name. */
  joinNetwork(project: string): Promise<void>;
  qbitFirstRunPassword(project: string): Promise<string | undefined>;
  runRecyclarr(project: string, config: string): Promise<void>;
  checkVpn(project: string): Promise<VpnReport>;
  wireApps(ctx: WireContext, selected: string[]): Promise<void>;
  syncProfiles(ctx: WireContext, selected: string[], options: WireOptions): Promise<void>;
  wireRequests(ctx: WireContext, selected: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Is a program outside Docker already using this port on the host? */
  portInUse(port: number): Promise<boolean>;
  /** Build the remote-access sidecar image if it is missing or out of date. */
  ensureWireguardImage(): Promise<unknown>;
  applyWireguard(project: string, conf: string, rules: string): Promise<void>;
  wireguardStatus(project: string): Promise<WgPeerStatus[]>;
  /** The public address of this connection, for "what do I tell people to connect to". */
  publicIp(): Promise<string | null>;
}

export interface DeployDeps {
  store: Store;
  catalog: Catalog;
  ops: DeployOps;
  dataDir: string;
  loadConfig(): HomeportConfig;
}

export interface DeployResult {
  /** appId -> port name -> the port on this machine. */
  ports: Record<string, Record<string, number>>;
  /** Apps deliberately not started (for example the download client until the VPN is verified). */
  held: string[];
  warnings: string[];
  storage: { tier: StorageReport["tier"]; copyMode: boolean };
}

export const DEPLOYED_KEY = "stack.deployed";

const VPN_ATTEMPTS = 12;
const VPN_DELAY_MS = 5000;

const projectOf = (dataDir: string, project: string): ComposeProject => ({
  dir: join(dataDir, "stack"),
  project,
});

/** The .env that Compose reads: generated API keys plus the VPN settings. Written with owner-only access. */
function buildDotEnv(deps: DeployDeps, plan: Plan): string {
  const lines: string[] = [];
  for (const app of expandPlan(deps.catalog, plan)) {
    if (app.apiKeyEnv) lines.push(`${keyVar(app)}='${deps.store.ensureSecret(`app.${app.id}.key`)}'`);
  }
  for (const [k, v] of Object.entries(vpnEnv(deps.store, deps.catalog))) lines.push(`${k}='${v}'`);
  return `${lines.join("\n")}\n`;
}

export function buildWireContext(deps: DeployDeps, plan: Plan, firstRunPassword?: string): WireContext {
  const internal = (id: string) => {
    const app = deps.catalog.apps.get(id);
    if (!app) throw new Error(`unknown app ${id}`);
    return { host: serviceHost(plan, app), port: app.ports[0]?.container ?? 0 };
  };
  const keys: Record<string, string> = {};
  for (const id of ["prowlarr", "sonarr", "radarr"]) {
    const v = deps.store.getSecret(`app.${id}.key`);
    if (v) keys[id] = v;
  }
  return {
    url: (id) => `http://${internal(id).host}:${internal(id).port}`,
    internal,
    keys,
    qbittorrent: { password: deps.store.ensureSecret("qbittorrent.password"), firstRunPassword },
    jellyfin: { adminUser: "homeport", adminPassword: deps.store.ensureSecret("jellyfin.password") },
    log: () => {},
  };
}

/** Deploy or update the stack: start the containers, check storage and the VPN, then wire everything together. */
export async function deploy(
  deps: DeployDeps,
  report: JobReporter,
): Promise<{ summary: string; result: DeployResult }> {
  const { store, catalog, ops } = deps;
  const warnings: string[] = [];
  const warn = (step: string, message: string) => {
    warnings.push(message);
    report.warn(step, message);
  };

  report.start("docker", "Checking that Docker is ready");
  const problem = await ops.checkDocker();
  if (problem) throw new UserError(problem);
  report.done("docker", "Docker is ready");

  const settings = loadSettings(store);
  if (!settings.goals.length) throw new UserError("Choose what you want to do first, then deploy.");
  const apps = appsForGoals(catalog, settings.goals);
  // Remote access adds its own small gateway to the stack.
  const remote = loadRemoteSettings(store);
  const stackApps = remote.enabled ? [...apps, "wireguard"] : apps;

  // ---- the VPN rule ----
  const config = deps.loadConfig();
  const decision = decideVpn(catalog, apps, config, {
    configured: vpnConfigured(store),
    verified: vpnVerified(store),
  });
  if (decision.message) warn("vpn", decision.message);

  // ---- ports ----
  report.start("plan", "Choosing ports and preparing the plan");
  const hostPorts = await allocatePorts(
    catalog,
    stackApps,
    await ops.takenPorts(settings.project),
    settings.hostPorts,
    ops.portInUse,
  );
  store.setJson(SETTINGS_KEY, { ...settings, hostPorts });
  // Without VPN settings the gateway has nothing to connect to, so it stays off too.
  const initialHold = decision.vpn && !vpnConfigured(store) ? [...decision.hold, "gluetun"] : decision.hold;
  let plan = buildPlan(settings, stackApps, { vpn: decision.vpn, hold: initialHold, hostPorts });
  const project = projectOf(deps.dataDir, settings.project);
  const location: DataLocation =
    settings.data.mode === "bind" ? settings.data : { mode: "volume", project: settings.project };
  const owner = { puid: settings.puid, pgid: settings.pgid };
  const apply = async (p: Plan) => {
    await ops.writeProject(project, composeToYaml(generateCompose(catalog, p)), buildDotEnv(deps, p));
    await ops.up(project);
  };
  report.done("plan", `${apps.length} services planned`);

  // ---- start ----
  if (remote.enabled) {
    report.start("remote", "Preparing remote access");
    await ops.ensureWireguardImage();
    report.done("remote", "Remote access is ready to start");
  }
  report.start("pull", "Downloading the apps (the first time takes a few minutes)");
  await ops.writeProject(project, composeToYaml(generateCompose(catalog, plan)), buildDotEnv(deps, plan));
  await ops.pull(project);
  report.done("pull", "Downloads finished");
  report.start("start", "Starting the apps");
  await ops.up(project);
  report.done("start", "Apps started");

  // ---- storage ----
  report.start("storage", "Checking where your library will live");
  const storage = await ops.checkStorage(location, owner);
  const failed = storage.results.filter((r) => r.status === "fail");
  if (storage.tier === "blocked")
    throw new UserError(`Your storage location is not ready: ${failed.map((r) => r.summary).join(" ")}`);
  for (const r of storage.results.filter((x) => x.status === "warn")) warn("storage", r.summary);
  if (storage.copyMode)
    warn(
      "storage",
      "This location cannot link files, so finished downloads will be copied (using more space).",
    );
  report.done("storage", `Storage is ${storage.tier}`);

  // ---- the network, so Homeport can reach the apps by name ----
  report.start("network", "Connecting Homeport to the apps");
  await ops.joinNetwork(settings.project);
  report.done("network", "Connected");

  // ---- the VPN gate ----
  let held = [...decision.hold];
  if (decision.vpn && !vpnConfigured(store)) {
    report.info(
      "vpn",
      "No VPN is set up yet, so downloads stay off. Add your VPN settings and deploy again.",
    );
  } else if (decision.vpn) {
    report.start("vpn", "Checking your VPN");
    const verify = async (): Promise<VpnReport> => {
      let last = await ops.checkVpn(settings.project);
      for (let i = 1; i < VPN_ATTEMPTS && !last.safe; i++) {
        await ops.sleep(VPN_DELAY_MS);
        last = await ops.checkVpn(settings.project);
      }
      return last;
    };
    if (held.length && vpnConfigured(store)) {
      const gateway = await verify();
      if (gateway.safe) {
        report.info(
          "vpn",
          `The VPN is connected (exit address ${gateway.exitIp}). Starting the download client.`,
        );
        plan = { ...plan, hold: [] };
        await apply(plan);
        const full = await verify();
        if (full.safe) {
          setVpnVerified(store, true);
          held = [];
          report.done("vpn", "Your VPN is working and the download client is behind it");
        } else {
          setVpnVerified(store, false);
          plan = { ...plan, hold: decision.hold };
          await apply(plan);
          warn(
            "vpn",
            `The download client was stopped again: ${full.checks
              .filter((c) => c.status === "fail")
              .map((c) => c.summary)
              .join(" ")}`,
          );
        }
      } else {
        setVpnVerified(store, false);
        warn(
          "vpn",
          `The VPN is not working yet, so downloads stay off: ${gateway.checks
            .filter((c) => c.status === "fail")
            .map((c) => c.summary)
            .join(" ")}`,
        );
      }
    } else if (!held.length) {
      // Already verified earlier: re-check that it still holds before trusting it.
      const again = await verify();
      if (again.safe) report.done("vpn", "Your VPN is still working");
      else {
        setVpnVerified(store, false);
        held = decision.hold.length ? decision.hold : ["qbittorrent"];
        plan = { ...plan, hold: held };
        await apply(plan);
        warn(
          "vpn",
          `Downloads were stopped because the VPN check failed: ${again.checks
            .filter((c) => c.status === "fail")
            .map((c) => c.summary)
            .join(" ")}`,
        );
      }
    }
  }

  // ---- remote access: give the gateway its people and rules ----
  if (remote.enabled) {
    report.start("remote", "Opening remote access for the people you invited");
    const files = buildFiles(store, catalog, plan, settings);
    await ops.applyWireguard(settings.project, files.conf, files.rules);
    report.done("remote", `Remote access is on (port ${files.port})`);
  }

  // ---- wiring ----
  const running = expandPlan(catalog, plan).map((a) => a.id);
  const firstRun = running.includes("qbittorrent")
    ? await ops.qbitFirstRunPassword(settings.project)
    : undefined;
  const ctx = buildWireContext(deps, plan, firstRun);
  ctx.log = (m) => report.info("wire", m);
  report.start("wire", "Linking the apps to each other");
  await ops.wireApps(ctx, running);
  report.done("wire", "Apps linked");
  report.start("profiles", "Setting up quality profiles");
  await ops.syncProfiles(ctx, running, {
    runRecyclarr: (config) => ops.runRecyclarr(settings.project, config),
  });
  report.done("profiles", "Quality profiles ready");
  report.start("requests", "Connecting the request page");
  await ops.wireRequests(ctx, running);
  report.done("requests", "Request page ready");

  const ports: DeployResult["ports"] = {};
  for (const app of expandPlan(catalog, plan)) {
    if (app.id === "gluetun") continue;
    for (const p of app.ports) ports[app.id] = { ...ports[app.id], [p.name]: hostPort(plan, app, p.name) };
  }
  // Held apps are not running, but the gateway still publishes their port.
  const result: DeployResult = {
    ports,
    held,
    warnings,
    storage: { tier: storage.tier, copyMode: storage.copyMode },
  };
  store.setJson(DEPLOYED_KEY, { at: new Date().toISOString(), result });
  const summary = held.length
    ? "Everything is set up except downloads, which are on hold until your VPN works."
    : "Everything is set up.";
  return { summary, result };
}
