// End-to-end test of remote access on REAL containers: the real sidecar, real WireGuard clients, real
// traffic. It proves that people reach only the apps chosen for them, that a modified client cannot
// reach anything else, that revoking someone cuts them off without disturbing others, and that it all
// survives a restart. The "apps" are tiny stand-in web servers on the same network.
//   npm run build && node scripts/e2e-wireguard.mjs
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadCatalog } from "../packages/core/dist/index.js";
import {
  applyWireguard,
  checkDocker,
  composeDown,
  composeToYaml,
  composeUp,
  containerName,
  docker,
  ensureWireguardImage,
  generateCompose,
  generateKeyPair,
  networkName,
  renderPeerConf,
  renderRulesScript,
  renderServerConf,
  WG_IMAGE,
  wireguardStatus,
  writeProject,
} from "../packages/engine/dist/index.js";

const run = promisify(execFile);
const project = "homeport-e2e-wg";
const net = networkName(project);
const standIns = ["hp-e2e-wg-jellyfin", "hp-e2e-wg-sonarr"];
const clients = ["hp-e2e-wg-client-a", "hp-e2e-wg-client-b", "hp-e2e-wg-client-c"];
const say = (m) => console.log(`[e2e-wg] ${m}`);
let failed = false;
const check = (name, ok, detail = "") => {
  if (!ok) failed = true;
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sh = (args, opts) => run("docker", args, { maxBuffer: 16 * 1024 * 1024, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch a URL from inside a client container; resolves to the body, or null if it could not connect. */
const fetchVia = async (client, url, seconds = 4) =>
  sh(["exec", client, "wget", "-qO-", "-T", String(seconds), url]).then(
    (r) => r.stdout.trim(),
    () => null,
  );
/** Retry while a tunnel is still doing its first handshake. */
const eventually = async (fn, tries = 12) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  return null;
};

async function cleanup(proj) {
  say("cleaning up...");
  for (const c of [...clients, ...standIns]) await sh(["rm", "-f", c]).catch(() => {});
  if (proj) await composeDown(proj, { volumes: true }).catch(() => {});
  await sh(["network", "rm", net]).catch(() => {});
}

const problem = await checkDocker();
if (problem) {
  console.error(problem);
  process.exit(1);
}

const catalog = loadCatalog();
const proj = { dir: mkdtempSync(join(tmpdir(), "homeport-e2e-wg-")), project };
const services = [
  { id: "jellyfin", port: 8096 },
  { id: "sonarr", port: 8989 },
];

// A hung step must never leave containers behind or block forever.
const watchdog = setTimeout(async () => {
  console.error("[e2e-wg] TIMEOUT: a step took too long");
  await cleanup(proj);
  process.exit(2);
}, 6 * 60_000);

try {
  await cleanup(proj);
  say("building the sidecar image (first time only)...");
  const contextDir = fileURLToPath(new URL("../docker/wireguard", import.meta.url));
  await ensureWireguardImage(contextDir);

  const plan = {
    project,
    apps: ["wireguard"],
    vpn: false,
    hostPorts: { wireguard: { tunnel: 38820 } },
    timezone: "UTC",
    puid: 1000,
    pgid: 1000,
    data: { mode: "volume" },
  };
  const yaml = composeToYaml(generateCompose(catalog, plan));
  check("the generated compose gives the sidecar NET_ADMIN, IP forwarding and a UDP port", /NET_ADMIN/.test(yaml) && /ip_forward/.test(yaml) && /38820:51820\/udp/.test(yaml));
  await writeProject(proj, yaml, "\n");
  await composeUp(proj);

  // Stand-in apps on the same network, reachable by name like the real ones.
  for (const [name, alias, port] of [
    [standIns[0], "jellyfin", 8096],
    [standIns[1], "sonarr", 8989],
  ]) {
    await sh(["run", "-d", "--name", name, "--network", net, "--network-alias", alias, "alpine", "sh", "-c", `while true; do printf 'HTTP/1.1 200 OK\r\nContent-Length: ${alias.length + 3}\r\nConnection: close\r\n\r\n${alias}-ok' | nc -l -p ${port}; done`]);
  }

  // Server and two people: A may open only "jellyfin"; B may open both.
  const server = generateKeyPair();
  const a = generateKeyPair();
  const b = generateKeyPair();
  const peers = [
    { id: "a", name: "A", publicKey: a.publicKey, ip: "10.13.13.2", services: ["jellyfin"], createdAt: "", expiresAt: null },
    { id: "b", name: "B", publicKey: b.publicKey, ip: "10.13.13.3", services: ["jellyfin", "sonarr"], createdAt: "", expiresAt: null },
  ];
  const apply = (list) => applyWireguard(project, renderServerConf({ privateKey: server.privateKey, port: 51820 }, list), renderRulesScript(list, services));
  await apply(peers);

  const sidecarIp = (await sh(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, containerName(project, "wireguard")])).stdout.trim();
  const sonarrIp = (await sh(["inspect", "-f", `{{(index .NetworkSettings.Networks "${net}").IPAddress}}`, standIns[1]])).stdout.trim();
  check("the sidecar is running on the project network", /^\d+\.\d+\.\d+\.\d+$/.test(sidecarIp), sidecarIp);

  const startClient = async (name, privateKey, address, extraAllowed = "") => {
    let conf = renderPeerConf({ privateKey, address, serverPublicKey: server.publicKey, endpoint: sidecarIp, port: 51820 });
    if (extraAllowed) conf = conf.replace("AllowedIPs = 10.13.13.1/32", `AllowedIPs = 10.13.13.1/32, ${extraAllowed}`);
    await sh(["run", "-d", "--name", name, "--cap-add", "NET_ADMIN", "--network", net, "--entrypoint", "sleep", WG_IMAGE, "3600"]);
    await new Promise((resolve, reject) => {
      const p = execFile("docker", ["exec", "-i", name, "sh", "-c", "cat > /tmp/c.conf"], (e) => (e ? reject(e) : resolve()));
      p.stdin.end(conf);
    });
    await sh(["exec", name, "wg-quick", "up", "/tmp/c.conf"]);
  };
  await startClient(clients[0], a.privateKey, "10.13.13.2");
  await startClient(clients[1], b.privateKey, "10.13.13.3");

  // ---- reachability ----
  const aJelly = await eventually(() => fetchVia(clients[0], "http://10.13.13.1:8096/"));
  check("person A can open the app they were given, through the tunnel", aJelly === "jellyfin-ok", String(aJelly));
  check("person A cannot open an app they were not given", (await fetchVia(clients[0], "http://10.13.13.1:8989/")) === null);
  const bBoth = [await eventually(() => fetchVia(clients[1], "http://10.13.13.1:8096/")), await eventually(() => fetchVia(clients[1], "http://10.13.13.1:8989/"))];
  check("person B can open both of theirs", bBoth[0] === "jellyfin-ok" && bBoth[1] === "sonarr-ok", bBoth.join(", "));

  // ---- a person who edits their own file to reach more ----
  await startClient(clients[2], a.privateKey, "10.13.13.2", `${sonarrIp}/32`).catch(() => {});
  // clients[2] shares A's key, so stop A while testing it (one key, one endpoint at a time).
  await sh(["exec", clients[0], "wg-quick", "down", "/tmp/c.conf"]);
  await sleep(1000);
  const direct = await fetchVia(clients[2], `http://${sonarrIp}:8989/`, 4);
  check("a modified client file cannot reach another app directly through the tunnel", direct === null, String(direct));
  const viaGate = await fetchVia(clients[2], "http://10.13.13.1:8989/", 4);
  check("...nor through the gateway address", viaGate === null, String(viaGate));
  await sh(["rm", "-f", clients[2]]);
  await sh(["exec", clients[0], "wg-quick", "up", "/tmp/c.conf"]);

  // ---- status ----
  await eventually(() => fetchVia(clients[0], "http://10.13.13.1:8096/"));
  const status = await wireguardStatus(project);
  const seen = (key) => status.find((s) => s.publicKey === key)?.latestHandshake;
  check("the status shows both people have connected", Boolean(seen(a.publicKey)) && Boolean(seen(b.publicKey)));

  // ---- revoke A without disturbing B ----
  await apply([peers[1]]);
  await sleep(2000);
  check("a revoked person is cut off", (await fetchVia(clients[0], "http://10.13.13.1:8096/", 4)) === null);
  check("everyone else keeps working", (await fetchVia(clients[1], "http://10.13.13.1:8096/")) === "jellyfin-ok");

  // ---- changing someone's apps takes effect ----
  await apply([{ ...peers[1], services: ["jellyfin"] }]);
  await sleep(1500);
  check("taking an app away from someone closes it for them", (await fetchVia(clients[1], "http://10.13.13.1:8989/", 4)) === null);
  check("...and leaves their other app open", (await fetchVia(clients[1], "http://10.13.13.1:8096/")) === "jellyfin-ok");

  // ---- survives a restart ----
  await sh(["restart", containerName(project, "wireguard")]);
  const after = await eventually(() => fetchVia(clients[1], "http://10.13.13.1:8096/", 3), 25);
  check("the tunnel and its rules come back by themselves after a restart", after === "jellyfin-ok", String(after));
  check("the rules after a restart still block what was taken away", (await fetchVia(clients[1], "http://10.13.13.1:8989/", 3)) === null);
} catch (e) {
  failed = true;
  console.error(`[e2e-wg] ERROR ${e instanceof Error ? e.stack : e}${e?.detail ? `\n${e.detail}` : ""}${e?.stderr ? `\n${e.stderr}` : ""}`);
} finally {
  if (process.env.E2E_KEEP) say("E2E_KEEP set: leaving containers running for inspection");
  else await cleanup(proj);
}
clearTimeout(watchdog);
say(failed ? "FAILED" : "ALL PASSED");
process.exit(failed ? 1 : 0);
