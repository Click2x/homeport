import { describe, expect, it } from "vitest";
import { evaluate, type Probe, parseProbe } from "../src/index.js";

const GB = 1024 ** 3;
const healthy: Probe = {
  fsType: "ext2/ext3",
  hardlinkCount: 2,
  renameContent: "two",
  sameDevice: true,
  writeMBps: 300,
  freeBytes: 500 * GB,
  writableAsAppUser: true,
};
const bind = { mode: "bind", source: "/srv/homeport" } as const;
const volume = { mode: "volume", project: "homeport" } as const;
const ids = (r: ReturnType<typeof evaluate>, status: string) =>
  r.results.filter((x) => x.status === status).map((x) => x.id);

describe("evaluate", () => {
  it("rates a fast Linux folder as best", () => {
    const r = evaluate({ ...healthy, fsType: "ext4" }, bind);
    expect(r.tier).toBe("best");
    expect(r.copyMode).toBe(false);
    expect(ids(r, "fail")).toEqual([]);
  });

  it("rates a healthy Docker volume as good and warns it is deleted by a Docker reset", () => {
    const r = evaluate({ ...healthy, fsType: "ext4" }, volume);
    expect(r.tier).toBe("good");
    expect(ids(r, "warn")).toContain("location");
  });

  it("rates a shared Windows drive that links fine as good, with a slower-drive warning", () => {
    const r = evaluate({ ...healthy, fsType: "9p", writeMBps: 90 }, bind);
    expect(r.tier).toBe("good");
    expect(ids(r, "warn")).toContain("filesystem");
  });

  it("falls back to copy mode when hardlinks do not work, and says so in plain words", () => {
    const r = evaluate({ ...healthy, fsType: "9p", hardlinkCount: null }, bind);
    expect(r.tier).toBe("compatible");
    expect(r.copyMode).toBe(true);
    const link = r.results.find((x) => x.id === "hardlinks");
    expect(link?.summary).toMatch(/copied/);
    expect(link?.fix).toMatchObject({ kind: "auto", action: "enable-copy-mode" });
  });

  it("treats downloads and library on different drives as copy mode too", () => {
    const r = evaluate({ ...healthy, sameDevice: false }, bind);
    expect(r.tier).toBe("compatible");
    expect(r.copyMode).toBe(true);
  });

  it("is compatible when the drive is very slow", () => {
    const r = evaluate({ ...healthy, writeMBps: 4 }, bind);
    expect(r.tier).toBe("compatible");
    expect(r.results.find((x) => x.id === "speed")?.status).toBe("fail");
  });

  it("blocks when the apps cannot write, and offers an automatic permission fix", () => {
    const r = evaluate({ ...healthy, writableAsAppUser: false }, bind);
    expect(r.tier).toBe("blocked");
    expect(r.results.find((x) => x.id === "permissions")?.fix).toMatchObject({
      kind: "auto",
      action: "fix-permissions",
    });
  });

  it("blocks when there is almost no space, but only warns when space is merely modest", () => {
    expect(evaluate({ ...healthy, freeBytes: 2 * GB }, bind).tier).toBe("blocked");
    const modest = evaluate({ ...healthy, fsType: "ext4", freeBytes: 60 * GB }, bind);
    expect(modest.tier).toBe("best");
    expect(ids(modest, "warn")).toContain("space");
  });

  it("gives every failing check a fix and plain-language text", () => {
    const r = evaluate(
      {
        ...healthy,
        hardlinkCount: null,
        renameContent: null,
        sameDevice: false,
        writeMBps: 2,
        writableAsAppUser: false,
        freeBytes: 1 * GB,
      },
      bind,
    );
    for (const x of r.results.filter((c) => c.status === "fail")) {
      expect(x.fix, x.id).toBeDefined();
      expect(x.summary.length, x.id).toBeGreaterThan(20);
      expect(x.summary).not.toMatch(/inode|st_dev|EXDEV|errno/i);
    }
  });
});

describe("evaluate on Docker Desktop", () => {
  it("treats an unrecognised filesystem on a chosen folder as a shared Windows drive", () => {
    const r = evaluate(
      { ...healthy, fsType: "UNKNOWN (0x6a656a63)", writeMBps: 105 },
      { mode: "bind", source: "D:/Media" },
    );
    expect(r.tier).toBe("good");
    expect(r.results.find((x) => x.id === "filesystem")?.status).toBe("warn");
  });

  it("flags a fresh Docker volume as not writable until permissions are fixed (it starts owned by root)", () => {
    const r = evaluate({ ...healthy, fsType: "ext4", writableAsAppUser: false }, volume);
    expect(r.tier).toBe("blocked");
    expect(r.results.find((x) => x.id === "permissions")?.fix).toMatchObject({ action: "fix-permissions" });
  });
});

describe("parseProbe", () => {
  const output = [
    "fstype=ext2/ext3",
    "hardlink=2",
    "rename=two",
    "samedev=yes",
    "dd=134217728 bytes (128.0MB, 128.0MiB) copied, 0.4 s, 320.0MB/s",
    "freekb=104857600",
  ].join("\n");

  it("reads a healthy probe", () => {
    const p = parseProbe(output, true);
    expect(p).toMatchObject({
      fsType: "ext2/ext3",
      hardlinkCount: 2,
      renameContent: "two",
      sameDevice: true,
    });
    expect(p.writeMBps).toBeCloseTo(320, 0);
    expect(p.freeBytes).toBe(100 * GB);
  });

  it("reads gigabytes per second", () => {
    expect(parseProbe(output.replace("320.0MB/s", "1.5GB/s"), true).writeMBps).toBeCloseTo(1536, 0);
  });

  it("falls back to the elapsed time when no rate is printed", () => {
    expect(parseProbe(output.replace(", 320.0MB/s", ""), true).writeMBps).toBeCloseTo(320, 0);
  });

  it("records failed links and renames as missing results", () => {
    const p = parseProbe(
      output.replace("hardlink=2", "hardlink=fail").replace("rename=two", "rename=fail"),
      true,
    );
    expect(p.hardlinkCount).toBeNull();
    expect(p.renameContent).toBeNull();
  });

  it("explains an unwritable location", () => {
    expect(() => parseProbe("error=cannot-write", false)).toThrow(/could not write/);
  });
});
