import { describe, expect, it } from "vitest";
import { hashPassword, SecretBox, safeEqual, verifyPassword } from "../src/crypto.js";
import { Store } from "../src/store.js";

describe("passwords", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password here")).not.toBe(await hashPassword("same password here"));
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("compares strings without leaking length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("SecretBox", () => {
  const box = new SecretBox(Buffer.alloc(32, 1));

  it("round-trips and never stores plain text", () => {
    const sealed = box.seal("my-vpn-key");
    expect(sealed).not.toContain("my-vpn-key");
    expect(box.open(sealed)).toBe("my-vpn-key");
  });

  it("detects tampering", () => {
    const parts = box.seal("secret").split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => box.open(parts.join("."))).toThrow();
  });

  it("cannot be opened with a different key", () => {
    expect(() => new SecretBox(Buffer.alloc(32, 2)).open(box.seal("secret"))).toThrow();
  });
});

describe("Store", () => {
  it("keeps generated secrets stable once created", () => {
    const s = Store.memory();
    const first = s.ensureSecret("sonarr.key");
    expect(s.ensureSecret("sonarr.key")).toBe(first);
    expect(first).toHaveLength(22);
  });

  it("stores and lists secrets by prefix, and can delete them", () => {
    const s = Store.memory();
    s.setSecret("vpn.WIREGUARD_PRIVATE_KEY", "k");
    s.setSecret("sonarr.key", "x");
    expect(s.secretNames("vpn.")).toEqual(["vpn.WIREGUARD_PRIVATE_KEY"]);
    s.deleteSecret("vpn.WIREGUARD_PRIVATE_KEY");
    expect(s.secretNames("vpn.")).toEqual([]);
  });

  it("round-trips JSON settings", () => {
    const s = Store.memory();
    expect(s.getJson("stack")).toBeUndefined();
    s.setJson("stack", { apps: ["sonarr"] });
    expect(s.getJson("stack")).toEqual({ apps: ["sonarr"] });
  });

  it("creates users and sessions, and a session can be ended", () => {
    const s = Store.memory();
    const id = s.createUser("admin", "hash");
    const token = s.createSession(id);
    expect(s.findSession(token)).toEqual({ userId: id, username: "admin" });
    s.deleteSession(token);
    expect(s.findSession(token)).toBeUndefined();
  });

  it("does not know an invented session token", () => {
    expect(Store.memory().findSession("nope")).toBeUndefined();
  });

  it("records job progress in order and can replay from a point", () => {
    const s = Store.memory();
    s.createJob("j1", "deploy");
    s.addEvent("j1", { step: "docker", status: "done", message: "Docker is ready" });
    s.addEvent("j1", { step: "pull", status: "running", message: "Downloading" });
    s.addEvent("j1", { step: "pull", status: "done", message: "Downloaded" });
    expect(s.events("j1").map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.events("j1", 2).map((e) => e.message)).toEqual(["Downloaded"]);
    s.finishJob("j1", "succeeded", "All set");
    expect(s.getJob("j1")).toMatchObject({ status: "succeeded", summary: "All set" });
  });

  it("marks jobs that were running when Homeport stopped as failed", () => {
    const s = Store.memory();
    s.createJob("j2", "deploy");
    s.failInterruptedJobs();
    expect(s.getJob("j2")?.status).toBe("failed");
  });

  it("keeps an audit trail, newest first", () => {
    const s = Store.memory();
    s.audit("admin", "login");
    s.audit("admin", "deploy", "watch");
    expect(s.recentAudit().map((a) => a.action)).toEqual(["deploy", "login"]);
  });
});
