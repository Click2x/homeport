import type { Catalog } from "@homeport/core";
import { resolveApps } from "@homeport/core";
import type { HomeportConfig } from "./config.js";
import { containerName, docker } from "./docker.js";
import { GATEWAY_ID } from "./plan.js";

// ---- the policy: when may the download client start? -------------------------------------------

export interface VpnDecision {
  /** Route apps that need a VPN through the gateway. */
  vpn: boolean;
  /** Apps to hold back right now. */
  hold: string[];
  /** The person turned the VPN requirement off in homeport.toml. */
  unprotected: boolean;
  /** Plain language, shown to the user. */
  message?: string;
}

export interface VpnState {
  /** Provider settings have been entered. */
  configured: boolean;
  /** The last full check passed. */
  verified: boolean;
}

/** Apps in the selection that must run behind a VPN. */
export function appsNeedingVpn(catalog: Catalog, selected: string[]): string[] {
  return resolveApps(catalog, selected)
    .filter((a) => a.vpn === "required")
    .map((a) => a.id);
}

export function decideVpn(
  catalog: Catalog,
  selected: string[],
  config: HomeportConfig,
  state: VpnState,
): VpnDecision {
  const needs = appsNeedingVpn(catalog, selected);
  if (needs.length === 0) return { vpn: false, hold: [], unprotected: false };
  if (config.downloads.allowUnprotected)
    return {
      vpn: false,
      hold: [],
      unprotected: true,
      message:
        "Downloads will run WITHOUT a VPN because homeport.toml says so (downloads.allow_unprotected = true). Your home IP address will be visible to everyone you share files with.",
    };
  if (!state.configured)
    return {
      vpn: true,
      hold: needs,
      unprotected: false,
      message: "Downloads are on hold until you add your VPN settings. They never start without one.",
    };
  if (!state.verified)
    return {
      vpn: true,
      hold: needs,
      unprotected: false,
      message: "Downloads are on hold until Homeport has confirmed that your VPN works.",
    };
  return { vpn: true, hold: [], unprotected: false };
}

// ---- the check ---------------------------------------------------------------------------------

export interface VpnFacts {
  gateway: {
    running: boolean;
    health: "healthy" | "unhealthy" | "starting" | "none" | "missing";
    /** The firewall drops everything that is not explicitly allowed (the kill switch). */
    dropsByDefault: boolean | null;
    /** The public address seen from inside the gateway's network, or null if it has no route out. */
    exitIp: string | null;
  };
  /** Present only when the download client is running. */
  client?: { sharesGatewayNetwork: boolean };
  /** The public address of the machine Homeport runs on, with no VPN. */
  homeIp: string | null;
}

export type VpnCheckId = "tunnel" | "kill-switch" | "exit-address" | "client";

export interface VpnCheck {
  id: VpnCheckId;
  title: string;
  status: "pass" | "fail";
  summary: string;
}

export interface VpnReport {
  /** True only when every check passed, so it is safe to let downloads run. */
  safe: boolean;
  checks: VpnCheck[];
  exitIp: string | null;
}

export function evaluateVpn(facts: VpnFacts): VpnReport {
  const checks: VpnCheck[] = [];
  const add = (id: VpnCheckId, title: string, ok: boolean, pass: string, fail: string) =>
    checks.push({ id, title, status: ok ? "pass" : "fail", summary: ok ? pass : fail });

  const g = facts.gateway;
  const up = g.running && g.health === "healthy";
  add(
    "tunnel",
    "VPN connection",
    up,
    "The VPN is connected.",
    g.running
      ? "The VPN is not connected. Check your provider settings, then try again."
      : "The VPN gateway is not running.",
  );

  add(
    "kill-switch",
    "Kill switch",
    g.dropsByDefault === true,
    "If the VPN drops, all traffic from the download client stops instead of leaking.",
    "The firewall could not be confirmed. Downloads could leak if the VPN drops.",
  );

  const differs = Boolean(g.exitIp && facts.homeIp && g.exitIp !== facts.homeIp);
  add(
    "exit-address",
    "Downloads leave through the VPN",
    differs,
    `Traffic leaves from ${g.exitIp}, not from your home address.`,
    !up
      ? "This cannot be confirmed until the VPN is connected."
      : g.exitIp && g.exitIp === facts.homeIp
        ? "Traffic leaves from your home address, so the VPN is not protecting it."
        : "Could not work out which address traffic leaves from. Check that the internet is reachable.",
  );

  if (facts.client)
    add(
      "client",
      "Download client is behind the VPN",
      facts.client.sharesGatewayNetwork,
      "The download client can only use the VPN's connection.",
      "The download client is not behind the VPN.",
    );

  return { safe: checks.every((c) => c.status === "pass"), checks, exitIp: g.exitIp };
}

// ---- the Docker side ---------------------------------------------------------------------------

export interface VpnNames {
  gateway?: string;
  client?: string;
}

export interface CollectOptions {
  names?: VpnNames;
  /** Where to ask "what is my public address?". The only outside call this check makes. */
  ipCheckUrl?: string;
}

const IP = /^[0-9a-f.:]+$/i;

async function inspect(format: string, name: string): Promise<string | null> {
  try {
    return (await docker(["inspect", "-f", format, name])).trim();
  } catch {
    return null;
  }
}

async function publicIpFrom(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = (await res.text()).trim();
    return IP.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Gather the facts. Read-only: it starts a short-lived helper inside the gateway's network to ask for its address. */
export async function collectVpnFacts(project: string, options: CollectOptions = {}): Promise<VpnFacts> {
  const gatewayName = options.names?.gateway ?? containerName(project, GATEWAY_ID);
  const clientName = options.names?.client ?? containerName(project, "qbittorrent");
  const ipUrl = options.ipCheckUrl ?? "https://api.ipify.org";

  const state = await inspect(
    "{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.Id}}",
    gatewayName,
  );
  const homeIp = await publicIpFrom(ipUrl);
  if (!state)
    return { gateway: { running: false, health: "missing", dropsByDefault: null, exitIp: null }, homeIp };

  const [running, health, gatewayId] = state.split("|");
  const isRunning = running === "true";
  let dropsByDefault: boolean | null = null;
  let exitIp: string | null = null;
  if (isRunning) {
    dropsByDefault = await docker(["exec", gatewayName, "iptables", "-S", "OUTPUT"]).then(
      (out) => /-P OUTPUT DROP/.test(out),
      () => null,
    );
    // Ask from inside the gateway's own network using a tiny helper container, so we depend on no tool in the gateway.
    exitIp = await docker([
      "run",
      "--rm",
      "--network",
      `container:${gatewayName}`,
      "curlimages/curl",
      "-s",
      "--max-time",
      "8",
      ipUrl,
    ]).then(
      (out) => (IP.test(out.trim()) ? out.trim() : null),
      () => null,
    );
  }

  const facts: VpnFacts = {
    gateway: {
      running: isRunning,
      health: (health as VpnFacts["gateway"]["health"]) ?? "none",
      dropsByDefault,
      exitIp,
    },
    homeIp,
  };
  const clientMode = await inspect("{{.HostConfig.NetworkMode}}", clientName);
  if (clientMode !== null && gatewayId)
    facts.client = { sharesGatewayNetwork: clientMode === `container:${gatewayId}` };
  return facts;
}

export async function checkVpn(project: string, options: CollectOptions = {}): Promise<VpnReport> {
  return evaluateVpn(await collectVpnFacts(project, options));
}

export interface TunnelBreakResult {
  interface: string;
  /** Traffic got out while the tunnel was down. Must be false. */
  leaked: boolean;
  /** The VPN came back by itself afterwards. */
  recovered: boolean;
}

/**
 * Active test: take the tunnel interface down for a moment and prove nothing leaks. This briefly
 * interrupts downloads, so only run it when the user asks. Needs a connected VPN.
 */
export async function breakTunnelTest(
  project: string,
  options: CollectOptions & { recoverSeconds?: number } = {},
): Promise<TunnelBreakResult> {
  const gateway = options.names?.gateway ?? containerName(project, GATEWAY_ID);
  const ipUrl = options.ipCheckUrl ?? "https://api.ipify.org";
  const iface = (
    await docker(["exec", gateway, "sh", "-c", "ip -o link | grep -oE 'tun[0-9]+|wg[0-9]+' | head -1"])
  ).trim();
  if (!iface) throw new Error("Could not find the VPN interface inside the gateway.");
  const exitIp = () =>
    docker([
      "run",
      "--rm",
      "--network",
      `container:${gateway}`,
      "curlimages/curl",
      "-s",
      "--max-time",
      "8",
      ipUrl,
    ]).then(
      (o) => (IP.test(o.trim()) ? o.trim() : null),
      () => null,
    );
  await docker(["exec", gateway, "ip", "link", "set", iface, "down"]);
  let leaked: boolean;
  try {
    leaked = (await exitIp()) !== null;
  } finally {
    await docker(["exec", gateway, "ip", "link", "set", iface, "up"]).catch(() => undefined);
  }
  // Bringing the interface back does not restore routes; the gateway heals itself within a minute or so.
  let recovered = false;
  for (let i = 0; i < (options.recoverSeconds ?? 120) / 5 && !recovered; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    recovered =
      (await inspect("{{.State.Health.Status}}", gateway)) === "healthy" && (await exitIp()) !== null;
  }
  return { interface: iface, leaked, recovered };
}
