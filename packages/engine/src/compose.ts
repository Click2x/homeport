import type { AppManifest, Catalog } from "@homeport/core";
import { stringify } from "yaml";
import { expandPlan, GATEWAY_ID, hostPort, isRouted, keyVar, type Plan, routedApps } from "./plan.js";

export interface ComposeService {
  image: string;
  restart: string;
  init?: boolean;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  cap_add?: string[];
  devices?: string[];
  sysctls?: Record<string, string>;
  pull_policy?: string;
  network_mode?: string;
  depends_on?: string[];
}

export interface ComposeFile {
  name: string;
  services: Record<string, ComposeService>;
  volumes: Record<string, null>;
}

const portString = (host: number, container: number, protocol?: string) =>
  `${host}:${container}${protocol === "udp" ? "/udp" : ""}`;

/** Build the Docker Compose project for a plan. Secrets are ${VAR} references, never literal values. */
export function generateCompose(catalog: Catalog, plan: Plan): ComposeFile {
  const apps = expandPlan(catalog, plan);
  // Ports the gateway opens and publishes come from every app that belongs behind it, even a held one.
  const routed = routedApps(catalog, plan);
  const services: Record<string, ComposeService> = {};
  const volumes: Record<string, null> = {};
  const dataSource = plan.data.mode === "bind" ? plan.data.source : "data";
  if (plan.data.mode === "volume" && apps.some((a) => a.volumes.some((v) => v.kind === "data")))
    volumes.data = null;

  for (const app of apps) {
    const service: ComposeService = {
      image: app.digest ? `${app.image}@${app.digest}` : `${app.image}:${app.tag}`,
      restart: "unless-stopped",
    };
    if (app.init) service.init = true;

    const environment: Record<string, string> = {};
    if (app.linuxserver) {
      environment.PUID = String(plan.puid);
      environment.PGID = String(plan.pgid);
      environment.TZ = plan.timezone;
    }
    Object.assign(environment, app.env);
    if (app.apiKeyEnv) environment[app.apiKeyEnv] = `\${${keyVar(app)}}`;
    if (app.id === GATEWAY_ID) {
      for (const name of app.passthroughEnv ?? []) environment[name] = `\${${name}:-}`;
      environment.TZ = plan.timezone;
      environment.FIREWALL_INPUT_PORTS = routed.flatMap((a) => a.ports.map((p) => p.container)).join(",");
    }
    if (Object.keys(environment).length) service.environment = environment;

    const mounts = app.volumes.map((v) => {
      if (v.kind === "config") {
        volumes[`${app.id}-config`] = null;
        return `${app.id}-config:${v.container}`;
      }
      return `${dataSource}:${v.container}`;
    });
    if (mounts.length) service.volumes = mounts;

    if (app.capAdd?.length) service.cap_add = app.capAdd;
    if (app.devices?.length) service.devices = app.devices;
    if (app.sysctls) service.sysctls = app.sysctls;
    if (app.pullPolicy) service.pull_policy = app.pullPolicy;

    if (isRouted(plan, app)) {
      // Shares the gateway's network, so it has no route out except through the tunnel.
      service.network_mode = `service:${GATEWAY_ID}`;
      service.depends_on = [GATEWAY_ID];
    } else if (app.id === GATEWAY_ID) {
      // The gateway publishes the web pages of the apps behind it.
      service.ports = routed.flatMap((a) =>
        a.ports.map((p) => portString(hostPort(plan, a, p.name), p.container, p.protocol)),
      );
    } else if (app.ports.length) {
      service.ports = app.ports.map((p) => portString(hostPort(plan, app, p.name), p.container, p.protocol));
    }
    services[app.id] = service;
  }
  return { name: plan.project, services, volumes: Object.fromEntries(Object.entries(volumes).sort()) };
}

export function composeToYaml(compose: ComposeFile): string {
  return stringify(compose, { lineWidth: 0, aliasDuplicateObjects: false });
}

export type { AppManifest };
