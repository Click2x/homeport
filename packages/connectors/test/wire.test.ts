import { describe, expect, it } from "vitest";
import { recyclarrConfig, wireApps, wireQbittorrent, wireStack } from "../src/index.js";
import { fakeStack } from "./fakes.js";

const ALL = ["prowlarr", "sonarr", "radarr", "qbittorrent", "jellyfin", "seerr"];
const CHANGES = /added|linked|finished|enabled|connected|marked|now reached/i;

describe("wireStack on a fresh install", () => {
  it("wires every app together", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    const ctx = stack.context();
    const recyclarr: string[] = [];
    await wireStack(ctx, ALL, { runRecyclarr: async (c) => void recyclarr.push(c) });

    const s = stack.state;
    expect(s.qbit.password).toBe("homeport-qbit-password");
    expect(s.qbit.savePath).toBe("/data/torrents");
    expect(s.arrState.sonarr.roots).toEqual([{ path: "/data/media/tv" }]);
    expect(s.arrState.radarr.roots).toEqual([{ path: "/data/media/movies" }]);
    expect(s.arrState.sonarr.clients).toHaveLength(1);
    expect(s.arrState.radarr.clients).toHaveLength(1);
    expect(s.prowlarr.apps.map((a) => a.name).sort()).toEqual(["Radarr", "Sonarr"]);
    expect(s.jellyfin.wizardDone).toBe(true);
    expect(s.jellyfin.libraries.map((l) => l.Name).sort()).toEqual(["Movies", "TV Shows"]);
    expect(s.seerr.libs.every((l) => l.enabled)).toBe(true);
    expect(s.seerr.radarr).toHaveLength(1);
    expect(s.seerr.sonarr).toHaveLength(1);
    expect(s.seerr.initialized).toBe(true);
    expect(recyclarr).toHaveLength(1);
  });

  it("points the download client at qBittorrent with the right category and password", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireStack(stack.context(), ALL);
    const client = stack.state.arrState.sonarr.clients[0] as { fields: { name: string; value: unknown }[] };
    const field = (n: string) => client.fields.find((f) => f.name === n)?.value;
    expect(field("host")).toBe("qbittorrent");
    expect(field("port")).toBe(8080);
    expect(field("tvCategory")).toBe("tv");
    expect(field("password")).toBe("homeport-qbit-password");
  });

  it("uses the quality profile Recyclarr created for Seerr", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireStack(stack.context(), ALL);
    expect(stack.state.seerr.sonarr[0]).toMatchObject({ activeProfileName: "WEB-1080p", activeProfileId: 2 });
    expect(stack.state.seerr.radarr[0]).toMatchObject({ activeProfileName: "HD Bluray + WEB" });
  });
});

describe("idempotency", () => {
  it("changes nothing the second time", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireStack(stack.context(), ALL);
    // loginBodies is a record of calls, not stack state, and grows by design.
    const snapshot = () =>
      JSON.stringify({ ...stack.state, seerr: { ...stack.state.seerr, loginBodies: [] } });
    const before = snapshot();
    stack.logs.length = 0;

    await wireStack(stack.context(), ALL);
    expect(stack.logs.filter((l) => CHANGES.test(l))).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it("does not run Jellyfin's wizard twice", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireStack(stack.context(), ALL);
    await wireStack(stack.context(), ALL);
    expect(stack.state.jellyfin.wizardRuns).toBe(1);
  });

  it("signs in to an already-configured Seerr without sending connection details", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireStack(stack.context(), ALL);
    await wireStack(stack.context(), ALL);
    const [first, second] = stack.state.seerr.loginBodies;
    expect(first).toHaveProperty("hostname", "jellyfin");
    expect(second).not.toHaveProperty("hostname");
  });
});

describe("VPN routing", () => {
  it("reaches qBittorrent through the gateway when the VPN is on", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireStack(stack.context({ vpn: true }), ALL);
    const client = stack.state.arrState.radarr.clients[0] as { fields: { name: string; value: unknown }[] };
    expect(client.fields.find((f) => f.name === "host")?.value).toBe("gluetun");
  });

  it("moves an existing download client when the VPN is turned on later", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireStack(stack.context({ vpn: false }), ALL);
    stack.logs.length = 0;
    await wireStack(stack.context({ vpn: true }), ALL);
    const client = stack.state.arrState.sonarr.clients[0] as { fields: { name: string; value: unknown }[] };
    expect(client.fields.find((f) => f.name === "host")?.value).toBe("gluetun");
    expect(stack.logs.some((l) => /now reached through gluetun/.test(l))).toBe(true);
  });
});

describe("qBittorrent safety", () => {
  it("never retries failed logins (it bans repeat offenders)", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    const ctx = stack.context({ firstRunPassword: "wrong" });
    await expect(wireQbittorrent(ctx)).rejects.toThrow(/Could not sign in/);
    expect(stack.state.qbit.failedLogins).toBe(2);
  });

  it("works on a re-run with only Homeport's own password", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireQbittorrent(stack.context());
    // The first run makes exactly one failed attempt: Homeport's own password, before the one-time one.
    expect(stack.state.qbit.failedLogins).toBe(1);

    const again = stack.context();
    again.qbittorrent.firstRunPassword = undefined;
    await wireQbittorrent(again);
    expect(stack.state.qbit.failedLogins).toBe(1);
  });
});

describe("partial installs", () => {
  it("wires only what is installed", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireStack(stack.context(), ["sonarr", "radarr", "qbittorrent"]);
    expect(stack.state.arrState.sonarr.clients).toHaveLength(1);
    expect(stack.state.jellyfin.wizardDone).toBe(false);
    expect(stack.requests.some((r) => r.includes("prowlarr"))).toBe(false);
    expect(stack.requests.some((r) => r.includes("seerr"))).toBe(false);
  });
});

describe("a held-back download client", () => {
  it("is not wired into Sonarr or Radarr until it is actually running", async () => {
    const stack = fakeStack();
    await wireApps(stack.context(), ["prowlarr", "sonarr", "radarr", "jellyfin"]);
    expect(stack.state.arrState.sonarr.clients).toHaveLength(0);
    expect(stack.state.arrState.radarr.clients).toHaveLength(0);
    expect(stack.state.arrState.sonarr.roots).toHaveLength(1); // library folders are still set up
    expect(stack.requests.some((r) => r.includes("qbittorrent") || r.includes("gluetun"))).toBe(false);
  });

  it("is added once it starts", async () => {
    const stack = fakeStack({ qbitFirstRunPassword: "temp-pass" });
    await wireApps(stack.context(), ["prowlarr", "sonarr", "radarr"]);
    await wireApps(stack.context(), ["prowlarr", "sonarr", "radarr", "qbittorrent"]);
    expect(stack.state.arrState.sonarr.clients).toHaveLength(1);
  });
});

describe("recyclarrConfig", () => {
  it("lists each installed manager with its key, address and TRaSH profile", () => {
    const ctx = fakeStack().context();
    const config = recyclarrConfig(ctx, ["sonarr", "radarr"]);
    expect(config).toContain("base_url: http://sonarr:8989");
    expect(config).toContain("api_key: key-radarr");
    expect(config).toContain("trash_id: 72dae194fc92bf828f32cde7744e51a1");
    expect(config).toContain("trash_id: d1d67249d3890e49bc12e275d989a7e9");
  });
});
