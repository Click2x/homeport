// Host-side helpers: they use the catalog and engine, which the helper container does not have.
import { loadCatalog } from "../packages/core/dist/index.js";
import { keyVar, serviceHost } from "../packages/engine/dist/index.js";
import { SELECTED, contextFrom } from "./e2e-context.mjs";

export { SELECTED };

export function makePlan(project, hostPorts) {
  return {
    project,
    apps: SELECTED,
    vpn: false,
    hostPorts,
    timezone: "UTC",
    puid: 1000,
    pgid: 1000,
    data: { mode: "volume" },
  };
}

/** app id -> where another container reaches it, and the env var names that hold the API keys. */
export function addressing(plan) {
  const catalog = loadCatalog();
  const internal = {};
  const keyVars = {};
  for (const id of SELECTED) {
    const app = catalog.apps.get(id);
    internal[id] = { host: serviceHost(plan, app), port: app.ports[0].container };
    if (app.apiKeyEnv) keyVars[id] = keyVar(app);
  }
  return { internal, keyVars };
}

export function makeContext(plan, secrets, log) {
  const { internal, keyVars } = addressing(plan);
  return contextFrom(internal, keyVars, secrets, log);
}
