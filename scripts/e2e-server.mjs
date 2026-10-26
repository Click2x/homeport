// Full-system end-to-end test: runs the real Homeport image against real Docker and drives it only
// through its HTTP API, the way the web interface will.
//   docker build -t homeport:dev .  &&  node scripts/e2e-server.mjs
// Everything it creates (containers, volumes, network) uses its own names and is removed at the end.
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
const image = process.env.HOMEPORT_IMAGE ?? "homeport:dev";
const app = "homeport-e2e-app";
const volume = "homeport-e2e-app-data";
const project = "homeport-e2e-srv";
const base = "http://127.0.0.1:38484";
const sh = (args, opts = {}) => run("docker", args, { env: { ...process.env, MSYS_NO_PATHCONV: "1" }, maxBuffer: 32 * 1024 * 1024, ...opts });
const say = (m) => console.log(`[e2e-server] ${m}`);
let failed = false;
const check = (name, ok, detail = "") => {
  if (!ok) failed = true;
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// AbortSignal timers do not keep Node alive, so a stalled connection could end the script silently.
// A normal timer does.
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

let cookie = "";
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Homeport": "1", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};

/** Watch a job over Server-Sent Events, exactly as the browser will, and return its events. */
async function watch(jobId, onEvent) {
  const res = await fetch(`${base}/api/jobs/${jobId}/events`, { headers: { Cookie: cookie } });
  const events = [];
  let end = null;
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    let i = buffer.indexOf("\n\n");
    while (i >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const type = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (type === "progress" && data) {
        const e = JSON.parse(data);
        events.push(e);
        onEvent(e);
      } else if (type === "end" && data) end = JSON.parse(data);
      i = buffer.indexOf("\n\n");
    }
  }
  return { events, end };
}

const show = (e) => say(`  ${e.status.padEnd(7)} ${e.step.padEnd(9)} ${e.message.split("\n")[0]}`);

async function cleanup() {
  say("cleaning up...");
  await sh(["rm", "-f", app, "hp-e2e-srv-phone"]).catch(() => {});
  await sh(["compose", "-p", project, "down", "-v", "--remove-orphans"]).catch(() => {});
  await sh(["volume", "rm", "-f", volume]).catch(() => {});
  await sh(["volume", "rm", "-f", `${project}_recyclarr-run`]).catch(() => {});
}

try {
  await cleanup();
  say(`starting ${image}...`);
  await sh(["run", "-d", "--name", app, "-p", "127.0.0.1:38484:8484", "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${volume}:/data`, image]);
  let status;
  for (let i = 0; i < 30 && !status; i++) {
    status = await withTimeout(fetch(`${base}/api/status`).then((r) => r.json(), () => null), 2000);
    if (!status) await new Promise((r) => setTimeout(r, 1000));
  }
  check("Homeport starts and answers", Boolean(status?.setupRequired), "setup required on a fresh install");

  const logs = (await sh(["logs", app])).stdout + (await sh(["logs", app])).stderr;
  const code = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(logs)?.[1];
  check("the setup code is printed in the log", Boolean(code));
  const page = await fetch(base + "/").then((r) => r.text(), () => "");
  check("the web interface is served", page.includes('<div id="root">') && page.includes("Homeport"));
  const deep = await fetch(base + "/some/page").then((r) => r.text(), () => "");
  check("unknown pages fall back to the interface (so links and reloads work)", deep.includes('<div id="root">'));
  const unknownApi = await fetch(base + "/api/nope");
  check("an unknown API path answers 404 JSON, not the page", unknownApi.status === 404 || unknownApi.status === 401);
  check("the API is closed before sign-in", (await api("GET", "/api/catalog")).status === 401);
  const bad = await api("POST", "/api/setup", { token: "AAAA-BBBB-CCCC", username: "admin", password: "correct horse battery" });
  check("a wrong setup code is refused", bad.status === 403);
  const good = await api("POST", "/api/setup", { token: code, username: "admin", password: "correct horse battery" });
  check("the right code creates the account and signs in", good.status === 200 && cookie.startsWith("hp_session="));

  const sys = await api("GET", "/api/system");
  check("Homeport can see Docker", sys.json?.docker?.ok === true, `Docker ${sys.json?.docker?.version}`);
  await api("PUT", "/api/settings", { goals: ["watch"], project });
  const plan = await api("GET", "/api/plan");
  check("the plan holds back the download client until a VPN exists", plan.json?.vpn?.hold?.includes("qbittorrent"));

  // ---- deploy 1: no VPN configured ----
  say("deploying (first run downloads images; this can take several minutes)...");
  const start = await api("POST", "/api/deploy");
  check("deploy starts", start.status === 202 && Boolean(start.json?.jobId));
  const first = await watch(start.json.jobId, show);
  check("progress streams live and ends cleanly", first.end?.status === "succeeded", first.end?.summary);
  check("it says downloads are on hold", /on hold/.test(first.end?.summary ?? ""));
  check("the VPN hold was announced as a warning", first.events.some((e) => e.status === "warn" && /VPN/.test(e.message)));

  const stack = (await api("GET", "/api/stack")).json;
  const ports = stack.deployed?.result?.ports ?? {};
  const names = stack.containers.map((c) => c.service).sort();
  check("the apps are running", ["jellyfin", "prowlarr", "radarr", "seerr", "sonarr"].every((n) => names.includes(n)), names.join(", "));
  check("the download client is NOT running", !names.includes("qbittorrent"));
  check("the VPN gateway is not running either, since there are no VPN settings yet", !names.includes("gluetun"));

  // The real proof: ask the apps themselves.
  const env = (await sh(["exec", app, "cat", "/data/stack/.env"])).stdout;
  const key = (name) => new RegExp(`${name}='([^']+)'`).exec(env)?.[1];
  const sonarrPort = ports.sonarr?.web;
  const sonarr = (path) => fetch(`http://127.0.0.1:${sonarrPort}${path}`, { headers: { "X-Api-Key": key("SONARR_KEY") }, signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  const roots = await sonarr("/api/v3/rootfolder").catch(() => []);
  check("Sonarr has its library folder", roots.some((r) => r.path === "/data/media/tv"), `port ${sonarrPort}`);
  const clients = await sonarr("/api/v3/downloadclient").catch(() => null);
  check("Sonarr has no download client while downloads are on hold", Array.isArray(clients) && clients.length === 0);
  const seerr = await fetch(`http://127.0.0.1:${ports.seerr?.web}/api/v1/settings/public`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json(), () => ({}));
  check("Seerr is set up and connected to Jellyfin", seerr.initialized === true);
  const prowlarr = await fetch(`http://127.0.0.1:${ports.prowlarr?.web}/api/v1/applications`, { headers: { "X-Api-Key": key("PROWLARR_KEY") }, signal: AbortSignal.timeout(10000) }).then((r) => r.json(), () => []);
  check("Prowlarr is linked to Sonarr and Radarr", prowlarr.length === 2);
  const exported = (await api("GET", "/api/compose")).text;
  const generated = ["SONARR_KEY", "RADARR_KEY", "PROWLARR_KEY"].map(key);
  check(
    "the compose export has placeholders, not the real keys",
    generated.every((k) => k && !exported.includes(k)) && exported.includes("${SONARR_KEY}"),
  );

  // ---- deploy 2: a VPN that cannot connect ----
  say("saving a VPN that cannot connect, then deploying again...");
  const kp = () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const b64 = (s) => Buffer.from(s, "base64url").toString("base64");
    return { priv: b64(privateKey.export({ format: "jwk" }).d), pub: b64(publicKey.export({ format: "jwk" }).x) };
  };
  const [mine, theirs] = [kp(), kp()];
  const saved = await api("PUT", "/api/vpn", {
    values: {
      VPN_SERVICE_PROVIDER: "custom",
      VPN_TYPE: "wireguard",
      WIREGUARD_PRIVATE_KEY: mine.priv,
      WIREGUARD_PUBLIC_KEY: theirs.pub,
      WIREGUARD_ENDPOINT_IP: "192.0.2.1",
      WIREGUARD_ENDPOINT_PORT: "51820",
      WIREGUARD_ADDRESSES: "10.64.222.21/32",
    },
  });
  check("VPN settings are saved without echoing the secret", saved.status === 200 && !saved.text.includes(mine.priv));
  const second = await api("POST", "/api/deploy");
  const again = await watch(second.json.jobId, show);
  check("the second deploy finishes", again.end?.status === "succeeded");
  check("the broken VPN is reported in plain words", again.events.some((e) => /VPN is not working yet/.test(e.message)));
  const names2 = (await api("GET", "/api/stack")).json.containers.map((c) => c.service);
  check("the gateway is running but the download client is still off", names2.includes("gluetun") && !names2.includes("qbittorrent"), names2.join(", "));
  const vpn = (await api("GET", "/api/vpn")).json;
  check("the VPN is not marked verified", vpn.verified === false && vpn.downloadsOnHold === true);

  // ---- remote access: a real phone-like client through a real tunnel ----
  say("turning on remote access and connecting a real WireGuard client...");
  const on = await api("PUT", "/api/remote", { enabled: true, endpoint: "203.0.113.9", port: 41820 });
  check("remote access can be switched on", on.status === 200 && on.json?.needsApply === true, "needs an install to start");
  const third = await api("POST", "/api/deploy");
  const withRemote = await watch(third.json.jobId, show);
  check("the install adds the gateway", withRemote.end?.status === "succeeded" && withRemote.events.some((e) => e.step === "remote"));
  const sidecar = `${project}-wireguard-1`;
  const published = (await sh(["port", sidecar])).stdout;
  check(
    "the tunnel port is published on this computer over UDP",
    /51820\/udp -> .*:41820/.test(published),
    published.trim().split("\n")[0],
  );
  const view = (await api("GET", "/api/remote")).json;
  check("remote access reports it is running", view.live === true && view.needsApply === false);
  const jellyfinShare = view.shareable.find((x) => x.id === "jellyfin");
  const invite = await api("POST", "/api/remote/people", { name: "E2E phone", services: ["jellyfin"] });
  check("an invitation produces a file and a QR code", invite.status === 201 && invite.json?.config?.includes("[Interface]") && invite.json?.qr?.includes("<svg"));
  check("the invitation is already active on the gateway", invite.json?.applied === true);

  // Connect like a phone would, using only what Homeport gave us (the endpoint is the one thing a router would translate).
  const net = `${project}_default`;
  const sidecarIp = (await sh(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, sidecar])).stdout.trim();
  const phoneConf = invite.json.config.replace(/Endpoint = .*/, `Endpoint = ${sidecarIp}:51820`);
  await sh(["run", "-d", "--name", "hp-e2e-srv-phone", "--cap-add", "NET_ADMIN", "--network", net, "--entrypoint", "sleep", "homeport-wireguard:local", "3600"]);
  await new Promise((resolve, reject) => {
    const p = execFile("docker", ["exec", "-i", "hp-e2e-srv-phone", "sh", "-c", "cat > /tmp/c.conf"], (e) => (e ? reject(e) : resolve()));
    p.stdin.end(phoneConf);
  });
  await sh(["exec", "hp-e2e-srv-phone", "wg-quick", "up", "/tmp/c.conf"]);
  const reach = async (port) => {
    for (let i = 0; i < 12; i++) {
      const r = await sh(["exec", "hp-e2e-srv-phone", "wget", "-qO-", "-T", "4", `http://10.13.13.1:${port}/${port === 8096 ? "System/Info/Public" : ""}`]).then((x) => x.stdout, () => null);
      if (r) return r;
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    return null;
  };
  const jf = await reach(jellyfinShare.port);
  check("the phone reaches Jellyfin through the tunnel Homeport set up", Boolean(jf?.includes("Jellyfin")), jf ? "got Jellyfin's public info" : "no answer");
  const sonarrDenied = await sh(["exec", "hp-e2e-srv-phone", "wget", "-qO-", "-T", "4", "http://10.13.13.1:8989/"]).then(() => false, () => true);
  check("...but not Sonarr, which was not given to them", sonarrDenied);
  await new Promise((r) => setTimeout(r, 2000));
  const online = (await api("GET", "/api/remote")).json.people[0];
  check("the interface shows them as connected", online?.online === true, online?.lastSeen ?? "");
  await api("DELETE", `/api/remote/people/${online.id}`);
  await new Promise((r) => setTimeout(r, 2500));
  const afterRevoke = await sh(["exec", "hp-e2e-srv-phone", "wget", "-qO-", "-T", "4", `http://10.13.13.1:${jellyfinShare.port}/System/Info/Public`]).then(() => false, () => true);
  check("revoking the invitation cuts the phone off", afterRevoke);

  // ---- replay after the fact ----
  const replay = await watch(second.json.jobId, () => {});
  check("a finished job's progress can be replayed", replay.events.length === again.events.length);
} catch (e) {
  failed = true;
  console.error(`[e2e-server] ERROR ${e instanceof Error ? (e.stack ?? e.message) : e}`);
} finally {
  await cleanup();
}
say(failed ? "FAILED" : "ALL PASSED");
process.exit(failed ? 1 : 0);
