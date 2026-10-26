import type { WireContext } from "./context.js";

/** Public TRaSH Guides profile ids (see https://trash-guides.info). */
export const TRASH_PROFILES = {
  sonarr: { id: "72dae194fc92bf828f32cde7744e51a1", name: "WEB-1080p" },
  radarr: { id: "d1d67249d3890e49bc12e275d989a7e9", name: "HD Bluray + WEB" },
} as const;

/** The Recyclarr (v8) config that creates the TRaSH quality profiles. Contains API keys, so keep it private. */
export function recyclarrConfig(ctx: WireContext, apps: ("sonarr" | "radarr")[]): string {
  const lines: string[] = [];
  const quality = { sonarr: "series", radarr: "movie" } as const;
  for (const app of apps) {
    const there = ctx.internal(app);
    const profile = TRASH_PROFILES[app];
    lines.push(
      `${app}:`,
      `  ${app === "sonarr" ? "tv" : "movies"}:`,
      `    base_url: http://${there.host}:${there.port}`,
      `    api_key: ${ctx.keys[app]}`,
      "    quality_definition:",
      `      type: ${quality[app]}`,
      "    quality_profiles:",
      `      - trash_id: ${profile.id}  # ${profile.name}`,
      "        reset_unmatched_scores:",
      "          enabled: true",
    );
  }
  return `${lines.join("\n")}\n`;
}
