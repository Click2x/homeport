import { loadCatalog } from "@homeport/core";
import { describe, expect, it } from "vitest";
import {
  CONFIG_TEMPLATE,
  ConfigError,
  DEFAULT_CONFIG,
  decideVpn,
  evaluateVpn,
  generateCompose,
  type HomeportConfig,
  type Plan,
  parseConfig,
  type VpnFacts,
} from "../src/index.js";

const catalog = loadCatalog();
const WATCH = ["prowlarr", "sonarr", "radarr", "qbittorrent", "jellyfin", "seerr"];
const off: HomeportConfig = { downloads: { allowUnprotected: true } };

describe("decideVpn", () => {
  it("needs nothing when there is no download client", () => {
    expect(decideVpn(catalog, ["jellyfin"], DEFAULT_CONFIG, { configured: false, verified: false })).toEqual({
      vpn: false,
      hold: [],
      unprotected: false,
    });
  });

  it("holds the download client until VPN settings exist", () => {
    const d = decideVpn(catalog, WATCH, DEFAULT_CONFIG, { configured: false, verified: false });
    expect(d).toMatchObject({ vpn: true, hold: ["qbittorrent"], unprotected: false });
    expect(d.message).toMatch(/add your VPN settings/);
  });

  it("holds it again until the VPN has been verified", () => {
    const d = decideVpn(catalog, WATCH, DEFAULT_CONFIG, { configured: true, verified: false });
    expect(d.hold).toEqual(["qbittorrent"]);
    expect(d.message).toMatch(/confirmed that your VPN works/);
  });

  it("lets downloads run only once the VPN is verified", () => {
    expect(decideVpn(catalog, WATCH, DEFAULT_CONFIG, { configured: true, verified: true })).toEqual({
      vpn: true,
      hold: [],
      unprotected: false,
    });
  });

  it("allows running without a VPN only when homeport.toml says so, with a loud warning", () => {
    const d = decideVpn(catalog, WATCH, off, { configured: false, verified: false });
    expect(d).toMatchObject({ vpn: false, hold: [], unprotected: true });
    expect(d.message).toMatch(/WITHOUT a VPN/);
    expect(d.message).toMatch(/homeport\.toml/);
  });
});

describe("homeport.toml", () => {
  it("defaults to requiring a VPN, with an empty file or a missing section", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("[downloads]\n")).toEqual(DEFAULT_CONFIG);
  });

  it("the shipped template keeps the VPN requirement on", () => {
    expect(parseConfig(CONFIG_TEMPLATE)).toEqual(DEFAULT_CONFIG);
  });

  it("reads the override", () => {
    expect(parseConfig("[downloads]\nallow_unprotected = true\n").downloads.allowUnprotected).toBe(true);
  });

  it("refuses a value that is not a real true/false, so a typo cannot silently disable protection", () => {
    expect(() => parseConfig('[downloads]\nallow_unprotected = "yes"\n')).toThrow(ConfigError);
    expect(() => parseConfig("[downloads]\nallow_unprotected = 1\n")).toThrow(/true or false/);
  });

  it("explains a syntax mistake in plain words", () => {
    expect(() => parseConfig("[downloads\nallow_unprotected = true")).toThrow(/homeport\.toml has a mistake/);
  });
});

describe("holding an app back", () => {
  const plan: Plan = {
    project: "homeport",
    apps: WATCH,
    vpn: true,
    hold: ["qbittorrent"],
    timezone: "UTC",
    puid: 1000,
    pgid: 1000,
    data: { mode: "volume" },
  };

  it("deploys the gateway so it can be verified, but not the download client", () => {
    const c = generateCompose(catalog, plan);
    expect(c.services.gluetun).toBeDefined();
    expect(c.services.qbittorrent).toBeUndefined();
    expect(c.services.sonarr).toBeDefined();
  });

  it("leaves the gateway out too when it is held (no VPN settings yet)", () => {
    const c = generateCompose(catalog, { ...plan, hold: ["qbittorrent", "gluetun"] });
    expect(c.services.gluetun).toBeUndefined();
    expect(c.services.qbittorrent).toBeUndefined();
    expect(c.services.sonarr).toBeDefined();
  });

  it("keeps the gateway's published ports and firewall opening stable while the client is held", () => {
    const held = generateCompose(catalog, plan).services.gluetun;
    const running = generateCompose(catalog, { ...plan, hold: [] }).services.gluetun;
    expect(held?.ports).toEqual(running?.ports);
    expect(held?.environment?.FIREWALL_INPUT_PORTS).toBe(running?.environment?.FIREWALL_INPUT_PORTS);
  });

  it("starts the client behind the gateway once released", () => {
    const c = generateCompose(catalog, { ...plan, hold: [] });
    expect(c.services.qbittorrent?.network_mode).toBe("service:gluetun");
  });
});

describe("evaluateVpn", () => {
  const good: VpnFacts = {
    gateway: { running: true, health: "healthy", dropsByDefault: true, exitIp: "203.0.113.9" },
    client: { sharesGatewayNetwork: true },
    homeIp: "198.51.100.7",
  };

  it("passes when connected, kill switch on, exit address differs and the client is behind it", () => {
    const r = evaluateVpn(good);
    expect(r.safe).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual(["tunnel", "kill-switch", "exit-address", "client"]);
    expect(r.exitIp).toBe("203.0.113.9");
  });

  it("fails when traffic would leave from the home address", () => {
    const r = evaluateVpn({ ...good, gateway: { ...good.gateway, exitIp: "198.51.100.7" } });
    expect(r.safe).toBe(false);
    expect(r.checks.find((c) => c.id === "exit-address")?.summary).toMatch(/home address/);
  });

  it("fails closed when the tunnel is down: not safe, and says why", () => {
    const r = evaluateVpn({
      ...good,
      gateway: { running: true, health: "unhealthy", dropsByDefault: true, exitIp: null },
    });
    expect(r.safe).toBe(false);
    expect(r.checks.find((c) => c.id === "tunnel")?.summary).toMatch(/not connected/);
    expect(r.checks.find((c) => c.id === "kill-switch")?.status).toBe("pass");
  });

  it("fails when the firewall default cannot be confirmed", () => {
    expect(evaluateVpn({ ...good, gateway: { ...good.gateway, dropsByDefault: null } }).safe).toBe(false);
    expect(evaluateVpn({ ...good, gateway: { ...good.gateway, dropsByDefault: false } }).safe).toBe(false);
  });

  it("fails when the download client is not behind the gateway", () => {
    const r = evaluateVpn({ ...good, client: { sharesGatewayNetwork: false } });
    expect(r.safe).toBe(false);
    expect(r.checks.find((c) => c.id === "client")?.summary).toMatch(/not behind the VPN/);
  });

  it("can verify the gateway alone, before the client exists", () => {
    const { client: _client, ...gatewayOnly } = good;
    const r = evaluateVpn(gatewayOnly);
    expect(r.safe).toBe(true);
    expect(r.checks.some((c) => c.id === "client")).toBe(false);
  });

  it("fails if the gateway is missing", () => {
    const r = evaluateVpn({
      gateway: { running: false, health: "missing", dropsByDefault: null, exitIp: null },
      homeIp: "198.51.100.7",
    });
    expect(r.safe).toBe(false);
    expect(r.checks.find((c) => c.id === "tunnel")?.summary).toMatch(/not running/);
  });

  it("never claims safety when it could not learn the home address", () => {
    expect(evaluateVpn({ ...good, homeIp: null }).safe).toBe(false);
  });
});
