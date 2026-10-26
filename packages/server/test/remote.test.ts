import { describe, expect, it } from "vitest";
import { pruneExpired } from "../src/remote.js";
import { fakeOps, makeApp, type TestApp } from "./helpers.js";

const WATCH = { goals: ["watch"] };

async function ready(ops = fakeOps()) {
  const t = await makeApp({ ops: ops.ops });
  const cookie = await t.signUp();
  const me = t.as(cookie);
  await me.put("/api/settings", WATCH);
  return { ...t, me, cookie, fake: ops };
}
type Ready = Awaited<ReturnType<typeof ready>>;

const deploy = async (t: Ready) => {
  const { jobId } = (await t.me.post("/api/deploy")).json() as { jobId: string };
  return t.finish(t.cookie, jobId);
};
/** Remote access switched on and the stack deployed, so the gateway is "running". */
async function live() {
  const t = await ready();
  const r = await t.me.put("/api/remote", { enabled: true, endpoint: "home.example.com" });
  expect(r.statusCode).toBe(200);
  await deploy(t);
  return t;
}

describe("turning remote access on", () => {
  it("is closed to anyone who is not signed in", async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/remote" })).statusCode).toBe(401);
  });

  it("starts switched off", async () => {
    const t = await ready();
    expect((await t.me.get("/api/remote")).json()).toMatchObject({ enabled: false, people: [], live: false });
  });

  it("explains an address that cannot work from outside", async () => {
    const t = await ready();
    const res = await t.me.put("/api/remote", { enabled: true, endpoint: "192.168.1.20" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/private address/);
  });

  it("needs a goal first", async () => {
    const t = await makeApp();
    const cookie = await t.signUp();
    const res = await t.as(cookie).put("/api/remote", { enabled: true, endpoint: "home.example.com" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Choose what you want to do/);
  });

  it("says an install is needed before it is live", async () => {
    const t = await ready();
    const v = (await t.me.put("/api/remote", { enabled: true, endpoint: "home.example.com" })).json();
    expect(v).toMatchObject({
      enabled: true,
      live: false,
      needsApply: true,
      port: 51820,
      gatewayAddress: "10.13.13.1",
    });
  });

  it("finds the public address on request, and only on request", async () => {
    const t = await ready();
    expect((await t.me.post("/api/remote/detect")).json()).toEqual({ ip: "203.0.113.9" });
  });

  it("rejects a port outside the allowed range", async () => {
    const t = await ready();
    expect((await t.me.put("/api/remote", { enabled: false, port: 80 })).statusCode).toBe(400);
  });
});

describe("deploying with remote access on", () => {
  it("builds the sidecar before starting anything, then gives it its rules", async () => {
    const t = await ready();
    await t.me.put("/api/remote", { enabled: true, endpoint: "home.example.com" });
    const job = await deploy(t);
    expect(job.job.status).toBe("succeeded");
    const calls = t.fake.calls;
    const image = calls.indexOf("wg-image");
    expect(image).toBeGreaterThanOrEqual(0);
    expect(image).toBeLessThan(calls.indexOf("pull"));
    expect(t.fake.wgApplied).toHaveLength(1);
    expect(t.fake.wgApplied[0]?.conf).toContain("[Interface]");
    expect(job.events.some((e) => e.step === "remote" && /Remote access is on/.test(e.message))).toBe(true);
    const view = (await t.me.get("/api/remote")).json();
    expect(view).toMatchObject({ live: true, needsApply: false });
  });

  it("does nothing about remote access when it is off", async () => {
    const t = await ready();
    await deploy(t);
    expect(t.fake.calls).not.toContain("wg-image");
    expect(t.fake.wgApplied).toHaveLength(0);
  });

  it("asks for another install when the port is changed", async () => {
    const t = await live();
    const v = (
      await t.me.put("/api/remote", { enabled: true, endpoint: "home.example.com", port: 51999 })
    ).json();
    expect(v.needsApply).toBe(true);
    expect(v.port).toBe(51999);
  });

  it("asks for an install to remove the gateway after it is switched off", async () => {
    const t = await live();
    const v = (await t.me.put("/api/remote", { enabled: false })).json();
    expect(v).toMatchObject({ enabled: false, needsApply: true });
  });
});

describe("inviting people", () => {
  it("needs remote access to be on", async () => {
    const t = await ready();
    const res = await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Turn on remote access/);
  });

  it("offers the installed apps, flagging the ones that could change the setup", async () => {
    const t = await live();
    const { shareable } = (await t.me.get("/api/remote")).json() as {
      shareable: { id: string; sensitive: boolean }[];
    };
    const by = (id: string) => shareable.find((s) => s.id === id);
    expect(by("jellyfin")?.sensitive).toBe(false);
    expect(by("seerr")?.sensitive).toBe(false);
    expect(by("sonarr")?.sensitive).toBe(true);
    expect(by("gluetun")).toBeUndefined();
    expect(by("wireguard")).toBeUndefined();
  });

  it("makes a phone file and a QR code, and applies them to the gateway", async () => {
    const t = await live();
    const before = t.fake.wgApplied.length;
    const res = await t.me.post("/api/remote/people", {
      name: "Sam's phone",
      services: ["jellyfin", "seerr"],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.applied).toBe(true);
    expect(body.person).toMatchObject({
      name: "Sam's phone",
      ip: "10.13.13.2",
      services: ["jellyfin", "seerr"],
      online: false,
    });
    expect(body.config).toContain("Endpoint = home.example.com:51820");
    expect(body.config).toContain("AllowedIPs = 10.13.13.1/32");
    expect(body.qr).toMatch(/^<\?xml|^<svg/);
    expect(t.fake.wgApplied.length).toBe(before + 1);
    const applied = t.fake.wgApplied.at(-1);
    expect(applied?.conf).toContain("AllowedIPs = 10.13.13.2/32");
    expect(applied?.rules).toContain("-s 10.13.13.2");
  });

  it("never stores or later shows the person's private key", async () => {
    const t = await live();
    const made = (await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] })).json();
    const privateKey = /PrivateKey = (\S+)/.exec(made.config)?.[1] ?? "";
    expect(privateKey.length).toBeGreaterThan(40);
    expect((await t.me.get("/api/remote")).payload).not.toContain(privateKey);
    for (const a of t.fake.wgApplied) expect(a.conf).not.toContain(privateKey);
  });

  it("does not put the server's private key in anything the browser receives", async () => {
    const t = await live();
    const made = (await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] })).json();
    const serverKey = /PrivateKey = (\S+)/.exec(t.fake.wgApplied.at(-1)?.conf ?? "")?.[1] ?? "";
    expect(serverKey.length).toBeGreaterThan(40);
    expect(JSON.stringify(made)).not.toContain(serverKey);
    expect((await t.me.get("/api/remote")).payload).not.toContain(serverKey);
  });

  it("hands each person their own address", async () => {
    const t = await live();
    const a = (await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] })).json();
    const b = (await t.me.post("/api/remote/people", { name: "Alex", services: ["jellyfin"] })).json();
    expect([a.person.ip, b.person.ip]).toEqual(["10.13.13.2", "10.13.13.3"]);
  });

  it("refuses what makes no sense, with plain reasons", async () => {
    const t = await live();
    await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] });
    const bad = async (payload: object) =>
      (await t.me.post("/api/remote/people", payload)).json().error as string;
    expect(await bad({ name: "sam", services: ["jellyfin"] })).toMatch(/already invited/);
    expect(await bad({ name: "Alex", services: [] })).toMatch(/at least one app/);
    expect(await bad({ name: "Alex", services: ["nope"] })).toMatch(/not an app you have installed/);
    expect(await bad({ name: "!!!", services: ["jellyfin"] })).toMatch(/Give this person a name/);
    expect(await bad({ name: "Alex", services: ["jellyfin"], expiresInDays: 0 })).toMatch(/1 to 365/);
  });

  it("says when the gateway is not running yet, so nothing is lost", async () => {
    const t = await ready();
    await t.me.put("/api/remote", { enabled: true, endpoint: "home.example.com" });
    const res = (await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] })).json();
    expect(res.applied).toBe(false);
    expect(res.note).toMatch(/apply your changes/);
    // ...and the next install picks them up.
    await deploy(t);
    expect(t.fake.wgApplied.at(-1)?.conf).toContain("AllowedIPs = 10.13.13.2/32");
  });

  it("reports who is online from the gateway's handshakes", async () => {
    const t = await live();
    const made = (await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] })).json();
    expect((await t.me.get("/api/remote")).json().people[0].online).toBe(false);
    const publicKey = /AllowedIPs = 10\.13\.13\.2\/32/.test(t.fake.wgApplied.at(-1)?.conf ?? "")
      ? /PublicKey = (\S+)\nAllowedIPs = 10\.13\.13\.2\/32/.exec(t.fake.wgApplied.at(-1)?.conf ?? "")?.[1]
      : undefined;
    expect(publicKey).toBeDefined();
    t.fake.wgStatus.push({
      publicKey: publicKey as string,
      endpoint: "1.2.3.4:5",
      latestHandshake: Math.floor(Date.now() / 1000) - 30,
      rx: 1,
      tx: 1,
    });
    const person = (await t.me.get("/api/remote")).json().people[0];
    expect(person).toMatchObject({ id: made.person.id, online: true });
    expect(person.lastSeen).toBeTruthy();
  });
});

describe("changing and revoking access", () => {
  it("revoking someone removes them from the gateway straight away", async () => {
    const t = await live();
    const sam = (await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] })).json();
    await t.me.post("/api/remote/people", { name: "Alex", services: ["jellyfin"] });
    const res = await t.me.del(`/api/remote/people/${sam.person.id}`);
    expect(res.json().applied).toBe(true);
    const last = t.fake.wgApplied.at(-1);
    expect(last?.conf).not.toContain("AllowedIPs = 10.13.13.2/32");
    expect(last?.conf).toContain("AllowedIPs = 10.13.13.3/32");
    expect((await t.me.get("/api/remote")).json().people.map((p: { name: string }) => p.name)).toEqual([
      "Alex",
    ]);
  });

  it("changing someone's apps updates their rules", async () => {
    const t = await live();
    const sam = (
      await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin", "seerr"] })
    ).json();
    await t.me.put(`/api/remote/people/${sam.person.id}`, { services: ["jellyfin"] });
    const rules = t.fake.wgApplied.at(-1)?.rules ?? "";
    expect(rules).toContain("-s 10.13.13.2 -d $ip_jellyfin");
    expect(rules).not.toContain("-s 10.13.13.2 -d $ip_seerr");
  });

  it("will not leave someone with no apps at all", async () => {
    const t = await live();
    const sam = (await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] })).json();
    expect((await t.me.put(`/api/remote/people/${sam.person.id}`, { services: [] })).statusCode).toBe(400);
  });

  it("answers 404 for someone who is not on the list", async () => {
    const t = await live();
    expect((await t.me.del("/api/remote/people/nobody")).statusCode).toBe(404);
  });

  it("records invitations and revocations in the audit log", async () => {
    const t = await live();
    const sam = (await t.me.post("/api/remote/people", { name: "Sam", services: ["jellyfin"] })).json();
    await t.me.del(`/api/remote/people/${sam.person.id}`);
    const actions = (await t.me.get("/api/audit")).json().entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["remote-invite", "remote-revoke", "remote-access"]));
  });
});

describe("invitations that expire", () => {
  it("removes invitations whose time is up, and keeps the rest", async () => {
    const t = await live();
    await t.me.post("/api/remote/people", { name: "Short", services: ["jellyfin"], expiresInDays: 1 });
    await t.me.post("/api/remote/people", { name: "Long", services: ["jellyfin"], expiresInDays: 30 });
    await t.me.post("/api/remote/people", { name: "Forever", services: ["jellyfin"] });
    const gone = pruneExpired(t.store, Date.now() + 2 * 86_400_000);
    expect(gone.map((p) => p.name)).toEqual(["Short"]);
    const names = (await t.me.get("/api/remote")).json().people.map((p: { name: string }) => p.name);
    expect(names).toEqual(["Long", "Forever"]);
  });

  it("revokes an expired person on the gateway when the list is viewed", async () => {
    const t = await live();
    await t.me.post("/api/remote/people", { name: "Short", services: ["jellyfin"], expiresInDays: 1 });
    // Pretend two days passed by rewriting the stored end date.
    const peers = t.store.getJson<{ expiresAt: string }[]>("remote.peers") ?? [];
    for (const p of peers) p.expiresAt = new Date(Date.now() - 1000).toISOString();
    t.store.setJson("remote.peers", peers);
    const before = t.fake.wgApplied.length;
    expect((await t.me.get("/api/remote")).json().people).toEqual([]);
    expect(t.fake.wgApplied.length).toBe(before + 1);
    expect(t.fake.wgApplied.at(-1)?.conf).not.toContain("[Peer]");
  });
});

export type { TestApp };
