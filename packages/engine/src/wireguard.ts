import { createHash, generateKeyPairSync } from "node:crypto";

/**
 * Remote access with WireGuard. Each invited person gets their own key and address, and can reach only the
 * apps chosen for them, through the sidecar's address (a "split tunnel": nothing else on their phone is
 * routed through your home). All the text rendering here is pure so it can be tested without Docker.
 */

export const WG_PREFIX = "10.13.13";
export const WG_SERVER_IP = `${WG_PREFIX}.1`;
export const WG_INTERFACE = "wg0";
export const WG_DEFAULT_PORT = 51820;

export interface WgPeer {
  id: string;
  name: string;
  publicKey: string;
  /** The person's address inside the tunnel, e.g. 10.13.13.2. */
  ip: string;
  /** App ids this person may open. */
  services: string[];
  createdAt: string;
  /** After this moment the invite stops working. Null means it does not expire. */
  expiresAt: string | null;
}

export interface WgService {
  id: string;
  port: number;
  /** The name other containers use to reach it. Defaults to the id; it is the VPN gateway for apps behind one. */
  host?: string;
}

const b64 = (s: string) => Buffer.from(s, "base64url").toString("base64");

/** A fresh WireGuard key pair, as the base64 text WireGuard uses. */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKey: b64(privateKey.export({ format: "jwk" }).d as string),
    publicKey: b64(publicKey.export({ format: "jwk" }).x as string),
  };
}

export const isWgKey = (s: string) => /^[A-Za-z0-9+/]{43}=$/.test(s);

export function nextPeerIp(peers: Pick<WgPeer, "ip">[]): string {
  const used = new Set(peers.map((p) => p.ip));
  for (let i = 2; i <= 254; i++) {
    const ip = `${WG_PREFIX}.${i}`;
    if (!used.has(ip)) return ip;
  }
  throw new Error("There is no room for more people.");
}

/** A person's name as it may appear in files and logs: letters, numbers, spaces, dots, dashes, underscores. */
export function cleanName(name: string): string {
  // Names are only ever shown in the interface and kept in the database, never put in a file or a command,
  // so ordinary punctuation and accented letters are fine. Control characters and markup are not.
  const clean = name
    .replace(/[^\p{L}\p{N} ._'’-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  if (!clean) throw new Error("Give this person a name, using letters or numbers.");
  return clean;
}

/** Where the phone should connect: a hostname or an IPv4 address. Returns a plain-language problem or null. */
export function endpointProblem(host: string): string | null {
  const h = host.trim();
  if (!h) return "Enter the address people will connect to.";
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(h))
    return "That does not look like an address. Use a name like home.example.com or a number like 203.0.113.9.";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const parts = h.split(".").map(Number);
    if (parts.some((p) => p > 255)) return "That is not a valid number address.";
    const [a = 0, b = 0] = parts;
    if (
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    )
      return "That is a private address that only works inside your home. People connecting from outside need your public address or a name that points to it.";
  }
  return null;
}

export function renderServerConf(server: { privateKey: string; port: number }, peers: WgPeer[]): string {
  const lines = [
    "# Managed by Homeport. Changes made here are overwritten.",
    "[Interface]",
    `Address = ${WG_SERVER_IP}/24`,
    `ListenPort = ${server.port}`,
    `PrivateKey = ${server.privateKey}`,
  ];
  for (const p of peers) lines.push("", "[Peer]", `PublicKey = ${p.publicKey}`, `AllowedIPs = ${p.ip}/32`);
  return `${lines.join("\n")}\n`;
}

/**
 * The file a person loads into the WireGuard app. Only the gateway's own address is routed through the
 * tunnel, so the rest of their phone's traffic is left alone.
 */
export function renderPeerConf(args: {
  privateKey: string;
  address: string;
  serverPublicKey: string;
  endpoint: string;
  port: number;
}): string {
  return `${[
    "[Interface]",
    `PrivateKey = ${args.privateKey}`,
    `Address = ${args.address}/32`,
    "",
    "[Peer]",
    `PublicKey = ${args.serverPublicKey}`,
    `Endpoint = ${args.endpoint}:${args.port}`,
    `AllowedIPs = ${WG_SERVER_IP}/32`,
    "PersistentKeepalive = 25",
  ].join("\n")}\n`;
}

/**
 * The firewall script the sidecar runs. Every flow is dropped unless it is explicitly allowed: a person
 * can reach only the apps chosen for them, on those apps' own ports, through the gateway address.
 * It looks up the apps' addresses itself (they change when containers restart) and does nothing when
 * neither the rules nor the addresses changed.
 */
export function renderRulesScript(peers: WgPeer[], services: WgService[]): string {
  for (const s of services) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(s.id) ||
      !/^[a-z][a-z0-9-]*$/.test(s.host ?? s.id) ||
      !Number.isInteger(s.port)
    )
      throw new Error(`unsafe service ${s.id}`);
  }
  for (const p of peers) if (!/^10\.13\.13\.\d{1,3}$/.test(p.ip)) throw new Error(`unsafe address ${p.ip}`);
  const version = createHash("sha256")
    .update(JSON.stringify({ p: peers.map((p) => [p.ip, [...p.services].sort()]), s: services }))
    .digest("hex")
    .slice(0, 16);
  const varOf = (id: string) => `ip_${id.replace(/-/g, "_")}`;

  const lines = [
    "#!/bin/sh",
    "# Managed by Homeport. Safe to run repeatedly; it only acts when something changed.",
    "set -u",
    "resolve() { getent hosts \"$1\" | awk 'NR==1{print $1}'; }",
    ...services.map((s) => `${varOf(s.id)}=$(resolve ${s.host ?? s.id})`),
    `state="v=${version} ${services.map((s) => `${s.id}=$${varOf(s.id)}`).join(" ")}"`,
    "last=$(cat /tmp/hp-rules-state 2>/dev/null || true)",
    '[ "$state" = "$last" ] && exit 0',
    "",
    "# Chains Homeport owns, hooked in once. Anything arriving from the tunnel that falls through is dropped.",
    "iptables -t nat -N HP-NAT 2>/dev/null",
    "iptables -N HP-FWD 2>/dev/null",
    `iptables -t nat -C PREROUTING -i ${WG_INTERFACE} -j HP-NAT 2>/dev/null || iptables -t nat -I PREROUTING -i ${WG_INTERFACE} -j HP-NAT`,
    `iptables -C FORWARD -i ${WG_INTERFACE} -j HP-FWD 2>/dev/null || iptables -I FORWARD -i ${WG_INTERFACE} -j HP-FWD`,
    `iptables -C FORWARD -i ${WG_INTERFACE} -j DROP 2>/dev/null || iptables -A FORWARD -i ${WG_INTERFACE} -j DROP`,
    `iptables -t nat -C POSTROUTING -s ${WG_PREFIX}.0/24 ! -o ${WG_INTERFACE} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${WG_PREFIX}.0/24 ! -o ${WG_INTERFACE} -j MASQUERADE`,
    "",
    "iptables -t nat -F HP-NAT",
    "iptables -F HP-FWD",
    "iptables -A HP-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
  ];
  for (const s of services) {
    const ip = `$${varOf(s.id)}`;
    const people = peers.filter((p) => p.services.includes(s.id));
    if (!people.length) continue;
    lines.push(`if [ -n "${ip}" ]; then`);
    lines.push(
      `  iptables -t nat -A HP-NAT -d ${WG_SERVER_IP} -p tcp --dport ${s.port} -j DNAT --to-destination ${ip}:${s.port}`,
    );
    for (const p of people)
      lines.push(`  iptables -A HP-FWD -s ${p.ip} -d ${ip} -p tcp --dport ${s.port} -j ACCEPT`);
    lines.push("fi");
  }
  lines.push('echo "$state" > /tmp/hp-rules-state', "");
  return lines.join("\n");
}

export interface WgPeerStatus {
  publicKey: string;
  endpoint: string | null;
  /** Seconds since the Unix epoch, or null if the peer has never connected. */
  latestHandshake: number | null;
  rx: number;
  tx: number;
}

/** Parse `wg show wg0 dump` (tab separated; the first line describes the interface itself). */
export function parseWgDump(dump: string): WgPeerStatus[] {
  return dump
    .split("\n")
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => {
      const f = l.split("\t");
      const handshake = Number(f[4] ?? 0);
      return {
        publicKey: f[0] ?? "",
        endpoint: f[2] && f[2] !== "(none)" ? f[2] : null,
        latestHandshake: handshake > 0 ? handshake : null,
        rx: Number(f[5] ?? 0),
        tx: Number(f[6] ?? 0),
      };
    });
}
