import { dataVolumeName, docker } from "./docker.js";

/** Where the shared media and downloads live, as the storage checker sees it. */
export type DataLocation = { mode: "volume"; project: string } | { mode: "bind"; source: string };

export type Tier = "best" | "good" | "compatible" | "blocked";
export type Status = "pass" | "warn" | "fail";

/** A fix is either something Homeport can do itself, or steps the user performs. */
export type Fix =
  | { kind: "auto"; action: "enable-copy-mode" | "fix-permissions"; label: string }
  | { kind: "guided"; label: string; steps: string[] };

export interface CheckResult {
  id: "hardlinks" | "rename" | "same-drive" | "speed" | "permissions" | "space" | "filesystem" | "location";
  title: string;
  status: Status;
  /** Plain language, no jargon. This is what a beginner reads. */
  summary: string;
  fix?: Fix;
}

export interface StorageReport {
  tier: Tier;
  results: CheckResult[];
  /** True when hardlinks cannot work, so imports will copy files (using twice the space while seeding). */
  copyMode: boolean;
  measured: { fsType: string; freeBytes: number; writeMBps: number | null };
}

/** Raw measurements from the probe container. All evaluation works from this, so it is easy to test. */
export interface Probe {
  fsType: string;
  hardlinkCount: number | null; // null = the link command failed
  renameContent: string | null; // content of the target after an atomic rename; null = failed
  sameDevice: boolean;
  writeMBps: number | null;
  freeBytes: number;
  writableAsAppUser: boolean;
}

/** Filesystems Docker Desktop uses to share a Windows or macOS folder with Linux containers. */
const SHARED_FS = /^(9p|drvfs|virtiofs|fuse|fuseblk|grpcfuse|osxfs|smb|cifs|nfs|vboxsf)/i;
const NATIVE_FS = /^(ext[234]|xfs|btrfs|zfs|f2fs|overlay|tmpfs)/i;

const GB = 1024 ** 3;

export function evaluate(probe: Probe, location: DataLocation): StorageReport {
  const results: CheckResult[] = [];
  // Docker Desktop reports a shared Windows folder as an unrecognised type (for example "UNKNOWN"), so
  // anything non-native on a folder the user chose is treated as a shared drive.
  const native = NATIVE_FS.test(probe.fsType) && !SHARED_FS.test(probe.fsType);
  const shared = SHARED_FS.test(probe.fsType) || (!native && location.mode === "bind");

  const canLink = probe.hardlinkCount !== null && probe.hardlinkCount >= 2;
  results.push(
    canLink
      ? {
          id: "hardlinks",
          title: "Imports without copying",
          status: "pass",
          summary:
            "Finished downloads are linked into your library instead of copied, so they take no extra space.",
        }
      : {
          id: "hardlinks",
          title: "Imports without copying",
          status: "fail",
          summary:
            "This location cannot link files, so every finished download will be copied. That uses twice the space while a torrent is still seeding, and is slower.",
          fix: {
            kind: "auto",
            action: "enable-copy-mode",
            label: "Keep going and copy files instead",
          },
        },
  );

  const renameOk = probe.renameContent === "two" || probe.renameContent === "one";
  results.push(
    renameOk
      ? {
          id: "rename",
          title: "Safe file moves",
          status: "pass",
          summary: "Files are moved in one step, so a half-finished file is never picked up.",
        }
      : {
          id: "rename",
          title: "Safe file moves",
          status: "fail",
          summary: "Files cannot be replaced safely here, so a download could be picked up half-finished.",
          fix: {
            kind: "guided",
            label: "Choose a different location",
            steps: ["Pick a folder on a drive formatted for Linux (ext4) or inside Docker's own storage."],
          },
        },
  );

  results.push(
    probe.sameDevice
      ? {
          id: "same-drive",
          title: "Downloads and library on one drive",
          status: "pass",
          summary: "Downloads and your library share one drive, which is what lets files be linked.",
        }
      : {
          id: "same-drive",
          title: "Downloads and library on one drive",
          status: "fail",
          summary: "Downloads and your library are on different drives, so every import is a full copy.",
          fix: {
            kind: "guided",
            label: "Use one data folder for both",
            steps: ["Put downloads and your library under a single folder on one drive."],
          },
        },
  );

  const speed = probe.writeMBps;
  if (speed === null) {
    results.push({
      id: "speed",
      title: "Disk speed",
      status: "warn",
      summary: "Disk speed could not be measured.",
    });
  } else if (speed < 10) {
    results.push({
      id: "speed",
      title: "Disk speed",
      status: "fail",
      summary: `This location writes at only about ${Math.round(speed)} MB/s. Downloads and imports will be very slow.`,
      fix: {
        kind: "guided",
        label: "Use a faster location",
        steps: [
          "Pick a folder on an internal SSD or hard drive.",
          "Avoid network shares and USB drives connected through a hub.",
        ],
      },
    });
  } else if (speed < 40) {
    results.push({
      id: "speed",
      title: "Disk speed",
      status: "warn",
      summary: `This location writes at about ${Math.round(speed)} MB/s. It will work, but large imports will feel slow.`,
    });
  } else {
    results.push({
      id: "speed",
      title: "Disk speed",
      status: "pass",
      summary: `Fast enough (about ${Math.round(speed)} MB/s).`,
    });
  }

  results.push(
    probe.writableAsAppUser
      ? {
          id: "permissions",
          title: "Apps can read and write",
          status: "pass",
          summary: "Your apps can create, change and delete files here.",
        }
      : {
          id: "permissions",
          title: "Apps can read and write",
          status: "fail",
          summary: "Your apps are not allowed to write here, so nothing could be saved.",
          fix: { kind: "auto", action: "fix-permissions", label: "Give the apps access" },
        },
  );

  if (probe.freeBytes < 20 * GB) {
    results.push({
      id: "space",
      title: "Free space",
      status: "fail",
      summary: `Only ${(probe.freeBytes / GB).toFixed(1)} GB is free. A media library needs far more.`,
      fix: {
        kind: "guided",
        label: "Free up space or choose a bigger drive",
        steps: ["Choose a drive with at least 100 GB free, or remove files you no longer need."],
      },
    });
  } else if (probe.freeBytes < 100 * GB) {
    results.push({
      id: "space",
      title: "Free space",
      status: "warn",
      summary: `${Math.round(probe.freeBytes / GB)} GB is free. That is enough to start, but a library fills up quickly.`,
    });
  } else {
    results.push({
      id: "space",
      title: "Free space",
      status: "pass",
      summary: `${Math.round(probe.freeBytes / GB)} GB free.`,
    });
  }

  if (shared) {
    results.push({
      id: "filesystem",
      title: "Drive type",
      status: "warn",
      summary:
        "This is a Windows or Mac drive shared into Docker. It works, but it is slower, and files you add from outside Docker may not be noticed right away.",
      fix: {
        kind: "guided",
        label: "Use Docker's own storage or a Linux-formatted drive",
        steps: [
          "For the best results, keep your library on a drive Docker manages itself.",
          "Homeport can scan for new files on a schedule to cover missed changes.",
        ],
      },
    });
  }

  if (location.mode === "volume") {
    results.push({
      id: "location",
      title: "Where your library lives",
      status: "warn",
      summary:
        "Your library is stored inside Docker's own disk. It is fast and reliable, but resetting or uninstalling Docker Desktop would delete it.",
      fix: {
        kind: "guided",
        label: "Back up, or choose a folder you control",
        steps: [
          "Pick a folder on a drive you manage if you want the library to survive a Docker reset.",
          "Never use Docker's 'Clean / Purge data' option while your library is stored there.",
        ],
      },
    });
  }

  const failed = (id: CheckResult["id"]) => results.some((r) => r.id === id && r.status === "fail");
  let tier: Tier;
  if (failed("permissions") || probe.freeBytes < 5 * GB) tier = "blocked";
  else if (failed("hardlinks") || failed("rename") || failed("same-drive") || failed("speed"))
    tier = "compatible";
  else if (native && location.mode === "bind") tier = "best";
  else tier = "good";

  return {
    tier,
    results,
    copyMode: failed("hardlinks") || failed("same-drive"),
    measured: { fsType: probe.fsType, freeBytes: probe.freeBytes, writeMBps: probe.writeMBps },
  };
}

/** A one-line, plain-language description of each tier for the interface. */
export const TIER_SUMMARY: Record<Tier, string> = {
  best: "Best: fast, safe, and files are linked instead of copied.",
  good: "Good: works well, with a few things worth knowing.",
  compatible: "Compatible: works, but imports will copy files and may be slower.",
  blocked: "Not ready: something must be fixed before Homeport can use this location.",
};

// ---- the Docker side ----------------------------------------------------------------------------

const APP_DIRS = "/data /data/torrents /data/media /data/media/tv /data/media/movies";

/**
 * One short shell script, run in a throwaway container that mounts exactly what the stack will mount.
 * It first creates the folders the apps expect (so a fresh volume is ready), then measures. Starting
 * containers is the slow part on a busy Docker, so this does both jobs in one.
 */
const probeScript = (puid: number, pgid: number) => `
set -u
mkdir -p ${APP_DIRS} && chown ${Number(puid)}:${Number(pgid)} ${APP_DIRS} 2>/dev/null
d=/data/.homeport-check
rm -rf "$d"; mkdir -p "$d/torrents" "$d/media" && cd "$d" || { echo "error=cannot-write"; exit 0; }
echo "fstype=$(stat -f -c %T /data)"
echo hello > a
if ln a b 2>/dev/null; then echo "hardlink=$(stat -c %h a)"; else echo "hardlink=fail"; fi
echo one > r1; echo two > r2
if mv -f r1 r2 2>/dev/null; then echo "rename=$(cat r2)"; else echo "rename=fail"; fi
if [ "$(stat -c %d torrents)" = "$(stat -c %d media)" ]; then echo "samedev=yes"; else echo "samedev=no"; fi
echo "dd=$(dd if=/dev/zero of=bench bs=1M count=128 conv=fsync 2>&1 | tail -1)"
echo "freekb=$(df -k /data | tail -1 | awk '{print $4}')"
cd /; rm -rf "$d"
`;

export function parseProbe(output: string, writableAsAppUser: boolean): Probe {
  const kv = new Map<string, string>();
  for (const line of output.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  if (kv.has("error")) throw new Error("Homeport could not write to the data location.");
  // busybox dd ends with e.g. "134217728 bytes (128.0MB) copied, 0.4 seconds, 320.0MB/s" or "... copied, 0.4 s, 320.0MB/s"
  const dd = kv.get("dd") ?? "";
  const rate = dd.match(/([\d.]+)\s*([KMG]i?B)\/s/i);
  const secs = dd.match(/copied,\s*([\d.]+)\s*s/i);
  let writeMBps: number | null = null;
  if (rate?.[1] && rate[2]) {
    const unit = rate[2].toUpperCase().startsWith("G")
      ? 1024
      : rate[2].toUpperCase().startsWith("K")
        ? 1 / 1024
        : 1;
    writeMBps = Number(rate[1]) * unit;
  } else if (secs?.[1] && Number(secs[1]) > 0) {
    writeMBps = 128 / Number(secs[1]);
  }
  const link = kv.get("hardlink");
  return {
    fsType: kv.get("fstype") ?? "unknown",
    hardlinkCount: link && link !== "fail" ? Number(link) : null,
    renameContent: kv.get("rename") && kv.get("rename") !== "fail" ? (kv.get("rename") as string) : null,
    sameDevice: kv.get("samedev") === "yes",
    writeMBps,
    freeBytes: Number(kv.get("freekb") ?? 0) * 1024,
    writableAsAppUser,
  };
}

const mountFor = (location: DataLocation) =>
  `${location.mode === "volume" ? dataVolumeName(location.project) : location.source}:/data`;

export interface CheckOptions {
  puid: number;
  pgid: number;
}

/**
 * Create the folders the apps expect and hand them to the user the apps run as. This is also the
 * automatic "give the apps access" fix. It never changes ownership of files that already exist, so
 * pointing Homeport at an existing library is safe.
 */
export async function prepareStorage(location: DataLocation, { puid, pgid }: CheckOptions): Promise<void> {
  await docker([
    "run",
    "--rm",
    "-v",
    mountFor(location),
    "alpine",
    "sh",
    "-c",
    `mkdir -p ${APP_DIRS} && chown ${Number(puid)}:${Number(pgid)} ${APP_DIRS}`,
  ]);
}

/**
 * Run the storage checks against the place the stack will keep its data. It creates the standard
 * folders first (never changing files that already exist), then measures using a temporary folder.
 */
export async function checkStorage(
  location: DataLocation,
  { puid, pgid }: CheckOptions,
): Promise<StorageReport> {
  const mount = mountFor(location);
  const out = await docker(["run", "--rm", "-v", mount, "alpine", "sh", "-c", probeScript(puid, pgid)]);
  // Can the user the apps run as write here? A separate container, started as that user.
  const asApp = await docker([
    "run",
    "--rm",
    "--user",
    `${Number(puid)}:${Number(pgid)}`,
    "-v",
    mount,
    "alpine",
    "sh",
    "-c",
    "mkdir -p /data/.homeport-perm && touch /data/.homeport-perm/x && rm -rf /data/.homeport-perm && echo ok",
  ]).then(
    (o) => o.trim() === "ok",
    () => false,
  );
  return evaluate(parseProbe(out, asApp), location);
}
