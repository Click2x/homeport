import type { Catalog } from "@homeport/core";
import { resolveApps } from "@homeport/core";
import { docker } from "@homeport/engine";

/** Host ports already published by containers that do NOT belong to `project`. */
export async function takenPorts(project: string): Promise<Set<number>> {
  const taken = new Set<number>();
  let out: string;
  try {
    out = await docker(["ps", "--format", '{{.Label "com.docker.compose.project"}}|{{.Ports}}']);
  } catch {
    return taken;
  }
  for (const line of out.split("\n")) {
    const [owner, ports = ""] = line.split("|");
    if (!line.trim() || owner === project) continue;
    for (const m of ports.matchAll(/:(\d+)->/g)) taken.add(Number(m[1]));
  }
  return taken;
}

/**
 * Pick a host port for every published port: the app's standard port when free, otherwise the next
 * free one above 10000. Ports the person already chose are kept. Runs on every deploy so an
 * existing install keeps its ports.
 */
export function allocatePorts(
  catalog: Catalog,
  apps: string[],
  taken: Set<number>,
  chosen: Record<string, Record<string, number>> = {},
): Record<string, Record<string, number>> {
  const used = new Set(taken);
  const result: Record<string, Record<string, number>> = {};
  // Reserve everything already chosen first so two apps never end up on the same port.
  for (const ports of Object.values(chosen)) for (const p of Object.values(ports)) used.add(p);
  for (const app of resolveApps(catalog, apps)) {
    for (const port of app.ports) {
      const existing = chosen[app.id]?.[port.name];
      let pick = existing;
      if (pick === undefined) {
        pick = port.container;
        while (used.has(pick)) pick += pick < 10000 ? 10000 : 1;
        used.add(pick);
      }
      result[app.id] = { ...result[app.id], [port.name]: pick };
    }
  }
  return result;
}
