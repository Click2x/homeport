export interface Provider {
  id: string;
  name: string;
  types: ("wireguard" | "openvpn")[];
}

/** Provider ids are the names the VPN gateway (gluetun) understands. */
export const PROVIDERS: Provider[] = [
  { id: "protonvpn", name: "Proton VPN", types: ["wireguard", "openvpn"] },
  { id: "mullvad", name: "Mullvad", types: ["wireguard", "openvpn"] },
  { id: "private internet access", name: "Private Internet Access", types: ["openvpn", "wireguard"] },
  { id: "nordvpn", name: "NordVPN", types: ["openvpn"] },
  { id: "surfshark", name: "Surfshark", types: ["openvpn", "wireguard"] },
  { id: "windscribe", name: "Windscribe", types: ["openvpn", "wireguard"] },
  { id: "custom", name: "Another provider (I have a WireGuard file)", types: ["wireguard"] },
];

/** The friendly name for a provider id, falling back to the id itself. */
export const providerLabel = (id: string | null): string =>
  PROVIDERS.find((p) => p.id === id)?.name ?? id ?? "";

export interface ParsedWireguard {
  values: Record<string, string>;
  /** Plain-language notes about anything missing or unusable. */
  problems: string[];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Read the pieces Homeport needs out of a WireGuard configuration file, the kind most VPN providers let
 * you download. Nothing is sent anywhere; this only reads the text.
 */
export function parseWireguardConf(text: string, { needsPeer }: { needsPeer: boolean }): ParsedWireguard {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      section = (header[1] ?? "").toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (section === "interface" && key === "privatekey") values.WIREGUARD_PRIVATE_KEY = value;
    else if (section === "interface" && key === "address")
      // Some files list an IPv4 and an IPv6 address; the gateway wants the IPv4 one first.
      values.WIREGUARD_ADDRESSES = value
        .split(",")
        .map((a) => a.trim())
        .join(",");
    else if (section === "peer" && key === "publickey") values.WIREGUARD_PUBLIC_KEY = value;
    else if (section === "peer" && key === "endpoint") {
      const m = /^(.+):(\d+)$/.exec(value);
      if (m?.[1] && m[2]) {
        values.WIREGUARD_ENDPOINT_IP = m[1];
        values.WIREGUARD_ENDPOINT_PORT = m[2];
      }
    }
  }
  if (!values.WIREGUARD_PRIVATE_KEY)
    problems.push("The file has no private key. Make sure you pasted the whole file.");
  if (!values.WIREGUARD_ADDRESSES) problems.push("The file has no address line.");
  if (needsPeer) {
    if (!values.WIREGUARD_PUBLIC_KEY || !values.WIREGUARD_ENDPOINT_IP)
      problems.push("The file is missing the server details ([Peer] section).");
    else if (!IPV4.test(values.WIREGUARD_ENDPOINT_IP))
      problems.push(
        "This file names its server with a web address, but Homeport needs the server's numeric address (like 203.0.113.9). Ask your provider for a file that uses one, or look the address up.",
      );
  } else {
    // For known providers the gateway picks the server itself, so only the key and address matter.
    for (const k of ["WIREGUARD_PUBLIC_KEY", "WIREGUARD_ENDPOINT_IP", "WIREGUARD_ENDPOINT_PORT"])
      delete values[k];
  }
  return { values, problems };
}
