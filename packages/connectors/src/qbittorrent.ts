import { type WireContext, wait } from "./context.js";

/**
 * qBittorrent answers a good login with 204 (5.x) or "Ok." (4.x). It bans an address after several
 * bad logins, so we try at most two passwords and never loop on failures.
 */
async function login(ctx: WireContext, base: string, password: string): Promise<string | null> {
  const f = ctx.fetch ?? fetch;
  const res = await f(`${base}/api/v2/auth/login`, {
    method: "POST",
    headers: { Referer: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password }),
  });
  const text = await res.text();
  if (!(res.status === 204 || text.trim() === "Ok.")) return null;
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

export async function wireQbittorrent(ctx: WireContext): Promise<void> {
  const f = ctx.fetch ?? fetch;
  const base = ctx.url("qbittorrent");
  for (let i = 0; i < 60; i++) {
    try {
      await f(`${base}/api/v2/app/webapiVersion`);
      break;
    } catch {
      await wait(ctx, 2000);
    }
  }
  let cookie = await login(ctx, base, ctx.qbittorrent.password);
  if (cookie === null && ctx.qbittorrent.firstRunPassword)
    cookie = await login(ctx, base, ctx.qbittorrent.firstRunPassword);
  if (cookie === null)
    throw new Error(
      "Could not sign in to qBittorrent. If it banned this address, restart its container and try again.",
    );

  const prefs = {
    web_ui_password: ctx.qbittorrent.password,
    save_path: "/data/torrents",
    temp_path_enabled: false,
  };
  const res = await f(`${base}/api/v2/app/setPreferences`, {
    method: "POST",
    headers: { Cookie: cookie, Referer: base, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ json: JSON.stringify(prefs) }),
  });
  if (!res.ok) throw new Error(`qBittorrent refused its settings (${res.status})`);
  ctx.log("qBittorrent: password set, downloads go to /data/torrents");
}
