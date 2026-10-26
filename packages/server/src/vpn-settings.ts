import type { Catalog } from "@homeport/core";
import { UserError } from "./settings.js";
import type { Store } from "./store.js";

const PREFIX = "vpn.";
const VERIFIED = "vpn.verified";

/** The only settings the VPN gateway accepts, taken from its manifest so nothing else can be injected. */
export function allowedVpnKeys(catalog: Catalog): string[] {
  return catalog.apps.get("gluetun")?.passthroughEnv ?? [];
}

/** Values end up in a .env file inside single quotes, so quotes and line breaks cannot be allowed. */
const SAFE_VALUE = /^[^'\r\n\0]*$/;

export function saveVpnSettings(store: Store, catalog: Catalog, values: Record<string, string>): void {
  const allowed = new Set(allowedVpnKeys(catalog));
  for (const [k, v] of Object.entries(values)) {
    if (!allowed.has(k)) throw new UserError(`"${k}" is not a VPN setting Homeport knows.`);
    if (typeof v !== "string" || !SAFE_VALUE.test(v))
      throw new UserError(
        `The value for ${k} contains a character that cannot be used (a quote or a line break).`,
      );
  }
  if (!values.VPN_SERVICE_PROVIDER?.trim())
    throw new UserError("Choose your VPN provider first. Homeport never starts downloads without a VPN.");
  for (const name of store.secretNames(PREFIX)) if (name !== VERIFIED) store.deleteSecret(name);
  for (const [k, v] of Object.entries(values)) if (v !== "") store.setSecret(`${PREFIX}${k}`, v);
  // New settings have not been proven to work yet.
  setVpnVerified(store, false);
}

export function clearVpnSettings(store: Store): void {
  for (const name of store.secretNames(PREFIX)) store.deleteSecret(name);
}

/** The settings as the gateway reads them, for the .env file. Never sent to the browser. */
export function vpnEnv(store: Store, catalog: Catalog): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of allowedVpnKeys(catalog)) {
    const v = store.getSecret(`${PREFIX}${k}`);
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export const vpnConfigured = (store: Store) => store.getSecret(`${PREFIX}VPN_SERVICE_PROVIDER`) !== undefined;
export const vpnVerified = (store: Store) => store.getSecret(VERIFIED) === "yes";
export function setVpnVerified(store: Store, verified: boolean): void {
  if (verified) store.setSecret(VERIFIED, "yes");
  else store.deleteSecret(VERIFIED);
}

/** What the interface may show: which settings are filled in, never their values. */
export function describeVpn(store: Store, catalog: Catalog) {
  const env = vpnEnv(store, catalog);
  return {
    configured: vpnConfigured(store),
    verified: vpnVerified(store),
    provider: env.VPN_SERVICE_PROVIDER ?? null,
    type: env.VPN_TYPE ?? null,
    filled: Object.keys(env).sort(),
  };
}
