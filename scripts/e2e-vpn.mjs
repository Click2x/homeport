// End-to-end test of the VPN gate's FAIL-CLOSED behaviour on real containers, with a dummy tunnel that
// can never connect. It proves that a download client behind a dead VPN is reported unsafe and has no
// route to the internet. (A connected tunnel needs real provider credentials, so it is not covered here.)
//   npm run build && node scripts/e2e-vpn.mjs
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadCatalog } from "../packages/core/dist/index.js";
import {
  DEFAULT_CONFIG,
  checkDocker,
  checkVpn,
  composeDown,
  composeToYaml,
  composeUp,
  containerName,
  decideVpn,
  docker,
  generateCompose,
  writeProject,
} from "../packages/engine/dist/index.js";

const run = promisify(execFile);
const project = process.env.E2E_PROJECT ?? "homeport-e2e-vpn";
const say = (m) => console.log(`[e2e-vpn] ${m}`);
let failed = false;
const check = (name, ok, detail = "") => {
  if (!ok) failed = true;
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const problem = await checkDocker();
if (problem) {
  console.error(problem);
  process.exit(1);
}

const catalog = loadCatalog();
const selected = ["qbittorrent"];
const base = {
  project,
  apps: selected,
  vpn: true,
  hostPorts: { qbittorrent: { web: 38081 } },
  timezone: "UTC",
  puid: 1000,
  pgid: 1000,
  data: { mode: "volume" },
};
const proj = { dir: mkdtempSync(join(tmpdir(), "homeport-e2e-vpn-")), project };
// Throwaway WireGuard keys made now, and a TEST-NET address: valid in form, but they can never connect.
const b64 = (s) => Buffer.from(s, "base64url").toString("base64");
const keypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { priv: b64(privateKey.export({ format: "jwk" }).d), pub: b64(publicKey.export({ format: "jwk" }).x) };
};
const [mine, theirs] = [keypair(), keypair()];
const dotEnv = [
  "VPN_SERVICE_PROVIDER=custom",
  "VPN_TYPE=wireguard",
  `WIREGUARD_PRIVATE_KEY=${mine.priv}`,
  `WIREGUARD_PUBLIC_KEY=${theirs.pub}`,
  "WIREGUARD_ENDPOINT_IP=192.0.2.1",
  "WIREGUARD_ENDPOINT_PORT=51820",
  "WIREGUARD_ADDRESSES=10.64.222.21/32",
  "",
].join("\n");
const deploy = async (plan) => {
  await writeProject(proj, composeToYaml(generateCompose(catalog, plan)), dotEnv);
  await composeUp(proj);
};
const waitSettled = async () => {
  for (let i = 0; i < 30; i++) {
    const h = (await docker(["inspect", "-f", "{{.State.Health.Status}}", containerName(project, "gluetun")])).trim();
    if (h !== "starting") return h;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return "starting";
};

try {
  say("policy: VPN settings entered but not verified yet");
  const decision = decideVpn(catalog, selected, DEFAULT_CONFIG, { configured: true, verified: false });
  check("download client is held until the VPN is verified", decision.hold.includes("qbittorrent"));

  say("starting ONLY the gateway (download client held back)...");
  await deploy({ ...base, hold: decision.hold });
  const health = await waitSettled();
  check("gateway cannot connect with the dummy tunnel", health !== "healthy", health);
  const names = {};
  const gatewayOnly = await checkVpn(project, names);
  check("gateway-only check reports NOT safe", gatewayOnly.safe === false);
  const clientExists = await docker(["inspect", containerName(project, "qbittorrent")]).then(
    () => true,
    () => false,
  );
  check("the download client does not exist yet", !clientExists);

  say("releasing the hold anyway, to prove the kill switch holds with a client attached...");
  await deploy({ ...base, hold: [] });
  const withClient = await checkVpn(project, names);
  const by = (id) => withClient.checks.find((c) => c.id === id);
  check("full check reports NOT safe", withClient.safe === false);
  check("kill switch is in place", by("kill-switch")?.status === "pass");
  check("download client is behind the gateway", by("client")?.status === "pass");
  check("the tunnel is reported as down in plain words", /not connected/.test(by("tunnel")?.summary ?? ""));

  // The decisive test: the client really has no way out.
  const viaClient = await run("docker", ["exec", containerName(project, "qbittorrent"), "curl", "-s", "--max-time", "8", "https://api.ipify.org"]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  check("download client has no internet while the VPN is down", viaClient === "", viaClient || "no route");
  const control = await run("docker", ["run", "--rm", "curlimages/curl", "-s", "--max-time", "8", "https://api.ipify.org"]).then(
    (r) => r.stdout.trim(),
    () => "",
  );
  check("control: a container outside the VPN does have internet", control !== "", "so the test is meaningful");
} catch (e) {
  failed = true;
  console.error(`[e2e-vpn] ERROR ${e instanceof Error ? e.message : e}${e?.detail ? `\n${e.detail}` : ""}`);
} finally {
  say("tearing down...");
  await composeDown(proj, { volumes: true }).catch((e) => console.error(`[e2e-vpn] teardown: ${e.detail ?? e.message}`));
}
say(failed ? "FAILED" : "ALL PASSED");
process.exit(failed ? 1 : 0);
