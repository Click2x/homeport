// biome-ignore-all lint/suspicious/noExplicitAny: a fake server parsing arbitrary JSON bodies
import type { WireContext } from "../src/index.js";

/**
 * An in-memory stand-in for the whole stack, so the wiring can be tested without Docker.
 * It mimics the behaviour we learned from the real apps (for example: qBittorrent 5.x answers a good
 * login with an empty 204 and bans after repeated failures; Seerr rejects connection details once
 * a media server is saved).
 */
const PORTS: Record<string, number> = {
  sonarr: 8989,
  radarr: 7878,
  prowlarr: 9696,
  qbittorrent: 8080,
  jellyfin: 8096,
  seerr: 5055,
};

export const KEYS = { sonarr: "key-sonarr", radarr: "key-radarr", prowlarr: "key-prowlarr" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const empty = (status = 204, headers: Record<string, string> = {}) => new Response(null, { status, headers });

export function fakeStack(opts: { qbitFirstRunPassword?: string } = {}) {
  const qbit = { password: opts.qbitFirstRunPassword ?? "adminadmin", failedLogins: 0, savePath: "" };
  const arrState = {
    sonarr: { roots: [] as { path: string }[], clients: [] as Record<string, unknown>[] },
    radarr: { roots: [] as { path: string }[], clients: [] as Record<string, unknown>[] },
  };
  const prowlarr = { apps: [] as { name: string }[] };
  const jellyfin = {
    wizardDone: false,
    user: "",
    libraries: [] as { Name: string }[],
    wizardRuns: 0,
  };
  const seerr = {
    mediaServerType: 4,
    initialized: false,
    libs: [
      { id: "m", name: "Movies", enabled: false },
      { id: "t", name: "TV Shows", enabled: false },
    ],
    radarr: [] as unknown[],
    sonarr: [] as unknown[],
    loginBodies: [] as Record<string, unknown>[],
  };
  const requests: string[] = [];

  const clientSchema = (kind: "sonarr" | "radarr") => [
    {
      implementation: "QBittorrent",
      fields: [
        { name: "host" },
        { name: "port" },
        { name: "username" },
        { name: "password" },
        { name: kind === "sonarr" ? "tvCategory" : "movieCategory" },
        { name: "useSsl", value: false },
      ],
    },
  ];

  const handleArr = (kind: "sonarr" | "radarr", req: Request, path: string, body: any): Response => {
    if (req.headers.get("X-Api-Key") !== KEYS[kind]) return json({ error: "Unauthorized" }, 401);
    const s = arrState[kind];
    if (path === "/api/v3/system/status") return json({ version: "x" });
    if (path === "/api/v3/rootfolder") {
      if (req.method === "POST") {
        s.roots.push({ path: body.path });
        return json(body, 201);
      }
      return json(s.roots);
    }
    if (path === "/api/v3/downloadclient/schema") return json(clientSchema(kind));
    if (path === "/api/v3/downloadclient") {
      if (req.method === "POST") {
        s.clients.push({ ...body, id: s.clients.length + 1 });
        return json(body, 201);
      }
      return json(s.clients);
    }
    const put = path.match(/^\/api\/v3\/downloadclient\/(\d+)$/);
    if (put && req.method === "PUT") {
      const i = s.clients.findIndex((c) => c.id === Number(put[1]));
      s.clients[i] = body;
      return json(body);
    }
    return json({ error: `unhandled ${req.method} ${path}` }, 404);
  };

  const handleProwlarr = (req: Request, path: string, body: any): Response => {
    if (req.headers.get("X-Api-Key") !== KEYS.prowlarr) return json({ error: "Unauthorized" }, 401);
    if (path === "/api/v1/system/status") return json({ version: "x" });
    if (path === "/api/v1/applications/schema")
      return json(
        ["Sonarr", "Radarr"].map((implementation) => ({
          implementation,
          fields: [{ name: "prowlarrUrl" }, { name: "baseUrl" }, { name: "apiKey" }],
        })),
      );
    if (path === "/api/v1/applications") {
      if (req.method === "POST") {
        prowlarr.apps.push({ name: body.name });
        return json(body, 201);
      }
      return json(prowlarr.apps);
    }
    return json({ error: `unhandled ${req.method} ${path}` }, 404);
  };

  const handleQbit = async (req: Request, path: string): Promise<Response> => {
    if (path === "/api/v2/app/webapiVersion") return new Response("2.11", { status: 403 });
    if (path === "/api/v2/auth/login") {
      const form = new URLSearchParams(await req.text());
      if (qbit.failedLogins >= 5) return new Response("banned", { status: 403 });
      if (form.get("password") === qbit.password) return empty(204, { "set-cookie": "SID=abc; HttpOnly" });
      qbit.failedLogins++;
      return new Response("Unauthorized", { status: 401 });
    }
    if (path === "/api/v2/app/setPreferences") {
      if (req.headers.get("Cookie") !== "SID=abc") return new Response("Forbidden", { status: 403 });
      const prefs = JSON.parse(new URLSearchParams(await req.text()).get("json") ?? "{}");
      qbit.password = prefs.web_ui_password ?? qbit.password;
      qbit.savePath = prefs.save_path ?? qbit.savePath;
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const handleJellyfin = (req: Request, path: string, body: any): Response => {
    const bare = path.split("?")[0] ?? path;
    if (bare === "/System/Info/Public") return json({ StartupWizardCompleted: jellyfin.wizardDone });
    if (bare.startsWith("/Startup/")) {
      if (jellyfin.wizardDone) return json({ error: "wizard already completed" }, 401);
      if (bare === "/Startup/User" && req.method === "POST") jellyfin.user = body.Name;
      if (bare === "/Startup/Complete") {
        jellyfin.wizardDone = true;
        jellyfin.wizardRuns++;
      }
      return bare === "/Startup/User" && req.method === "GET" ? json({ Name: "" }) : empty();
    }
    if (bare === "/Users/AuthenticateByName")
      return body.Username === jellyfin.user
        ? json({ AccessToken: "jf-token" })
        : json({ error: "bad login" }, 401);
    if (bare === "/Library/VirtualFolders") {
      if (!req.headers.get("Authorization")?.includes('Token="jf-token"'))
        return json({ error: "no auth" }, 401);
      if (req.method === "POST") {
        jellyfin.libraries.push({ Name: new URL(`http://x${path}`).searchParams.get("name") ?? "" });
        return empty();
      }
      return json(jellyfin.libraries);
    }
    return json({ error: `unhandled ${req.method} ${path}` }, 404);
  };

  const handleSeerr = (req: Request, path: string, body: any): Response => {
    if (path === "/api/v1/status") return json({ version: "3.5.0" });
    if (path === "/api/v1/settings/public")
      return json({ initialized: seerr.initialized, mediaServerType: seerr.mediaServerType });
    if (path === "/api/v1/auth/jellyfin") {
      seerr.loginBodies.push(body);
      if (seerr.mediaServerType !== 4 && body.hostname)
        return json({ error: "Jellyfin hostname already configured" }, 500);
      seerr.mediaServerType = 2;
      return json({ id: 1 }, 200, { "set-cookie": "connect.sid=s1; Path=/" });
    }
    if (req.headers.get("Cookie") !== "connect.sid=s1") return json({ error: "not signed in" }, 403);
    if (path === "/api/v1/settings/jellyfin/library/sync") return json(seerr.libs);
    const lib = path.match(/^\/api\/v1\/settings\/jellyfin\/library\/(\w+)$/);
    if (lib && req.method === "PUT") {
      const l = seerr.libs.find((x) => x.id === lib[1]);
      if (l) l.enabled = body.enabled;
      return json(seerr.libs);
    }
    const target = path.match(/^\/api\/v1\/settings\/(radarr|sonarr)(\/test)?$/);
    if (target) {
      const kind = target[1] as "radarr" | "sonarr";
      if (target[2])
        return json({
          profiles: [
            { id: 1, name: "Any" },
            { id: 2, name: kind === "radarr" ? "HD Bluray + WEB" : "WEB-1080p" },
          ],
        });
      if (req.method === "POST") {
        seerr[kind].push(body);
        return json(body, 201);
      }
      return json(seerr[kind]);
    }
    if (path === "/api/v1/settings/initialize") {
      seerr.initialized = true;
      return json({ initialized: true });
    }
    return json({ error: `unhandled ${req.method} ${path}` }, 404);
  };

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    requests.push(`${req.method} ${url.host}${path}`);
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    switch (url.hostname) {
      case "sonarr":
        return handleArr("sonarr", req, url.pathname, body);
      case "radarr":
        return handleArr("radarr", req, url.pathname, body);
      case "prowlarr":
        return handleProwlarr(req, url.pathname, body);
      case "qbittorrent":
      case "gluetun":
        return handleQbit(req, url.pathname);
      case "jellyfin":
        return handleJellyfin(req, path, body);
      case "seerr":
        return handleSeerr(req, url.pathname, body);
      default:
        throw new Error(`connection refused: ${url.host}`);
    }
  }) as typeof globalThis.fetch;

  const logs: string[] = [];
  const context = (opts2: { vpn?: boolean; firstRunPassword?: string } = {}): WireContext => ({
    url: (id) => `http://${id === "qbittorrent" && opts2.vpn ? "gluetun" : id}:${PORTS[id]}`,
    internal: (id) => ({ host: id === "qbittorrent" && opts2.vpn ? "gluetun" : id, port: PORTS[id] ?? 0 }),
    keys: { ...KEYS },
    qbittorrent: {
      password: "homeport-qbit-password",
      firstRunPassword: opts2.firstRunPassword ?? opts.qbitFirstRunPassword,
    },
    jellyfin: { adminUser: "homeport", adminPassword: "homeport-jf-password" },
    log: (m) => logs.push(m),
    fetch,
    sleep: async () => {},
  });

  return { state: { qbit, arrState, prowlarr, jellyfin, seerr }, requests, logs, context };
}
