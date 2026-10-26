import { containerName, docker } from "./docker.js";
import { parseWgDump, WG_INTERFACE, type WgPeerStatus } from "./wireguard.js";

export const WG_IMAGE = "homeport-wireguard:local";
/** Bump this whenever docker/wireguard changes, so existing installs rebuild the sidecar. */
export const WG_IMAGE_VERSION = "2";
const sidecar = (project: string) => containerName(project, "wireguard");

/**
 * Make sure the sidecar image exists, building it from the small Dockerfile that ships with Homeport the
 * first time. Needs the internet once, to download the WireGuard tools.
 */
export async function ensureWireguardImage(
  contextDir: string,
  image = WG_IMAGE,
): Promise<{ built: boolean }> {
  try {
    const have = (
      await docker(["image", "inspect", "-f", '{{index .Config.Labels "homeport.wireguard.version"}}', image])
    ).trim();
    if (have === WG_IMAGE_VERSION) return { built: false };
  } catch {
    // not built yet
  }
  await docker(["build", "--build-arg", `VERSION=${WG_IMAGE_VERSION}`, "-t", image, contextDir]);
  return { built: true };
}

/** Replace a file inside the sidecar atomically. The content travels over stdin, never on a command line. */
async function writeFile(project: string, path: string, content: string, mode: string): Promise<void> {
  await docker(
    [
      "exec",
      "-i",
      sidecar(project),
      "sh",
      "-c",
      `cat > ${path}.new && chmod ${mode} ${path}.new && mv ${path}.new ${path}`,
    ],
    { input: content },
  );
}

/**
 * Give the sidecar its tunnel configuration and firewall rules and make them take effect now. New or
 * removed people apply without dropping anyone else's connection.
 */
export async function applyWireguard(project: string, conf: string, rules: string): Promise<void> {
  await writeFile(project, "/config/wg0.conf", conf, "600");
  await writeFile(project, "/config/rules.sh", rules, "700");
  const name = sidecar(project);
  // On the very first start the sidecar brings the tunnel up by itself within a second; a reload is only
  // needed when it is already running, so a failure here just means "not up yet".
  await docker([
    "exec",
    name,
    "sh",
    "-c",
    `wg show ${WG_INTERFACE} >/dev/null 2>&1 && { wg-quick strip /config/wg0.conf > /tmp/wg0.stripped && wg syncconf ${WG_INTERFACE} /tmp/wg0.stripped; } || true`,
  ]);
  await docker(["exec", name, "sh", "-c", "rm -f /tmp/hp-rules-state; sh /config/rules.sh"]).catch(
    () => undefined,
  );
}

/** Who is connected right now. Empty if the sidecar is not running. */
export async function wireguardStatus(project: string): Promise<WgPeerStatus[]> {
  try {
    return parseWgDump(await docker(["exec", sidecar(project), "wg", "show", WG_INTERFACE, "dump"]));
  } catch {
    return [];
  }
}

export async function wireguardRunning(project: string): Promise<boolean> {
  try {
    return (await docker(["inspect", "-f", "{{.State.Running}}", sidecar(project)])).trim() === "true";
  } catch {
    return false;
  }
}
