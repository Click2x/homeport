import { describe, expect, it } from "vitest";
import { loadCatalog, ManifestError, parseManifest, resolveApps } from "../src/index.js";

describe("catalog", () => {
  const catalog = loadCatalog();

  it("loads every bundled manifest and goal", () => {
    expect([...catalog.apps.keys()].sort()).toEqual(
      ["gluetun", "jellyfin", "prowlarr", "qbittorrent", "radarr", "seerr", "sonarr", "wireguard"].sort(),
    );
    expect(catalog.goals.map((g) => g.id)).toContain("watch");
  });

  it("never mounts an app's own settings from a host folder (config is always a named volume)", () => {
    for (const app of catalog.apps.values())
      for (const v of app.volumes) expect(["config", "data"]).toContain(v.kind);
  });

  it("requires a VPN for the download client", () => {
    expect(catalog.apps.get("qbittorrent")?.vpn).toBe("required");
  });

  it("puts dependencies before the apps that need them", () => {
    const order = resolveApps(catalog, ["seerr"]).map((a) => a.id);
    expect(order.indexOf("jellyfin")).toBeLessThan(order.indexOf("seerr"));
    expect(order.indexOf("sonarr")).toBeLessThan(order.indexOf("seerr"));
  });
});

describe("parseManifest", () => {
  const valid = {
    id: "demo",
    name: "Demo",
    purpose: "A demo.",
    category: "home",
    image: "example/demo",
    tag: "1.0",
    ports: [{ name: "web", container: 8080 }],
    volumes: [{ kind: "config", container: "/config" }],
  };

  it("accepts a valid manifest", () => {
    expect(parseManifest(valid).id).toBe("demo");
  });

  it("rejects a bad id, with a readable message", () => {
    expect(() => parseManifest({ ...valid, id: "Not Valid" }, "demo.yaml")).toThrow(ManifestError);
    expect(() => parseManifest({ ...valid, id: "Not Valid" }, "demo.yaml")).toThrow(/demo\.yaml: \/id/);
  });

  it("rejects an unknown volume kind", () => {
    expect(() => parseManifest({ ...valid, volumes: [{ kind: "host", container: "/x" }] })).toThrow(
      ManifestError,
    );
  });
});
