import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A Docker command failed. `detail` is the tail of its error output, safe to show the user. */
export class DockerError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the command's standard input. */
  input?: string;
}

/**
 * Run the docker CLI with an argument list (never through a shell, so nothing a user types can be
 * interpreted as a command). Secrets belong in `env`, not in `args`, so they never show up in errors.
 */
export function docker(args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      args,
      { cwd: options.cwd, env: { ...process.env, ...options.env }, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        // Some tools (Recyclarr, for one) write their errors to stdout, so look at both.
        const text = `${stderr}\n${stdout}`.trim() || error.message;
        const tail = text.split("\n").slice(-8).join("\n");
        reject(new DockerError(`docker ${args.slice(0, 2).join(" ")} failed`, tail));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Is Docker installed, running, and new enough? Returns a plain-language problem, or null if fine. */
export async function checkDocker(): Promise<string | null> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
  } catch {
    return "Docker is not running or not installed. Start Docker Desktop (or the Docker service) and try again.";
  }
  try {
    await docker(["compose", "version"]);
  } catch {
    return "Docker Compose v2 is required, but 'docker compose' did not work.";
  }
  return null;
}

export interface ComposeProject {
  /** Folder holding compose.yaml and .env. */
  dir: string;
  project: string;
}

export async function writeProject(p: ComposeProject, composeYaml: string, dotEnv: string): Promise<void> {
  await mkdir(p.dir, { recursive: true });
  await writeFile(join(p.dir, "compose.yaml"), composeYaml);
  await writeFile(join(p.dir, ".env"), dotEnv, { mode: 0o600 });
}

const compose = (p: ComposeProject, ...rest: string[]) => [
  "compose",
  "-p",
  p.project,
  "--project-directory",
  p.dir,
  "-f",
  join(p.dir, "compose.yaml"),
  ...rest,
];

export const composePull = (p: ComposeProject) => docker(compose(p, "pull", "--quiet"));
export const composeUp = (p: ComposeProject) => docker(compose(p, "up", "-d", "--remove-orphans"));
export const composeDown = (p: ComposeProject, { volumes = false } = {}) =>
  docker(compose(p, "down", "--remove-orphans", ...(volumes ? ["-v"] : [])));

/** Container names follow Compose's convention, which the checks and connectors rely on. */
export const containerName = (project: string, service: string) => `${project}-${service}-1`;
export const networkName = (project: string) => `${project}_default`;
export const dataVolumeName = (project: string) => `${project}_data`;

/** Create the folders Sonarr and Radarr expect, owned by the user the apps run as. */
export async function initDataVolume(project: string, puid: number, pgid: number): Promise<void> {
  await docker([
    "run",
    "--rm",
    "-v",
    `${dataVolumeName(project)}:/data`,
    "alpine",
    "sh",
    "-c",
    `mkdir -p /data/torrents /data/media/tv /data/media/movies && chown -R ${Number(puid)}:${Number(pgid)} /data`,
  ]);
}

/** A fresh qBittorrent prints a one-time admin password (to stderr). Wait for it to appear. */
export async function readQbitFirstRunPassword(
  project: string,
  { tries = 30, delayMs = 2000 } = {},
): Promise<string | undefined> {
  for (let i = 0; i < tries; i++) {
    const out = await new Promise<string>((resolve) => {
      execFile(
        "docker",
        ["logs", containerName(project, "qbittorrent")],
        { maxBuffer: 8 * 1024 * 1024 },
        (_e, stdout, stderr) => resolve(`${stdout}${stderr}`),
      );
    });
    const found = [...out.matchAll(/temporary password[^:]*:\s*(\S+)/gi)].pop()?.[1];
    if (found) return found;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return undefined;
}

/**
 * Run Recyclarr once against the stack. The config reaches the container through a short-lived
 * named volume, not a host folder, so this behaves the same when Homeport itself runs in a container.
 */
export async function runRecyclarr(project: string, config: string, image = "ghcr.io/recyclarr/recyclarr:8") {
  const volume = `${project}_recyclarr-run`;
  try {
    await docker(
      [
        "run",
        "--rm",
        "-i",
        "-v",
        `${volume}:/config`,
        "alpine",
        "sh",
        "-c",
        // Recyclarr runs as a non-root user, so this short-lived, private volume must be writable by it.
        "mkdir -p /config/configs && cat > /config/configs/homeport.yml && chmod -R a+rwX /config",
      ],
      { input: config },
    );
    await docker([
      "run",
      "--rm",
      "--network",
      networkName(project),
      "-v",
      `${volume}:/config`,
      image,
      "sync",
    ]);
  } finally {
    // The volume holds API keys, so never leave it behind.
    await docker(["volume", "rm", "-f", volume]).catch(() => undefined);
  }
}
