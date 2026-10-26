import { describe, expect, it } from "vitest";
import { AttemptLimiter, passwordProblem } from "../src/auth.js";
import { makeApp, PASSWORD, SETUP_CODE } from "./helpers.js";

describe("first-run setup", () => {
  it("reports that setup is needed, and that nobody is signed in", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.json()).toEqual({ setupRequired: true, authenticated: false, username: null });
  });

  it("rejects the wrong setup code", async () => {
    const { app, H } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: H,
      payload: { token: "WRONG", username: "admin", password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/setup code/);
  });

  it("creates the administrator with the right code and signs them in", async () => {
    const t = await makeApp();
    const cookie = await t.signUp();
    expect(cookie).toMatch(/^hp_session=/);
    expect((await t.as(cookie).get("/api/status")).json()).toMatchObject({
      setupRequired: false,
      authenticated: true,
      username: "admin",
    });
  });

  it("works only once", async () => {
    const t = await makeApp();
    await t.signUp();
    const again = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      headers: t.H,
      payload: { token: SETUP_CODE, username: "second", password: PASSWORD },
    });
    expect(again.statusCode).toBe(409);
  });

  it("refuses weak passwords with a helpful message", async () => {
    const { app, H } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: H,
      payload: { token: SETUP_CODE, username: "admin", password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least 12 characters/);
  });

  it("sets the session cookie as HttpOnly and SameSite=Strict", async () => {
    const { app, H } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: H,
      payload: { token: SETUP_CODE, username: "admin", password: PASSWORD },
    });
    const c = res.cookies.find((x) => x.name === "hp_session");
    expect(c).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
  });
});

describe("signing in", () => {
  it("rejects a wrong password without saying which part was wrong", async () => {
    const t = await makeApp();
    await t.signUp();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/login",
      headers: t.H,
      payload: { username: "admin", password: "not the password at all" },
    });
    expect(res.statusCode).toBe(401);
    const unknown = await t.app.inject({
      method: "POST",
      url: "/api/login",
      headers: t.H,
      payload: { username: "nobody", password: "not the password at all" },
    });
    expect(unknown.json().error).toBe(res.json().error);
  });

  it("locks out an address after repeated failures", async () => {
    const t = await makeApp();
    await t.signUp();
    const attempt = () =>
      t.app.inject({
        method: "POST",
        url: "/api/login",
        headers: t.H,
        payload: { username: "admin", password: "wrong wrong wrong" },
      });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    const blocked = await attempt();
    expect(blocked.statusCode).toBe(429);
    // Even the right password is refused while locked out.
    const right = await t.app.inject({
      method: "POST",
      url: "/api/login",
      headers: t.H,
      payload: { username: "admin", password: PASSWORD },
    });
    expect(right.statusCode).toBe(429);
  });

  it("signs in with the right password", async () => {
    const t = await makeApp();
    await t.signUp();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/login",
      headers: t.H,
      payload: { username: "admin", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.some((c) => c.name === "hp_session")).toBe(true);
  });

  it("ends the session on sign out", async () => {
    const t = await makeApp();
    const cookie = await t.signUp();
    await t.as(cookie).post("/api/logout");
    expect((await t.as(cookie).get("/api/settings")).statusCode).toBe(401);
  });

  it("signs out other devices when the password changes", async () => {
    const t = await makeApp();
    const first = await t.signUp();
    const second = (
      await t.app.inject({
        method: "POST",
        url: "/api/login",
        headers: t.H,
        payload: { username: "admin", password: PASSWORD },
      })
    ).cookies.find((c) => c.name === "hp_session");
    const other = `hp_session=${second?.value}`;
    const res = await t
      .as(first)
      .post("/api/password", { current: PASSWORD, next: "a brand new passphrase" });
    expect(res.statusCode).toBe(200);
    expect((await t.as(other).get("/api/settings")).statusCode).toBe(401);
  });
});

describe("protection of everything else", () => {
  it("requires a session for the API", async () => {
    const { app } = await makeApp();
    for (const url of [
      "/api/settings",
      "/api/catalog",
      "/api/vpn",
      "/api/stack",
      "/api/audit",
      "/api/compose",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    expect(
      (await app.inject({ method: "POST", url: "/api/deploy", headers: { "x-homeport": "1" } })).statusCode,
    ).toBe(401);
  });

  it("refuses state-changing requests without the anti-forgery header, even when signed in", async () => {
    const t = await makeApp();
    const cookie = await t.signUp();
    const res = await t.app.inject({ method: "POST", url: "/api/deploy", headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a request that comes from another site", async () => {
    const t = await makeApp();
    const cookie = await t.signUp();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/deploy",
      headers: { ...t.H, cookie, origin: "https://evil.example", host: "homeport.local:8484" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a forged session token", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: "hp_session=forged" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("sends safe headers and never caches API answers", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
  });

  it("does not leak internals when something breaks", async () => {
    const { app } = await makeApp();
    const t = await makeApp();
    const cookie = await t.signUp();
    // An unknown goal is a UserError; a broken body is a validation error. Neither shows a stack trace.
    const res = await t.as(cookie).put("/api/settings", { goals: ["nope"] });
    expect(res.json().error).toMatch(/Unknown goal/);
    expect(JSON.stringify(res.json())).not.toMatch(/at .*\.ts|node_modules/);
    expect(app).toBeDefined();
  });
});

describe("AttemptLimiter", () => {
  it("forgets failures after the window and after a success", () => {
    let t = 0;
    const lim = new AttemptLimiter(2, 1000, () => t);
    lim.fail("a");
    lim.fail("a");
    expect(lim.blockedFor("a")).toBeGreaterThan(0);
    t = 2000;
    expect(lim.blockedFor("a")).toBe(0);
    lim.fail("b");
    lim.succeed("b");
    lim.fail("b");
    expect(lim.blockedFor("b")).toBe(0);
  });
});

describe("passwordProblem", () => {
  it("explains what is wrong in plain words", () => {
    expect(passwordProblem("short", "admin")).toMatch(/at least 12/);
    expect(passwordProblem("my admin password here", "admin")).toMatch(/username/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa", "bob")).toMatch(/repetitive/);
    expect(passwordProblem("correct horse battery", "admin")).toBeNull();
  });
});
