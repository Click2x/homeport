import type { WireContext } from "./context.js";
import { HttpError, waitUntil } from "./http.js";

interface Library {
  id: string;
  name: string;
  enabled: boolean;
}
interface Profile {
  id: number;
  name: string;
}
const NOT_CONFIGURED = 4;

/**
 * Sign Seerr in with the Jellyfin admin (which also sets Seerr up the first time), turn on the
 * libraries, and link Sonarr and Radarr using the quality profiles Recyclarr created.
 */
export async function wireSeerr(ctx: WireContext): Promise<void> {
  const f = ctx.fetch ?? fetch;
  const base = `${ctx.url("seerr")}/api/v1`;
  let cookie = "";
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await f(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok)
      throw new HttpError(
        res.status,
        `Seerr: ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`,
      );
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0] ?? cookie;
    return (text ? JSON.parse(text) : null) as T;
  };

  await waitUntil(ctx, "Seerr", () => api("GET", "/status"));
  const pub = await api<{ initialized: boolean; mediaServerType: number }>("GET", "/settings/public");

  // Once a media server is saved, Seerr rejects connection details on login, so only send them the first time.
  const login = { username: ctx.jellyfin.adminUser, password: ctx.jellyfin.adminPassword };
  const jf = ctx.internal("jellyfin");
  await api(
    "POST",
    "/auth/jellyfin",
    pub.mediaServerType === NOT_CONFIGURED
      ? {
          ...login,
          hostname: jf.host,
          port: jf.port,
          useSsl: false,
          urlBase: "",
          email: "admin@homeport.local",
          serverType: 2,
        }
      : login,
  );
  if (!pub.initialized) ctx.log("Seerr: connected to Jellyfin, admin user created");

  // Seerr 3.x: sync pulls the library list (enabled flags are kept); enable each one individually.
  const libs = await api<Library[]>("POST", "/settings/jellyfin/library/sync");
  for (const lib of libs.filter((l) => !l.enabled)) {
    await api("PUT", `/settings/jellyfin/library/${lib.id}`, { enabled: true });
    ctx.log(`Seerr: enabled library ${lib.name}`);
  }

  const targets = [
    { kind: "radarr", label: "Radarr", dir: "/data/media/movies", want: /HD Bluray \+ WEB/i },
    { kind: "sonarr", label: "Sonarr", dir: "/data/media/tv", want: /WEB-1080p/i },
  ] as const;
  for (const t of targets) {
    if (!ctx.keys[t.kind]) continue;
    const existing = await api<unknown[]>("GET", `/settings/${t.kind}`);
    if (existing.length) continue;
    const there = ctx.internal(t.kind);
    const conn = {
      hostname: there.host,
      port: there.port,
      apiKey: ctx.keys[t.kind],
      useSsl: false,
      baseUrl: "",
    };
    const probe = await api<{ profiles: Profile[] }>("POST", `/settings/${t.kind}/test`, conn);
    const profile = probe.profiles.find((p) => t.want.test(p.name)) ?? probe.profiles[0];
    if (!profile) throw new Error(`${t.label} has no quality profile for Seerr to use`);
    await api("POST", `/settings/${t.kind}`, {
      name: t.label,
      ...conn,
      activeProfileId: profile.id,
      activeProfileName: profile.name,
      activeDirectory: t.dir,
      is4k: false,
      isDefault: true,
      syncEnabled: false,
      preventSearch: false,
      ...(t.kind === "radarr"
        ? { minimumAvailability: "released" }
        : { enableSeasonFolders: true, activeAnimeProfileId: profile.id, activeAnimeDirectory: t.dir }),
    });
    ctx.log(`Seerr: linked ${t.label} (quality profile '${profile.name}')`);
  }
  if (!pub.initialized) {
    await api("POST", "/settings/initialize");
    ctx.log("Seerr: setup marked complete");
  }
}
