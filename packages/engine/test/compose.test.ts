import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "@homeport/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { composeToYaml, generateCompose, type Plan, serviceHost } from "../src/index.js";

const catalog = loadCatalog();
const base: Plan = {
  project: "homeport",
  apps: ["prowlarr", "sonarr", "radarr", "qbittorrent", "jellyfin", "seerr"],
  vpn: false,
  timezone: "UTC",
  puid: 1000,
  pgid: 1000,
  data: { mode: "volume" },
};

describe("generateCompose without a VPN", () => {
  const compose = generateCompose(catalog, base);

  it("creates every selected service", () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      "jellyfin",
      "prowlarr",
      "qbittorrent",
      "radarr",
      "seerr",
      "sonarr",
    ]);
    expect(compose.services.gluetun).toBeUndefined();
  });

  it("publishes each app on its standard port by default", () => {
    expect(compose.services.sonarr?.ports).toEqual(["8989:8989"]);
    expect(compose.services.qbittorrent?.ports).toEqual(["8080:8080"]);
  });

  it("honours host port overrides", () => {
    const c = generateCompose(catalog, { ...base, hostPorts: { sonarr: { web: 18989 } } });
    expect(c.services.sonarr?.ports).toEqual(["18989:8989"]);
  });

  it("injects API keys as variable references, never literal secrets", () => {
    expect(compose.services.sonarr?.environment?.SONARR__AUTH__APIKEY).toBe("${SONARR_KEY}");
    expect(composeToYaml(compose)).not.toMatch(/[0-9a-f]{32}/);
  });

  it("keeps app settings in named volumes and shares one data volume", () => {
    expect(compose.services.sonarr?.volumes).toEqual(["sonarr-config:/config", "data:/data"]);
    expect(Object.keys(compose.volumes)).toContain("data");
    expect(Object.keys(compose.volumes)).toContain("sonarr-config");
  });

  it("passes user and timezone settings to linuxserver images only", () => {
    expect(compose.services.sonarr?.environment).toMatchObject({ PUID: "1000", PGID: "1000", TZ: "UTC" });
    expect(compose.services.seerr?.environment).toBeUndefined();
  });
});

describe("generateCompose with a VPN", () => {
  const plan: Plan = { ...base, vpn: true, hostPorts: { qbittorrent: { web: 18080 } } };
  const compose = generateCompose(catalog, plan);

  it("adds the gateway and puts the download client on its network with no route of its own", () => {
    expect(compose.services.gluetun).toBeDefined();
    const q = compose.services.qbittorrent;
    expect(q?.network_mode).toBe("service:gluetun");
    expect(q?.depends_on).toEqual(["gluetun"]);
    expect(q?.ports).toBeUndefined();
  });

  it("publishes the download client's web page on the gateway and opens only that port", () => {
    const g = compose.services.gluetun;
    expect(g?.ports).toEqual(["18080:8080"]);
    expect(g?.environment?.FIREWALL_INPUT_PORTS).toBe("8080");
    expect(g?.cap_add).toEqual(["NET_ADMIN"]);
  });

  it("forwards VPN settings from .env without embedding them", () => {
    expect(compose.services.gluetun?.environment?.WIREGUARD_PRIVATE_KEY).toBe("${WIREGUARD_PRIVATE_KEY:-}");
  });

  it("tells other apps to reach the download client through the gateway", () => {
    expect(serviceHost(plan, catalog.apps.get("qbittorrent") as never)).toBe("gluetun");
    expect(serviceHost(plan, catalog.apps.get("sonarr") as never)).toBe("sonarr");
  });

  it("never adds the gateway when nothing needs it", () => {
    const c = generateCompose(catalog, { ...plan, apps: ["sonarr", "radarr"] });
    expect(c.services.gluetun).toBeUndefined();
  });
});

describe("storage mode", () => {
  it("can bind the data root to a folder", () => {
    const c = generateCompose(catalog, { ...base, data: { mode: "bind", source: "D:/Media" } });
    expect(c.services.sonarr?.volumes).toContain("D:/Media:/data");
    expect(Object.keys(c.volumes)).not.toContain("data");
  });
});

describe("compatibility with the proven spike", () => {
  // The spike's compose file is the known-good reference. The generated one must match in substance.
  const spikePath = fileURLToPath(new URL("../../../spike/compose.yaml", import.meta.url));
  const spike = parse(readFileSync(spikePath, "utf8").replace("${HP_PROJECT:-homeport-spike}", "x"));
  const compose = generateCompose(catalog, base);

  it("runs the same set of services", () => {
    expect(Object.keys(compose.services).sort()).toEqual(Object.keys(spike.services).sort());
  });

  it("uses the same images", () => {
    for (const [id, s] of Object.entries(spike.services) as [string, { image: string }][])
      expect(compose.services[id]?.image).toBe(s.image);
  });

  it("exposes the same container ports and mounts the same container paths", () => {
    for (const [id, s] of Object.entries(spike.services) as [
      string,
      { ports: string[]; volumes: string[] },
    ][]) {
      const containerPort = (p: string) => p.split(":").pop();
      expect(compose.services[id]?.ports?.map(containerPort)).toEqual(s.ports.map(containerPort));
      const target = (v: string) => v.split(":")[1];
      expect(compose.services[id]?.volumes?.map(target)).toEqual(s.volumes.map(target));
    }
  });
});
