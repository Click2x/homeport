import { type MediaManager, waitForApp, wireMediaManager, wireProwlarr } from "./arr.js";
import type { WireContext } from "./context.js";
import { wireJellyfin } from "./jellyfin.js";
import { wireQbittorrent } from "./qbittorrent.js";
import { recyclarrConfig } from "./recyclarr.js";
import { wireSeerr } from "./seerr.js";

export interface WireOptions {
  /** Runs Recyclarr with the given config. Provided by the engine because it needs Docker. */
  runRecyclarr?: (config: string) => Promise<void>;
}

const managersIn = (selected: string[]) =>
  (["sonarr", "radarr"] as const).filter((m) => selected.includes(m)) as MediaManager[];

/** Phase 1: link the apps to each other. */
export async function wireApps(ctx: WireContext, selected: string[]): Promise<void> {
  const has = (id: string) => selected.includes(id);
  const managers = managersIn(selected);

  for (const m of managers) await waitForApp(ctx, m, "v3");
  if (has("prowlarr")) await waitForApp(ctx, "prowlarr", "v1");

  if (has("qbittorrent")) await wireQbittorrent(ctx);
  for (const m of managers) await wireMediaManager(ctx, m);
  if (has("prowlarr")) await wireProwlarr(ctx, managers);
  if (has("jellyfin")) await wireJellyfin(ctx);
}

/** Phase 2: create the quality profiles. Seerr needs them, so this runs before phase 3. */
export async function syncProfiles(
  ctx: WireContext,
  selected: string[],
  options: WireOptions,
): Promise<void> {
  const managers = managersIn(selected);
  if (!managers.length || !options.runRecyclarr) return;
  await options.runRecyclarr(recyclarrConfig(ctx, managers));
  ctx.log("Recyclarr: TRaSH quality profiles synced");
}

/** Phase 3: connect the request app to the media server and the managers. */
export async function wireRequests(ctx: WireContext, selected: string[]): Promise<void> {
  if (selected.includes("seerr") && selected.includes("jellyfin")) await wireSeerr(ctx);
}

/**
 * Wire whatever is installed, in the order that works. Every step is safe to repeat.
 * The phases are exported separately so a caller can run them in different places.
 */
export async function wireStack(
  ctx: WireContext,
  selected: string[],
  options: WireOptions = {},
): Promise<void> {
  await wireApps(ctx, selected);
  await syncProfiles(ctx, selected, options);
  await wireRequests(ctx, selected);
}
