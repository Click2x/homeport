import { type Catalog, resolveApps } from "@homeport/core";
import type { Plan } from "@homeport/engine";
import type { Store } from "./store.js";

/** Raised for problems the person can understand and fix. The message is safe to show as it is. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface StackSettings {
  /** What the person wants to do (goal ids from the catalog). */
  goals: string[];
  /** The Docker Compose project name. */
  project: string;
  hostPorts: Record<string, Record<string, number>>;
  data: { mode: "volume" } | { mode: "bind"; source: string };
  timezone: string;
  puid: number;
  pgid: number;
}

export const DEFAULT_SETTINGS = (): StackSettings => ({
  goals: [],
  project: "homeport",
  hostPorts: {},
  data: { mode: "volume" },
  timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  puid: 1000,
  pgid: 1000,
});

export const SETTINGS_KEY = "stack.settings";

export function loadSettings(store: Store): StackSettings {
  return { ...DEFAULT_SETTINGS(), ...store.getJson<Partial<StackSettings>>(SETTINGS_KEY) };
}

/** App ids for the chosen goals. Unknown goals are an error, not silently ignored. */
export function appsForGoals(catalog: Catalog, goals: string[]): string[] {
  const ids = new Set<string>();
  for (const goal of goals) {
    const g = catalog.goals.find((x) => x.id === goal);
    if (!g) throw new UserError(`Unknown goal "${goal}".`);
    for (const id of g.apps) ids.add(id);
  }
  return resolveApps(catalog, [...ids]).map((a) => a.id);
}

const PROJECT_NAME = /^[a-z][a-z0-9_-]{0,30}$/;
const SAFE_PATH = /^[^\0\n\r]+$/;

/** Validate what the browser sent. Anything that ends up in a command or a file path is checked here. */
export function validateSettingsInput(
  input: Partial<StackSettings>,
  catalog: Catalog,
): Partial<StackSettings> {
  const out: Partial<StackSettings> = {};
  if (input.goals) {
    appsForGoals(catalog, input.goals);
    out.goals = [...new Set(input.goals)];
  }
  if (input.project !== undefined) {
    if (!PROJECT_NAME.test(input.project))
      throw new UserError(
        "The project name can only use lowercase letters, numbers, dashes and underscores.",
      );
    out.project = input.project;
  }
  if (input.data) {
    if (input.data.mode === "bind") {
      if (!SAFE_PATH.test(input.data.source) || input.data.source.includes(","))
        throw new UserError("That folder path contains characters Homeport cannot use.");
      out.data = { mode: "bind", source: input.data.source };
    } else out.data = { mode: "volume" };
  }
  if (input.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch {
      throw new UserError(`"${input.timezone}" is not a time zone Homeport knows.`);
    }
    out.timezone = input.timezone;
  }
  for (const k of ["puid", "pgid"] as const) {
    const v = input[k];
    if (v !== undefined) {
      if (!Number.isInteger(v) || v < 0 || v > 65535)
        throw new UserError(`${k.toUpperCase()} must be a whole number.`);
      out[k] = v;
    }
  }
  if (input.hostPorts) {
    for (const [app, ports] of Object.entries(input.hostPorts))
      for (const [name, port] of Object.entries(ports))
        if (!Number.isInteger(port) || port < 1024 || port > 65535)
          throw new UserError(`The port for ${app} (${name}) must be a number between 1024 and 65535.`);
    out.hostPorts = input.hostPorts;
  }
  return out;
}

export function buildPlan(
  settings: StackSettings,
  apps: string[],
  extra: { vpn: boolean; hold: string[]; hostPorts: Plan["hostPorts"] },
): Plan {
  return {
    project: settings.project,
    apps,
    vpn: extra.vpn,
    hold: extra.hold,
    hostPorts: extra.hostPorts,
    timezone: settings.timezone,
    puid: settings.puid,
    pgid: settings.pgid,
    data: settings.data,
  };
}
