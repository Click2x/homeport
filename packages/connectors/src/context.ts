/**
 * Everything a connector needs to know about the running stack. Connectors never touch Docker or the
 * plan directly, which keeps them easy to test against a fake server.
 */
export interface WireContext {
  /** Base URL of an app as reachable from where Homeport runs, e.g. http://sonarr:8989. */
  url(appId: string): string;
  /** How another container reaches an app (the gateway for apps behind the VPN). */
  internal(appId: string): { host: string; port: number };
  /** Generated API keys for the apps that take one, keyed by app id. */
  keys: Record<string, string>;
  qbittorrent: {
    /** Password Homeport sets and uses from now on. */
    password: string;
    /** One-time password printed by a fresh container, used only to log in the first time. */
    firstRunPassword?: string;
  };
  jellyfin: { adminUser: string; adminPassword: string };
  log(message: string): void;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  sleep?(ms: number): Promise<void>;
}

export const wait = (ctx: WireContext, ms: number) =>
  ctx.sleep ? ctx.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
