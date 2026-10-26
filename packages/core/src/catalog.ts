import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { type AppManifest, ManifestError, parseManifest } from "./manifest.js";

export interface Goal {
  id: string;
  title: string;
  description: string;
  apps: string[];
}

export interface Catalog {
  apps: Map<string, AppManifest>;
  goals: Goal[];
}

// manifests/ and goals.yaml sit at the package root, one level above both src/ and dist/.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadCatalog(root = packageRoot): Catalog {
  const apps = new Map<string, AppManifest>();
  const dir = join(root, "manifests");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const app = parseManifest(parse(readFileSync(join(dir, file), "utf8")), file);
    if (app.id !== file.replace(/\.yaml$/, ""))
      throw new ManifestError(`${file}: id must match the file name`);
    apps.set(app.id, app);
  }
  const goals = parse(readFileSync(join(root, "goals.yaml"), "utf8")) as Goal[];
  for (const goal of goals)
    for (const id of goal.apps)
      if (!apps.has(id)) throw new ManifestError(`goal ${goal.id}: unknown app ${id}`);
  for (const app of apps.values())
    for (const id of app.dependsOn ?? [])
      if (!apps.has(id)) throw new ManifestError(`${app.id}: depends on unknown app ${id}`);
  return { apps, goals };
}

/** Every app a selection needs: the apps themselves plus their dependencies, dependencies first. */
export function resolveApps(catalog: Catalog, ids: string[]): AppManifest[] {
  const out: AppManifest[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const app = catalog.apps.get(id);
    if (!app) throw new ManifestError(`unknown app ${id}`);
    for (const dep of app.dependsOn ?? []) visit(dep);
    out.push(app);
  };
  for (const id of ids) visit(id);
  return out;
}
