import { syncProfiles, wireApps, wireRequests } from "@homeport/connectors";
import {
  applyWireguard,
  checkDocker,
  checkStorage,
  checkVpn,
  composePull,
  composeUp,
  docker,
  ensureWireguardImage,
  networkName,
  prepareStorage,
  readQbitFirstRunPassword,
  runRecyclarr,
  wireguardStatus,
  writeProject,
} from "@homeport/engine";
import type { DeployOps } from "./deploy.js";
import { portInUseOnHost, takenPorts } from "./ports.js";
import { UserError } from "./settings.js";

/** Homeport reaches the apps by name, so it has to share their network, which only works from inside a container. */
async function joinNetwork(project: string): Promise<void> {
  const self = process.env.HOSTNAME;
  if (process.env.HOMEPORT_IN_CONTAINER !== "1" || !self)
    throw new UserError(
      "Homeport has to run inside Docker to set up your apps. Start it with the command from the quick start, not directly on your computer.",
    );
  try {
    await docker(["network", "connect", networkName(project), self]);
  } catch (e) {
    // Already connected from a previous deploy is fine.
    if (!/already exists|already connected|endpoint with name/i.test((e as { detail?: string }).detail ?? ""))
      throw e;
  }
}

async function publicIp(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(8000) });
    const text = (await res.text()).trim();
    return /^[0-9a-f.:]+$/i.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** The real operations. `wireguardContext` is the folder holding the sidecar's Dockerfile. */
export const createRealOps = (wireguardContext: string): DeployOps => ({
  checkDocker,
  takenPorts,
  writeProject,
  pull: composePull,
  up: composeUp,
  prepareStorage,
  checkStorage,
  joinNetwork,
  qbitFirstRunPassword: (project) => readQbitFirstRunPassword(project),
  runRecyclarr,
  checkVpn: (project) => checkVpn(project),
  wireApps,
  syncProfiles,
  wireRequests,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  portInUse: portInUseOnHost,
  ensureWireguardImage: () => ensureWireguardImage(wireguardContext),
  applyWireguard,
  wireguardStatus,
  publicIp,
});
