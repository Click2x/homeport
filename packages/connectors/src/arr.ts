import type { WireContext } from "./context.js";
import { fillFields, jsonClient, type SchemaField, waitUntil } from "./http.js";

interface Item {
  id?: number;
  name: string;
  implementation: string;
  fields: SchemaField[];
  [k: string]: unknown;
}

export type MediaManager = "sonarr" | "radarr";

const MEDIA = {
  sonarr: { label: "Sonarr", rootPath: "/data/media/tv", categoryField: "tvCategory", category: "tv" },
  radarr: {
    label: "Radarr",
    rootPath: "/data/media/movies",
    categoryField: "movieCategory",
    category: "movies",
  },
} as const;

/** Client for Sonarr and Radarr (API v3). */
export function mediaManagerApi(ctx: WireContext, app: MediaManager) {
  return jsonClient(ctx, `${ctx.url(app)}/api/v3`, { "X-Api-Key": ctx.keys[app] ?? "" }, app);
}

export async function waitForApp(ctx: WireContext, app: string, apiVersion: "v1" | "v3") {
  const api = jsonClient(ctx, `${ctx.url(app)}/api/${apiVersion}`, { "X-Api-Key": ctx.keys[app] ?? "" }, app);
  await waitUntil(ctx, app, () => api("GET", "/system/status"));
}

/** Give Sonarr or Radarr a library folder and qBittorrent as its download client. Safe to run again. */
export async function wireMediaManager(
  ctx: WireContext,
  app: MediaManager,
  { downloadClient = true }: { downloadClient?: boolean } = {},
): Promise<void> {
  const api = mediaManagerApi(ctx, app);
  const { label, rootPath, categoryField, category } = MEDIA[app];

  const roots = await api<{ path: string }[]>("GET", "/rootfolder");
  if (!roots.some((r) => r.path === rootPath)) {
    await api("POST", "/rootfolder", { path: rootPath });
    ctx.log(`${label}: added library folder ${rootPath}`);
  }

  // A held-back download client is not running, so do not point the manager at it yet.
  if (!downloadClient) return;

  // The host is the VPN gateway when qBittorrent runs behind it, so this must follow the plan.
  const qbit = ctx.internal("qbittorrent");
  const clients = await api<Item[]>("GET", "/downloadclient");
  const existing = clients.find((c) => c.name === "qBittorrent");
  const values = {
    host: qbit.host,
    port: qbit.port,
    username: "admin",
    password: ctx.qbittorrent.password,
    [categoryField]: category,
  };
  if (!existing) {
    const schemas = await api<Item[]>("GET", "/downloadclient/schema");
    const schema = schemas.find((s) => s.implementation === "QBittorrent");
    if (!schema) throw new Error(`${label} offers no qBittorrent download client`);
    await api("POST", "/downloadclient", {
      ...fillFields(schema, values),
      name: "qBittorrent",
      enable: true,
    });
    ctx.log(`${label}: added qBittorrent as the download client`);
  } else if (existing.fields.find((f) => f.name === "host")?.value !== qbit.host) {
    await api("PUT", `/downloadclient/${existing.id}`, fillFields(existing, { host: qbit.host }));
    ctx.log(`${label}: download client now reached through ${qbit.host}`);
  }
}

/** Link Prowlarr to Sonarr and Radarr so indexers you add there are shared with both. */
export async function wireProwlarr(ctx: WireContext, targets: MediaManager[]): Promise<void> {
  const api = jsonClient(
    ctx,
    `${ctx.url("prowlarr")}/api/v1`,
    { "X-Api-Key": ctx.keys.prowlarr ?? "" },
    "Prowlarr",
  );
  const apps = await api<Item[]>("GET", "/applications");
  const schemas = await api<Item[]>("GET", "/applications/schema");
  const self = ctx.internal("prowlarr");
  for (const target of targets) {
    const name = MEDIA[target].label;
    if (apps.some((a) => a.name === name)) continue;
    const schema = schemas.find((s) => s.implementation === name);
    if (!schema) throw new Error(`Prowlarr offers no ${name} link`);
    const there = ctx.internal(target);
    const body = fillFields(schema, {
      prowlarrUrl: `http://${self.host}:${self.port}`,
      baseUrl: `http://${there.host}:${there.port}`,
      apiKey: ctx.keys[target],
    });
    await api("POST", "/applications", { ...body, name, syncLevel: "fullSync" });
    ctx.log(`Prowlarr: linked ${name}`);
  }
}
