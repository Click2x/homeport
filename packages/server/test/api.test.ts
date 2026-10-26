import { loadCatalog } from "@homeport/core";
import { describe, expect, it } from "vitest";
import { allocatePorts } from "../src/ports.js";
import { fakeOps, goodStorage, makeApp, safeVpn, type TestApp, unsafeVpn } from "./helpers.js";

const WATCH = { goals: ["watch"] };

async function ready(opts: Parameters<typeof makeApp>[0] = {}) {
  const t = await makeApp(opts);
  const cookie = await t.signUp();
  return { ...t, me: t.as(cookie), cookie };
}
const vpnSettings = {
  values: {
    VPN_SERVICE_PROVIDER: "protonvpn",
    VPN_TYPE: "wireguard",
    WIREGUARD_PRIVATE_KEY: "secret-key-value",
  },
};
const deployAndWait = async (t: TestApp & { me: ReturnType<TestApp["as"]>; cookie: string }) => {
  const { jobId } = (await t.me.post("/api/deploy")).json() as { jobId: string };
  return t.finish(t.cookie, jobId);
};

describe("catalog and settings", () => {
  it("lists goals in plain language, marking which apps need a VPN", async () => {
    const t = await ready();
    const { goals } = (await t.me.get("/api/catalog")).json();
    const watch = goals.find((g: { id: string }) => g.id === "watch");
    expect(watch.title).toBe("Watch movies and shows");
    expect(watch.apps.find((a: { id: string }) => a.id === "qbittorrent").needsVpn).toBe(true);
    expect(watch.apps.find((a: { id: string }) => a.id === "jellyfin").needsVpn).toBe(false);
  });

  it("saves goals and lists the apps they bring in", async () => {
    const t = await ready();
    const res = (await t.me.put("/api/settings", WATCH)).json();
    expect(res.goals).toEqual(["watch"]);
    expect(res.apps).toEqual(expect.arrayContaining(["sonarr", "radarr", "jellyfin", "qbittorrent"]));
  });

  it("rejects things that would be unsafe in a command or file path", async () => {
    const t = await ready();
    expect((await t.me.put("/api/settings", { project: "Bad Name; rm -rf" })).statusCode).toBe(400);
    expect(
      (await t.me.put("/api/settings", { data: { mode: "bind", source: "D:/Media,rw" } })).statusCode,
    ).toBe(400);
    expect((await t.me.put("/api/settings", { timezone: "Not/AZone" })).statusCode).toBe(400);
    expect((await t.me.put("/api/settings", { hostPorts: { sonarr: { web: 80 } } })).statusCode).toBe(400);
    expect((await t.me.put("/api/settings", { puid: -1 })).statusCode).toBe(400);
  });
});

describe("the VPN settings", () => {
  it("accepts only settings the gateway understands", async () => {
    const t = await ready();
    const bad = await t.me.put("/api/vpn", { values: { VPN_SERVICE_PROVIDER: "x", EVIL: "1" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/not a VPN setting/);
  });

  it("refuses values that could break the .env file", async () => {
    const t = await ready();
    const res = await t.me.put("/api/vpn", {
      values: { VPN_SERVICE_PROVIDER: "x", OPENVPN_PASSWORD: "it's\nbad" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires a provider", async () => {
    const t = await ready();
    expect((await t.me.put("/api/vpn", { values: { VPN_TYPE: "wireguard" } })).statusCode).toBe(400);
  });

  it("never sends secret values back to the browser", async () => {
    const t = await ready();
    const res = await t.me.put("/api/vpn", vpnSettings);
    const text = res.payload;
    expect(text).not.toContain("secret-key-value");
    expect(res.json()).toMatchObject({ configured: true, provider: "protonvpn", verified: false });
    expect(res.json().filled).toContain("WIREGUARD_PRIVATE_KEY");
    expect((await t.me.get("/api/vpn")).payload).not.toContain("secret-key-value");
  });

  it("says downloads are on hold until the VPN is set up and verified", async () => {
    const t = await ready();
    await t.me.put("/api/settings", WATCH);
    const before = (await t.me.get("/api/vpn")).json();
    expect(before).toMatchObject({ needed: true, downloadsOnHold: true, configured: false });
    expect(before.message).toMatch(/add your VPN settings/);
    await t.me.put("/api/vpn", vpnSettings);
    expect((await t.me.get("/api/vpn")).json().message).toMatch(/confirmed that your VPN works/);
  });

  it("can remove the settings again", async () => {
    const t = await ready();
    await t.me.put("/api/vpn", vpnSettings);
    expect((await t.me.del("/api/vpn")).json().configured).toBe(false);
  });
});

describe("homeport.toml", () => {
  it("defaults to requiring a VPN", async () => {
    const t = await ready();
    expect((await t.me.get("/api/config")).json()).toMatchObject({ allowUnprotected: false, problem: null });
  });

  it("reflects the manual override but offers no way to set it through the API", async () => {
    const t = await ready({ toml: "[downloads]\nallow_unprotected = true\n" });
    expect((await t.me.get("/api/config")).json().allowUnprotected).toBe(true);
    expect((await t.me.put("/api/config", { allowUnprotected: false })).statusCode).toBe(404);
    expect((await t.me.post("/api/config", { allowUnprotected: true })).statusCode).toBe(404);
  });

  it("treats a broken file as 'VPN required' and says what is wrong", async () => {
    const t = await ready({ toml: '[downloads]\nallow_unprotected = "yes"\n' });
    await t.me.put("/api/settings", WATCH);
    const cfg = (await t.me.get("/api/config")).json();
    expect(cfg.allowUnprotected).toBe(false);
    expect(cfg.problem).toMatch(/true or false/);
    expect((await t.me.get("/api/vpn")).json().unprotected).toBe(false);
  });
});

describe("plan and export", () => {
  it("shows the services and the VPN situation before anything is installed", async () => {
    const t = await ready();
    await t.me.put("/api/settings", WATCH);
    const plan = (await t.me.get("/api/plan")).json();
    expect(plan.services.map((s: { id: string }) => s.id)).toContain("jellyfin");
    expect(plan.vpn).toMatchObject({ vpn: true, hold: ["qbittorrent"] });
    expect(plan.ramMB).toBeGreaterThan(1000);
  });

  it("exports the compose file without any secrets", async () => {
    const t = await ready();
    await t.me.put("/api/settings", WATCH);
    await t.me.put("/api/vpn", vpnSettings);
    const res = await t.me.get("/api/compose");
    expect(res.headers["content-type"]).toMatch(/yaml/);
    expect(res.payload).toContain("sonarr:");
    expect(res.payload).not.toContain("secret-key-value");
    expect(res.payload).toContain("${SONARR_KEY}");
  });

  it("asks for a goal first", async () => {
    const t = await ready();
    expect((await t.me.get("/api/plan")).statusCode).toBe(400);
  });
});

describe("deploy", () => {
  it("holds the download client when no VPN is configured, and says so", async () => {
    const f = fakeOps();
    const t = await ready({ ops: f.ops });
    await t.me.put("/api/settings", WATCH);
    const job = await deployAndWait(t);
    expect(job.job.status).toBe("succeeded");
    expect(job.job.summary).toMatch(/on hold/);
    expect(f.wired[0]?.selected).not.toContain("qbittorrent");
    expect(f.wired[0]?.selected).toContain("sonarr");
    expect(job.events.some((e) => e.status === "warn" && /add your VPN settings/.test(e.message))).toBe(true);
    // Neither the client nor the gateway was written into the compose file, so neither can have started.
    expect(f.calls.filter((c) => c.startsWith("write")).every((c) => c === "write:plain")).toBe(true);
    expect(job.events.some((e) => e.step === "vpn" && /No VPN is set up yet/.test(e.message))).toBe(true);
  });

  it("starts the download client only after the gateway is verified, then checks it again", async () => {
    const checks: number[] = [];
    const f = fakeOps({
      checkVpn: async () => {
        checks.push(1);
        return safeVpn;
      },
    });
    const t = await ready({ ops: f.ops });
    await t.me.put("/api/settings", WATCH);
    await t.me.put("/api/vpn", vpnSettings);
    const job = await deployAndWait(t);
    expect(job.job.status).toBe("succeeded");
    expect(job.job.summary).toBe("Everything is set up.");
    expect(f.wired[0]?.selected).toContain("qbittorrent");
    const writes = f.calls.filter((c) => c.startsWith("write"));
    expect(writes[0]).not.toContain("+client"); // first the gateway alone
    expect(writes.at(-1)).toContain("+client"); // then the client
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect((await t.me.get("/api/vpn")).json().verified).toBe(true);
  });

  it("keeps downloads off when the VPN never connects", async () => {
    let sleeps = 0;
    const f = fakeOps({ checkVpn: async () => unsafeVpn, sleep: async () => void sleeps++ });
    const t = await ready({ ops: f.ops });
    await t.me.put("/api/settings", WATCH);
    await t.me.put("/api/vpn", vpnSettings);
    const job = await deployAndWait(t);
    expect(job.job.status).toBe("succeeded"); // the rest is set up; downloads wait
    expect(job.job.summary).toMatch(/on hold/);
    expect(job.events.some((e) => /VPN is not working yet/.test(e.message))).toBe(true);
    expect(f.wired[0]?.selected).not.toContain("qbittorrent");
    expect(sleeps).toBeGreaterThan(5); // it kept trying for a while
    expect((await t.me.get("/api/vpn")).json().verified).toBe(false);
  });

  it("stops the download client again if the full check fails after it starts", async () => {
    let n = 0;
    const f = fakeOps({ checkVpn: async () => (++n === 1 ? safeVpn : unsafeVpn) });
    const t = await ready({ ops: f.ops });
    await t.me.put("/api/settings", WATCH);
    await t.me.put("/api/vpn", vpnSettings);
    const job = await deployAndWait(t);
    expect(job.events.some((e) => /stopped again/.test(e.message))).toBe(true);
    expect(f.wired[0]?.selected).not.toContain("qbittorrent");
    expect(f.calls.filter((c) => c.startsWith("write")).at(-1)).not.toContain("+client");
    expect((await t.me.get("/api/vpn")).json().verified).toBe(false);
  });

  it("runs without a VPN only when homeport.toml says so, with a loud warning", async () => {
    const f = fakeOps();
    const t = await ready({ ops: f.ops, toml: "[downloads]\nallow_unprotected = true\n" });
    await t.me.put("/api/settings", WATCH);
    const job = await deployAndWait(t);
    expect(job.events.some((e) => /WITHOUT a VPN/.test(e.message))).toBe(true);
    expect(f.wired[0]?.selected).toContain("qbittorrent");
    expect(f.calls.some((c) => c.startsWith("write:vpn"))).toBe(false);
  });

  it("fails clearly when Docker is not available", async () => {
    const t = await ready({ ops: fakeOps({ checkDocker: async () => "Docker is not running." }).ops });
    await t.me.put("/api/settings", WATCH);
    const job = await deployAndWait(t);
    expect(job.job.status).toBe("failed");
    expect(job.job.summary).toBe("Docker is not running.");
  });

  it("stops when the storage location is not usable", async () => {
    const blocked = {
      ...goodStorage,
      tier: "blocked" as const,
      results: [
        {
          id: "permissions" as const,
          title: "x",
          status: "fail" as const,
          summary: "Your apps are not allowed to write here.",
        },
      ],
    };
    const f = fakeOps({ checkStorage: async () => blocked });
    const t = await ready({ ops: f.ops });
    await t.me.put("/api/settings", WATCH);
    const job = await deployAndWait(t);
    expect(job.job.status).toBe("failed");
    expect(job.job.summary).toMatch(/not allowed to write/);
    expect(f.wired).toHaveLength(0);
  });

  it("asks for a goal before deploying", async () => {
    const t = await ready();
    const job = await deployAndWait(t);
    expect(job.job.summary).toMatch(/Choose what you want to do/);
  });

  it("allows one deploy at a time", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const t = await ready({ ops: fakeOps({ pull: async () => void (await gate) }).ops });
    await t.me.put("/api/settings", WATCH);
    const first = await t.me.post("/api/deploy");
    expect(first.statusCode).toBe(202);
    const second = await t.me.post("/api/deploy");
    expect(second.statusCode).toBe(409);
    release();
    await t.finish(t.cookie, first.json().jobId);
  });

  it("records the deploy in the audit log", async () => {
    const t = await ready();
    await t.me.put("/api/settings", WATCH);
    await deployAndWait(t);
    const actions = (await t.me.get("/api/audit")).json().entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["deploy", "settings", "setup"]));
  });
});

describe("request bodies", () => {
  it("accepts an action with a JSON content-type and no body", async () => {
    const t = await ready();
    await t.me.put("/api/settings", WATCH);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/deploy",
      headers: { ...t.H, cookie: t.cookie, "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(202);
    await t.finish(t.cookie, res.json().jobId);
  });

  it("answers broken JSON with a plain message, not a stack trace", async () => {
    const t = await ready();
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { ...t.H, cookie: t.cookie, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not valid JSON/);
  });
});

describe("live progress", () => {
  it("replays a finished job's events as a Server-Sent Events stream and says how it ended", async () => {
    const t = await ready();
    await t.me.put("/api/settings", WATCH);
    const job = await deployAndWait(t);
    const jobId = (await t.me.get("/api/jobs/latest")).json().job.id;
    const res = await t.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/events`,
      headers: { cookie: t.cookie },
    });
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.payload).toContain("event: progress");
    expect(res.payload).toContain("event: end");
    expect(res.payload).toContain('"status":"succeeded"');
    expect((res.payload.match(/^id: /gm) ?? []).length).toBe(job.events.length);
  });

  it("resumes from Last-Event-ID without repeating what the browser already has", async () => {
    const t = await ready();
    await t.me.put("/api/settings", WATCH);
    const job = await deployAndWait(t);
    const jobId = (await t.me.get("/api/jobs/latest")).json().job.id;
    const res = await t.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/events`,
      headers: { cookie: t.cookie, "last-event-id": String(job.events.length - 1) },
    });
    expect((res.payload.match(/^id: /gm) ?? []).length).toBe(1);
  });

  it("requires sign-in to watch", async () => {
    const t = await ready();
    const res = await t.app.inject({ method: "GET", url: "/api/jobs/anything/events" });
    expect(res.statusCode).toBe(401);
  });
});

describe("allocatePorts", () => {
  it("skips a port that a program outside Docker is already listening on (for example a native Jellyfin)", async () => {
    const busy = async (port: number) => port === 8096;
    const r = await allocatePorts(loadCatalog(), ["jellyfin"], new Set(), {}, busy);
    expect(r.jellyfin).toEqual({ web: 18096 });
  });

  it("does not ask about ports the person already has", async () => {
    const asked: number[] = [];
    await allocatePorts(loadCatalog(), ["sonarr"], new Set(), { sonarr: { web: 8989 } }, async (p) => {
      asked.push(p);
      return true;
    });
    expect(asked).toEqual([]);
  });

  const catalog = loadCatalog();
  it("uses the standard port when it is free", async () => {
    expect((await allocatePorts(catalog, ["sonarr"], new Set())).sonarr).toEqual({ web: 8989 });
  });
  it("moves to a free port above 10000 when another program has it", async () => {
    expect((await allocatePorts(catalog, ["sonarr"], new Set([8989]))).sonarr).toEqual({ web: 18989 });
    expect((await allocatePorts(catalog, ["sonarr"], new Set([8989, 18989]))).sonarr).toEqual({ web: 18990 });
  });
  it("keeps ports already chosen, and never gives two apps the same one", async () => {
    const r = await allocatePorts(catalog, ["sonarr", "radarr"], new Set(), { sonarr: { web: 7878 } });
    expect(r.sonarr).toEqual({ web: 7878 });
    expect(r.radarr?.web).not.toBe(7878);
  });
});
