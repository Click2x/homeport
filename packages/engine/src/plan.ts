import type { AppManifest, Catalog } from "@homeport/core";
import { resolveApps } from "@homeport/core";

/** What the user has chosen. Everything the compose file is generated from. */
export interface Plan {
  /** Docker Compose project name; also the prefix of container and volume names. */
  project: string;
  /** Selected app ids. Dependencies and the VPN gateway are added automatically. */
  apps: string[];
  /** Route apps that need a VPN through the gateway. */
  vpn: boolean;
  /** appId -> port name -> host port. Anything missing uses the app's own port. */
  hostPorts?: Record<string, Record<string, number>>;
  timezone: string;
  puid: number;
  pgid: number;
  /** Where the shared media and downloads live. A named volume is the safe default. */
  data: { mode: "volume" } | { mode: "bind"; source: string };
}

export const GATEWAY_ID = "gluetun";

/** Apps that must go through the VPN gateway under this plan. */
export function isRouted(plan: Plan, app: AppManifest): boolean {
  return plan.vpn && app.vpn === "required";
}

/** The apps to run, in start order, including dependencies and (when needed) the gateway. */
export function expandPlan(catalog: Catalog, plan: Plan): AppManifest[] {
  const apps = resolveApps(catalog, plan.apps).filter((a) => a.id !== GATEWAY_ID);
  if (apps.some((a) => isRouted(plan, a))) {
    const gateway = catalog.apps.get(GATEWAY_ID);
    if (!gateway) throw new Error("the catalog has no VPN gateway app");
    apps.unshift(gateway);
  }
  return apps;
}

export function hostPort(plan: Plan, app: AppManifest, portName: string): number {
  const own = app.ports.find((p) => p.name === portName);
  if (!own) throw new Error(`${app.id} has no port named ${portName}`);
  return plan.hostPorts?.[app.id]?.[portName] ?? own.container;
}

/** The hostname other containers use to reach an app (the gateway for routed apps). */
export function serviceHost(plan: Plan, app: AppManifest): string {
  return isRouted(plan, app) ? GATEWAY_ID : app.id;
}

/** Name of the .env variable that holds an app's generated API key, e.g. SONARR_KEY. */
export function keyVar(app: AppManifest): string {
  return `${app.id.toUpperCase().replace(/-/g, "_")}_KEY`;
}
