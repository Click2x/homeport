import { randomUUID } from "node:crypto";
import type { Catalog } from "@homeport/core";
import {
  cleanName,
  endpointProblem,
  expandPlan,
  generateKeyPair,
  nextPeerIp,
  type Plan,
  renderPeerConf,
  renderRulesScript,
  renderServerConf,
  serviceHost,
  WG_DEFAULT_PORT,
  type WgPeer,
  type WgPeerStatus,
  type WgService,
} from "@homeport/engine";
import QRCode from "qrcode";
import { type StackSettings, UserError } from "./settings.js";
import type { Store } from "./store.js";

/**
 * Remote access: who may connect from outside, to which apps. People are stored without their private
 * key (it exists only in the file and QR code shown once, on the phone that scans it), so a stolen
 * database cannot impersonate anyone.
 */

export interface RemoteSettings {
  enabled: boolean;
  /** The name or address people connect to (not including the port). */
  endpoint: string;
}

const SETTINGS_KEY = "remote.settings";
const PEERS_KEY = "remote.peers";
const SERVER_PUBLIC_KEY = "remote.serverPublic";
const SERVER_PRIVATE_SECRET = "wg.server.private";

/** A connection is "online" if it completed a handshake in the last few minutes (phones re-handshake about every two). */
export const ONLINE_WITHIN_SECONDS = 180;

export const loadRemoteSettings = (store: Store): RemoteSettings => ({
  enabled: false,
  endpoint: "",
  ...store.getJson<Partial<RemoteSettings>>(SETTINGS_KEY),
});
export const saveRemoteSettings = (store: Store, s: RemoteSettings) => store.setJson(SETTINGS_KEY, s);
export const loadPeers = (store: Store): WgPeer[] => store.getJson<WgPeer[]>(PEERS_KEY) ?? [];
const savePeers = (store: Store, peers: WgPeer[]) => store.setJson(PEERS_KEY, peers);

export function ensureServerKeys(store: Store): { privateKey: string; publicKey: string } {
  const existing = store.getSecret(SERVER_PRIVATE_SECRET);
  const pub = store.getJson<string>(SERVER_PUBLIC_KEY);
  if (existing && pub) return { privateKey: existing, publicKey: pub };
  const keys = generateKeyPair();
  store.setSecret(SERVER_PRIVATE_SECRET, keys.privateKey);
  store.setJson(SERVER_PUBLIC_KEY, keys.publicKey);
  return keys;
}

export const tunnelPort = (settings: StackSettings): number =>
  settings.hostPorts.wireguard?.tunnel ?? WG_DEFAULT_PORT;

/** Apps a person can be given: everything with a web page. Admin tools are flagged so the interface can warn. */
export interface Shareable {
  id: string;
  name: string;
  port: number;
  /** Lets the person change your setup (managers and the download client), not just use it. */
  sensitive: boolean;
}

export function servicesOf(
  catalog: Catalog,
  plan: Plan,
): (WgService & { name: string; sensitive: boolean })[] {
  return expandPlan(catalog, plan)
    .filter((a) => a.id !== "gluetun" && a.id !== "wireguard" && a.ports.length > 0)
    .map((a) => ({
      id: a.id,
      name: a.name,
      port: a.ports[0]?.container ?? 0,
      host: serviceHost(plan, a),
      sensitive: a.category === "media-manager" || a.category === "downloader",
    }));
}

export function buildFiles(store: Store, catalog: Catalog, plan: Plan, settings: StackSettings) {
  const keys = ensureServerKeys(store);
  const peers = loadPeers(store);
  const services = servicesOf(catalog, plan).map(({ id, port, host }) => ({ id, port, host }));
  return {
    conf: renderServerConf({ privateKey: keys.privateKey, port: 51820 }, peers),
    rules: renderRulesScript(peers, services),
    port: tunnelPort(settings),
  };
}

/** Drop invitations whose time is up. Returns who was removed. */
export function pruneExpired(store: Store, now = Date.now()): WgPeer[] {
  const peers = loadPeers(store);
  const gone = peers.filter((p) => p.expiresAt && Date.parse(p.expiresAt) <= now);
  if (gone.length) {
    savePeers(
      store,
      peers.filter((p) => !gone.includes(p)),
    );
  }
  return gone;
}

export interface PersonView {
  id: string;
  name: string;
  ip: string;
  services: string[];
  createdAt: string;
  expiresAt: string | null;
  online: boolean;
  lastSeen: string | null;
}

export function describePeers(
  peers: WgPeer[],
  status: WgPeerStatus[],
  nowSeconds = Date.now() / 1000,
): PersonView[] {
  return peers.map((p) => {
    const hs = status.find((s) => s.publicKey === p.publicKey)?.latestHandshake ?? null;
    return {
      id: p.id,
      name: p.name,
      ip: p.ip,
      services: p.services,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      online: hs !== null && nowSeconds - hs <= ONLINE_WITHIN_SECONDS,
      lastSeen: hs ? new Date(hs * 1000).toISOString() : null,
    };
  });
}

export interface NewPerson {
  name: string;
  services: string[];
  expiresInDays?: number;
}

/**
 * Create a person: keys, an address, and the file and QR code for their phone. The private key leaves
 * this function only inside that file; it is not stored.
 */
export async function addPerson(
  store: Store,
  input: NewPerson,
  available: Shareable[],
  settings: StackSettings,
  remote: RemoteSettings,
  now = new Date(),
) {
  if (!remote.enabled) throw new UserError("Turn on remote access first.");
  const problem = endpointProblem(remote.endpoint);
  if (problem) throw new UserError(problem);
  let name: string;
  try {
    name = cleanName(input.name);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const peers = loadPeers(store);
  if (peers.some((p) => p.name.toLowerCase() === name.toLowerCase()))
    throw new UserError(`You already invited someone called ${name}. Choose a different name.`);
  const known = new Set(available.map((a) => a.id));
  const services = [...new Set(input.services)];
  if (!services.length) throw new UserError("Choose at least one app this person may open.");
  for (const s of services)
    if (!known.has(s)) throw new UserError(`"${s}" is not an app you have installed.`);
  if (
    input.expiresInDays !== undefined &&
    (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 365)
  )
    throw new UserError("An invitation can last from 1 to 365 days.");

  const server = ensureServerKeys(store);
  const keys = generateKeyPair();
  let ip: string;
  try {
    ip = nextPeerIp(peers);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const peer: WgPeer = {
    id: randomUUID(),
    name,
    publicKey: keys.publicKey,
    ip,
    services,
    createdAt: now.toISOString(),
    expiresAt: input.expiresInDays
      ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString()
      : null,
  };
  savePeers(store, [...peers, peer]);

  const config = renderPeerConf({
    privateKey: keys.privateKey,
    address: ip,
    serverPublicKey: server.publicKey,
    endpoint: remote.endpoint.trim(),
    port: tunnelPort(settings),
  });
  const qr = await QRCode.toString(config, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return { peer, config, qr };
}

export function changeServices(store: Store, id: string, services: string[], available: Shareable[]): WgPeer {
  const peers = loadPeers(store);
  const peer = peers.find((p) => p.id === id);
  if (!peer) throw new UserError("That person is not on the list.", 404);
  const known = new Set(available.map((a) => a.id));
  const next = [...new Set(services)];
  if (!next.length) throw new UserError("Choose at least one app, or remove this person instead.");
  for (const s of next) if (!known.has(s)) throw new UserError(`"${s}" is not an app you have installed.`);
  peer.services = next;
  savePeers(store, peers);
  return peer;
}

export function removePerson(store: Store, id: string): WgPeer {
  const peers = loadPeers(store);
  const peer = peers.find((p) => p.id === id);
  if (!peer) throw new UserError("That person is not on the list.", 404);
  savePeers(
    store,
    peers.filter((p) => p.id !== id),
  );
  return peer;
}
