// Homeport spike: deploy + auto-wire the core arr stack, headless and idempotent.
// Usage: node wire.mjs [up|down|reset|vpn-test]   (no dependencies, Node 20+; tested on 22)
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
// Docker Compose project name. Override (HP_PROJECT) to run a second copy side by side.
const PROJECT = process.env.HP_PROJECT ?? "homeport-spike";
const envPath = join(dir, ".env");
// Inside mode: this script runs in a container on the stack network and uses service names.
const inside = process.env.HP_INSIDE === "1";
const U = {
  qbit: process.env.HP_VPN === "1" ? "http://gluetun:8080" : "http://qbittorrent:8080",
  sonarr: "http://sonarr:8989",
  radarr: "http://radarr:7878",
  prowlarr: "http://prowlarr:9696",
  jellyfin: "http://jellyfin:8096",
  seerr: "http://seerr:5055",
}; // only used inside the helper container, on the stack network
const log = (m) => console.log(`[homeport] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) =>
  execFileSync("docker", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---- secrets: generated once, persisted to .env ----------------------------
function loadEnv() {
  const env = {};
  if (existsSync(envPath))
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  let changed = false;
  for (const k of ["PROWLARR_KEY", "SONARR_KEY", "RADARR_KEY", "QBIT_PASS", "JELLYFIN_PASS"]) {
    if (!env[k]) {
      env[k] = randomBytes(16).toString("hex");
      changed = true;
    }
  }
  if (changed)
    writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return env;
}

// ---- generic *arr API helper ------------------------------------------------
function arr(base, key, prefix) {
  return async (path, method = "GET", body) => {
    const res = await fetch(`${base}${prefix}${path}`, {
      method,
      headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

async function waitReady(name, call, path) {
  for (let i = 0; i < 90; i++) {
    try {
      await call(path);
      log(`${name} is up`);
      return;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error(`${name} did not become ready`);
}

// Fill a schema's `fields` array from a {name: value} map, leaving defaults alone.
function fill(schema, values) {
  const out = structuredClone(schema);
  for (const f of out.fields) if (f.name in values) f.value = values[f.name];
  return out;
}

// ---- qBittorrent ------------------------------------------------------------
async function qbitLogin(pass) {
  const res = await fetch(`${U.qbit}/api/v2/auth/login`, {
    method: "POST",
    headers: { Referer: U.qbit, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "admin", password: pass }),
  });
  // qBittorrent 4.x answers "Ok." (200); 5.x answers an empty 204.
  const text = await res.text();
  if (!(res.status === 204 || text.trim() === "Ok.")) return null;
  return res.headers.get("set-cookie")?.split(";")[0] ?? null;
}

async function wireQbit(env) {
  // Wait for the web UI to answer at all. Never retry bad logins: qBittorrent bans the IP.
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${U.qbit}/api/v2/app/webapiVersion`);
      break;
    } catch {
      await sleep(2000);
    }
  }
  // Our password first; on a fresh install fall back to the one-time password in the logs.
  let cookie = await qbitLogin(env.QBIT_PASS);
  if (!cookie) {
    if (env.HP_QBIT_TEMP) cookie = await qbitLogin(env.HP_QBIT_TEMP);
  }
  if (!cookie) throw new Error("could not log in to qBittorrent (if banned, restart the container)");
  const prefs = { web_ui_password: env.QBIT_PASS, save_path: "/data/torrents", temp_path_enabled: false };
  const res = await fetch(`${U.qbit}/api/v2/app/setPreferences`, {
    method: "POST",
    headers: { Cookie: cookie, Referer: U.qbit, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ json: JSON.stringify(prefs) }),
  });
  if (!res.ok) throw new Error(`qBittorrent setPreferences -> ${res.status}`);
  log("qBittorrent configured (password set, save path /data/torrents)");
}

// ---- Sonarr / Radarr --------------------------------------------------------
async function wireArr(label, call, { rootPath, categoryField, category }, env) {
  const roots = await call("/rootfolder");
  if (!roots.some((r) => r.path === rootPath)) {
    await call("/rootfolder", "POST", { path: rootPath });
    log(`${label}: added root folder ${rootPath}`);
  }
  // With the VPN overlay qBittorrent lives inside gluetun's network namespace, so its host is "gluetun".
  const qbitHost = process.env.HP_VPN === "1" ? "gluetun" : "qbittorrent";
  const clients = await call("/downloadclient");
  const existing = clients.find((c) => c.name === "qBittorrent");
  if (!existing) {
    const schema = (await call("/downloadclient/schema")).find((s) => s.implementation === "QBittorrent");
    const body = fill(schema, {
      host: qbitHost,
      port: 8080,
      username: "admin",
      password: env.QBIT_PASS,
      [categoryField]: category,
    });
    await call("/downloadclient", "POST", { ...body, name: "qBittorrent", enable: true });
    log(`${label}: added qBittorrent download client`);
  } else if (existing.fields.find((f) => f.name === "host")?.value !== qbitHost) {
    // Reconcile when the user turns the VPN on or off after the first install.
    await call(`/downloadclient/${existing.id}`, "PUT", fill(existing, { host: qbitHost }));
    log(`${label}: download client host -> ${qbitHost}`);
  }
}

// ---- Prowlarr ---------------------------------------------------------------
async function wireProwlarr(call, env) {
  const apps = await call("/applications");
  const schemas = await call("/applications/schema");
  for (const [impl, url, key] of [
    ["Sonarr", "http://sonarr:8989", env.SONARR_KEY],
    ["Radarr", "http://radarr:7878", env.RADARR_KEY],
  ]) {
    if (apps.some((a) => a.name === impl)) continue;
    const schema = schemas.find((s) => s.implementation === impl);
    const body = fill(schema, { prowlarrUrl: "http://prowlarr:9696", baseUrl: url, apiKey: key });
    await call("/applications", "POST", { ...body, name: impl, syncLevel: "fullSync" });
    log(`Prowlarr: linked ${impl}`);
  }
}

// ---- Jellyfin: first-run wizard + libraries -----------------------------------
const JF_AUTH = 'MediaBrowser Client="Homeport", Device="Homeport", DeviceId="homeport-spike", Version="0.1"';

async function jf(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${U.jellyfin}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: token ? `${JF_AUTH}, Token="${token}"` : JF_AUTH,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jellyfin ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function wireJellyfin(env) {
  let info;
  for (let i = 0; i < 90 && !info; i++) {
    try {
      info = await jf("/System/Info/Public");
    } catch {
      await sleep(2000);
    }
  }
  if (!info) throw new Error("Jellyfin did not become ready");
  if (!info.StartupWizardCompleted) {
    await jf("/Startup/Configuration", { method: "POST", body: { UICulture: "en-US", MetadataCountryCode: "US", PreferredMetadataLanguage: "en" } });
    await jf("/Startup/User"); // creates the initial user record the wizard edits
    await jf("/Startup/User", { method: "POST", body: { Name: "homeport", Password: env.JELLYFIN_PASS } });
    await jf("/Startup/RemoteAccess", { method: "POST", body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false } });
    await jf("/Startup/Complete", { method: "POST" });
    log("Jellyfin: finished setup wizard (admin user 'homeport')");
  }
  const auth = await jf("/Users/AuthenticateByName", { method: "POST", body: { Username: "homeport", Pw: env.JELLYFIN_PASS } });
  const token = auth.AccessToken;
  const folders = await jf("/Library/VirtualFolders", { token });
  for (const [name, type, path] of [
    ["Movies", "movies", "/data/media/movies"],
    ["TV Shows", "tvshows", "/data/media/tv"],
  ]) {
    if (folders.some((f) => f.Name === name)) continue;
    await jf(`/Library/VirtualFolders?name=${encodeURIComponent(name)}&collectionType=${type}&refreshLibrary=true`, {
      method: "POST",
      token,
      body: { LibraryOptions: { PathInfos: [{ Path: path }] } },
    });
    log(`Jellyfin: added library ${name} -> ${path}`);
  }
}

// ---- Seerr: sign in with Jellyfin, sync libraries, link Sonarr/Radarr ----------
async function wireSeerr(env, sonarrCall, radarrCall) {
  const base = U.seerr;
  let cookie = "";
  const api = async (path, method = "GET", body) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Seerr ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return text ? JSON.parse(text) : null;
  };
  for (let i = 0; i < 60; i++) {
    try {
      await api("/status");
      break;
    } catch {
      await sleep(2000);
    }
  }
  const pub = await api("/settings/public");
  // The first Jellyfin sign-in on a fresh Seerr also configures the media server and makes this user admin.
  // mediaServerType 4 = not configured yet. Once set, Seerr rejects connection details on login.
  const login = { username: "homeport", password: env.JELLYFIN_PASS };
  await api(
    "/auth/jellyfin",
    "POST",
    pub.mediaServerType === 4
      ? { ...login, hostname: "jellyfin", port: 8096, useSsl: false, urlBase: "", email: "admin@homeport.local", serverType: 2 }
      : login,
  );
  if (!pub.initialized) log("Seerr: connected to Jellyfin, admin user created");

  // Seerr 3.x: sync pulls the library list (enabled flags preserved); enable each one individually.
  const libs = await api("/settings/jellyfin/library/sync", "POST");
  for (const lib of libs.filter((l) => !l.enabled)) {
    await api(`/settings/jellyfin/library/${lib.id}`, "PUT", { enabled: true });
    log(`Seerr: enabled library ${lib.name}`);
  }

  for (const [kind, label, arrCall, host, port, key, dir] of [
    ["radarr", "Radarr", radarrCall, "radarr", 7878, env.RADARR_KEY, "/data/media/movies"],
    ["sonarr", "Sonarr", sonarrCall, "sonarr", 8989, env.SONARR_KEY, "/data/media/tv"],
  ]) {
    const existing = await api(`/settings/${kind}`);
    if (existing.length) continue;
    const conn = { hostname: host, port, apiKey: key, useSsl: false, baseUrl: "" };
    const probe = await api(`/settings/${kind}/test`, "POST", conn);
    // Prefer the profile Recyclarr just created; otherwise the first one the app offers.
    const wanted = kind === "radarr" ? /HD Bluray \+ WEB/i : /WEB-1080p/i;
    const profile = probe.profiles.find((p) => wanted.test(p.name)) ?? probe.profiles[0];
    const body = {
      name: label, ...conn, activeProfileId: profile.id, activeProfileName: profile.name,
      activeDirectory: dir, is4k: false, isDefault: true, syncEnabled: false, preventSearch: false,
      ...(kind === "radarr"
        ? { minimumAvailability: "released" }
        : { enableSeasonFolders: true, activeAnimeProfileId: profile.id, activeAnimeDirectory: dir }),
    };
    await api(`/settings/${kind}`, "POST", body);
    log(`Seerr: linked ${label} (quality profile '${profile.name}')`);
  }
  if (!pub.initialized) {
    await api("/settings/initialize", "POST");
    log("Seerr: setup marked complete");
  }
}

// ---- Recyclarr: TRaSH quality profiles (one-shot container, host side) ---------
function recyclarrSync(env) {
  const cfgDir = join(dir, "recyclarr");
  mkdirSync(join(cfgDir, "configs"), { recursive: true });
  writeFileSync(
    join(cfgDir, "configs", "homeport.yml"),
    [
      "sonarr:",
      "  tv:",
      "    base_url: http://sonarr:8989",
      `    api_key: ${env.SONARR_KEY}`,
      "    quality_definition:",
      "      type: series",
      "    quality_profiles:",
      "      - trash_id: 72dae194fc92bf828f32cde7744e51a1  # WEB-1080p",
      "        reset_unmatched_scores:",
      "          enabled: true",
      "radarr:",
      "  movies:",
      "    base_url: http://radarr:7878",
      `    api_key: ${env.RADARR_KEY}`,
      "    quality_definition:",
      "      type: movie",
      "    quality_profiles:",
      "      - trash_id: d1d67249d3890e49bc12e275d989a7e9  # HD Bluray + WEB",
      "        reset_unmatched_scores:",
      "          enabled: true",
      "",
    ].join("\n"),
  );
  execFileSync(
    "docker",
    ["run", "--rm", "--network", `${PROJECT}_default`, "-v", `${cfgDir}:/config`, "ghcr.io/recyclarr/recyclarr:8", "sync"],
    { stdio: "inherit" },
  );
  log("Recyclarr: TRaSH quality profiles synced");
}

// ---- VPN kill switch / leak check -------------------------------------------------
// Runs from the host. Everything qBittorrent sends leaves through gluetun's namespace.
// Override to point the check at another stack, e.g. HP_GLUETUN=gluetun HP_QBIT=qbittorrent
const GLUETUN = process.env.HP_GLUETUN ?? `${PROJECT}-gluetun-1`;
const QBIT = process.env.HP_QBIT ?? `${PROJECT}-qbittorrent-1`;

async function hostPublicIp() {
  const res = await fetch("https://api.ipify.org");
  return (await res.text()).trim();
}

// Public IP as seen from inside qBittorrent's namespace, or null if it has no route out.
function qbitPublicIp() {
  const r = spawnSync("docker", ["exec", QBIT, "curl", "-s", "--max-time", "8", "https://api.ipify.org"], { encoding: "utf8" });
  const ip = r.stdout.trim();
  return /^[0-9a-f.:]+$/i.test(ip) ? ip : null;
}

function gluetunHealth() {
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", GLUETUN], { encoding: "utf8" });
  return r.stdout.trim() || "missing";
}

async function vpnCheck({ breakTunnel = false } = {}) {
  const results = [];
  const add = (name, ok, detail) => {
    results.push(ok);
    log(`vpn check: ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  };

  // 1. qBittorrent must be inside gluetun's namespace, not on the plain bridge network.
  const mode = spawnSync("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", QBIT], { encoding: "utf8" }).stdout.trim();
  add("qBittorrent shares the VPN container's network", mode === `container:${spawnSync("docker", ["inspect", "-f", "{{.Id}}", GLUETUN], { encoding: "utf8" }).stdout.trim()}`, mode.slice(0, 22));

  // 2. Firewall default policy must drop, so a dead tunnel means no traffic (the kill switch).
  const pol = spawnSync("docker", ["exec", GLUETUN, "iptables", "-S", "OUTPUT"], { encoding: "utf8" }).stdout;
  add("gluetun firewall defaults to DROP", /-P OUTPUT DROP/.test(pol));

  // 3. Either the tunnel is up and the IP differs from ours, or it is down and nothing leaks.
  const health = gluetunHealth();
  const hostIp = await hostPublicIp();
  const seen = qbitPublicIp();
  if (health === "healthy") {
    add("traffic exits through the VPN, not your home IP", seen !== null && seen !== hostIp, `qBittorrent sees ${seen ?? "no route"}`);
  } else {
    add("tunnel is down, so qBittorrent has no internet (fail closed)", seen === null, `gluetun ${health}, qBittorrent sees ${seen ?? "no route"}`);
  }

  // 4. Optional active test: drop the tunnel interface and prove nothing leaks, then restore.
  if (breakTunnel) {
    if (health !== "healthy") {
      log("vpn check: SKIP  tunnel break test needs a connected VPN");
    } else {
      const iface = spawnSync("docker", ["exec", GLUETUN, "sh", "-c", "ip -o link | grep -oE 'tun[0-9]+|wg[0-9]+' | head -1"], { encoding: "utf8" }).stdout.trim();
      spawnSync("docker", ["exec", GLUETUN, "ip", "link", "set", iface, "down"]);
      const leaked = qbitPublicIp();
      spawnSync("docker", ["exec", GLUETUN, "ip", "link", "set", iface, "up"]);
      add(`traffic is blocked while ${iface} is down`, leaked === null, leaked ? `LEAKED via ${leaked}` : "no route");
    }
  }
  return results.every(Boolean);
}

// ---- storage check (first piece of the future "storage checker") ------------
function hardlinkCheck() {
  const out = docker(
    "run", "--rm", "-v", `${PROJECT}_data:/data`, "alpine",
    "sh", "-c",
    "mkdir -p /data/.hp && echo x > /data/.hp/a && ln -f /data/.hp/a /data/.hp/b && stat -c %h /data/.hp/a && rm -rf /data/.hp",
  );
  const ok = out.trim() === "2";
  log(`storage check: hardlinks ${ok ? "WORK" : "FAIL (would fall back to copy mode)"}`);
  return ok;
}

// ---- main -------------------------------------------------------------------
const cmd = process.argv[2] ?? "up";
const files = (vpn) => ["-f", "compose.yaml", ...(vpn ? ["-f", "compose.vpn.yaml"] : [])];
if (cmd === "down") {
  docker("compose", ...files(true), "down");
  log("stack stopped (volumes kept). Use `docker compose down -v` in spike/ to wipe.");
  process.exit(0);
}

const KEYS = ["PROWLARR_KEY", "SONARR_KEY", "RADARR_KEY", "QBIT_PASS", "JELLYFIN_PASS", "HP_QBIT_TEMP"];
const env = inside ? Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) : loadEnv();
// The VPN overlay is on whenever a VPN provider is configured in .env.
const vpnOn = Boolean(env.VPN_SERVICE_PROVIDER);

function fail(msg) {
  console.error(`[homeport] ${msg}`);
  process.exit(1);
}

async function portsInUse(ports) {
  const { createServer } = await import("node:net");
  const busy = [];
  for (const p of ports) {
    await new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => { busy.push(p); resolve(); });
      srv.once("listening", () => srv.close(() => resolve()));
      srv.listen(p, "0.0.0.0");
    });
  }
  return busy;
}

async function preflight() {
  if (Number(process.versions.node.split(".")[0]) < 20) fail(`Node 20 or newer is required (you have ${process.versions.node}).`);
  try { docker("version", "--format", "{{.Server.Version}}"); }
  catch { fail("Docker is not running or not installed. Start Docker Desktop (or the Docker service) and try again."); }
  try { docker("compose", "version"); }
  catch { fail("Docker Compose v2 is required ('docker compose' did not work)."); }
  // Only check ports when this project is not already running (its own containers hold them).
  const running = docker("compose", ...files(vpnOn), "ps", "-q").trim();
  if (!running) {
    const wanted = ["PORT_PROWLARR:19696", "PORT_SONARR:18989", "PORT_RADARR:17878", "PORT_QBIT:18080", "PORT_JELLYFIN:18096", "PORT_SEERR:15055"]
      .map((x) => { const [k, d] = x.split(":"); return Number(process.env[k] ?? env[k] ?? d); });
    const busy = await portsInUse(wanted);
    if (busy.length) fail(`These ports are already in use: ${busy.join(", ")}. Free them, or set PORT_PROWLARR, PORT_SONARR, PORT_RADARR, PORT_QBIT, PORT_JELLYFIN and PORT_SEERR in spike/.env.`);
  }
}

if (cmd === "reset") {
  if (!process.argv.includes("--yes")) {
    console.log(
      [
        "This stops the stack and DELETES its volumes: all app settings, the Jellyfin library database",
        "and anything in the data volume (including downloads). Your .env (generated keys) is kept.",
        "Run again with --yes to confirm:  node wire.mjs reset --yes",
      ].join("\n"),
    );
    process.exit(0);
  }
  docker("compose", ...files(true), "down", "-v", "--remove-orphans");
  log("stack and volumes removed. Run 'node wire.mjs up' for a fresh start.");
  process.exit(0);
}

if (cmd === "vpn-test") {
  // Standalone kill switch check against the running stack. --break-tunnel also drops the tunnel briefly.
  const ok = await vpnCheck({ breakTunnel: process.argv.includes("--break-tunnel") });
  process.exit(ok ? 0 : 1);
}

if (!inside) {
  // Outer phase (host): start the stack, check storage, then run the wiring from a
  // container on the stack network, the same place Homeport itself will live.
  await preflight();
  log(`pulling and starting containers${vpnOn ? " (qBittorrent behind gluetun VPN)" : " (no VPN configured)"}...`);
  docker("compose", ...files(vpnOn), "pull", "--quiet");
  docker("compose", ...files(vpnOn), "up", "-d", "--remove-orphans");

  hardlinkCheck();
  docker(
    "run", "--rm", "-v", `${PROJECT}_data:/data`, "alpine",
    "sh", "-c", "mkdir -p /data/torrents /data/media/tv /data/media/movies && chown -R 1000:1000 /data",
  );

  // qBittorrent prints a one-time admin password (to stderr) on each start.
  let temp = "";
  for (let i = 0; i < 30 && !temp; i++) {
    const r = spawnSync("docker", ["logs", `${PROJECT}-qbittorrent-1`], { encoding: "utf8" });
    temp = [...`${r.stdout}${r.stderr}`.matchAll(/temporary password[^:]*:\s*(\S+)/gi)].pop()?.[1] ?? "";
    if (!temp) await sleep(2000);
  }
  // Only the keys the wiring needs go into the helper container (never the VPN credentials).
  const passVals = { ...Object.fromEntries(KEYS.map((k) => [k, env[k] ?? ""])), HP_QBIT_TEMP: temp, HP_VPN: vpnOn ? "1" : "0" };
  // `-e NAME` (no value) makes docker read it from our environment, so keys never appear in a command line or error.
  const passEnv = Object.keys(passVals).flatMap((k) => ["-e", k]);
  const inner = (phase) =>
    execFileSync(
      "docker",
      ["run", "--rm", "--network", `${PROJECT}_default`, "-v", `${dir}:/work:ro`, "-w", "/work",
        "-e", "HP_INSIDE=1", ...passEnv, "node:22-alpine", "node", "wire.mjs", phase],
      { stdio: "inherit", env: { ...process.env, ...passVals } },
    );
  inner("wire");
  recyclarrSync(env); // needs Sonarr/Radarr up, and must run before Seerr picks a quality profile
  inner("seerr");
  if (vpnOn && !(await vpnCheck())) {
    log("VPN check failed: downloads are NOT safe. Fix the VPN settings before using qBittorrent.");
    process.exit(1);
  }
  log("done. Re-run `node wire.mjs` to prove idempotency (should add nothing).");
  const port = (k, d) => process.env[k] ?? env[k] ?? d;
  log("Open these in your browser:");
  log(`  Jellyfin     http://localhost:${port("PORT_JELLYFIN", 18096)}   (user "homeport", password in .env as JELLYFIN_PASS)`);
  log(`  Seerr        http://localhost:${port("PORT_SEERR", 15055)}   (sign in with the Jellyfin user)`);
  log(`  Sonarr       http://localhost:${port("PORT_SONARR", 18989)}`);
  log(`  Radarr       http://localhost:${port("PORT_RADARR", 17878)}`);
  log(`  Prowlarr     http://localhost:${port("PORT_PROWLARR", 19696)}   (add your own indexers here)`);
  log(`  qBittorrent  http://localhost:${port("PORT_QBIT", 18080)}   (user "admin", password in .env as QBIT_PASS)`);
  process.exit(0);
}

const sonarr = arr(U.sonarr, env.SONARR_KEY, "/api/v3");
const radarr = arr(U.radarr, env.RADARR_KEY, "/api/v3");
const prowlarr = arr(U.prowlarr, env.PROWLARR_KEY, "/api/v1");
await Promise.all([
  waitReady("Sonarr", sonarr, "/system/status"),
  waitReady("Radarr", radarr, "/system/status"),
  waitReady("Prowlarr", prowlarr, "/system/status"),
]);

if (cmd === "wire") {
  await wireQbit(env);
  await wireArr("Sonarr", sonarr, { rootPath: "/data/media/tv", categoryField: "tvCategory", category: "tv" }, env);
  await wireArr("Radarr", radarr, { rootPath: "/data/media/movies", categoryField: "movieCategory", category: "movies" }, env);
  await wireProwlarr(prowlarr, env);
  await wireJellyfin(env);
} else if (cmd === "seerr") {
  await wireSeerr(env, sonarr, radarr);
}


