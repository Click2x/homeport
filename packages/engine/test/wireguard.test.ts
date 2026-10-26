import { describe, expect, it } from "vitest";
import {
  cleanName,
  endpointProblem,
  generateKeyPair,
  isWgKey,
  nextPeerIp,
  parseWgDump,
  renderPeerConf,
  renderRulesScript,
  renderServerConf,
  type WgPeer,
} from "../src/index.js";

const peer = (over: Partial<WgPeer> = {}): WgPeer => ({
  id: "p1",
  name: "Sam's phone",
  publicKey: `${"A".repeat(43)}=`,
  ip: "10.13.13.2",
  services: ["jellyfin"],
  createdAt: "2026-10-26T00:00:00Z",
  expiresAt: null,
  ...over,
});
const SERVICES = [
  { id: "jellyfin", port: 8096 },
  { id: "sonarr", port: 8989 },
];

describe("keys", () => {
  it("makes valid, distinct WireGuard key pairs", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(isWgKey(a.privateKey)).toBe(true);
    expect(isWgKey(a.publicKey)).toBe(true);
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(a.privateKey);
  });
});

describe("addresses and names", () => {
  it("hands out the next free address, starting after the gateway", () => {
    expect(nextPeerIp([])).toBe("10.13.13.2");
    expect(nextPeerIp([{ ip: "10.13.13.2" }, { ip: "10.13.13.4" }])).toBe("10.13.13.3");
  });

  it("says so when the tunnel is full", () => {
    const full = Array.from({ length: 253 }, (_, i) => ({ ip: `10.13.13.${i + 2}` }));
    expect(() => nextPeerIp(full)).toThrow(/no room/);
  });

  it("cleans a name so it is safe in files and logs", () => {
    expect(cleanName("  Sam's   phone!! ")).toBe("Sam's phone");
    expect(cleanName("José <b>x</b>")).toBe("José bxb");
    expect(cleanName("a\nb")).toBe("ab");
    expect(() => cleanName("!!!")).toThrow(/Give this person a name/);
  });
});

describe("endpointProblem", () => {
  it("accepts names and public addresses", () => {
    expect(endpointProblem("home.example.com")).toBeNull();
    expect(endpointProblem("203.0.113.9")).toBeNull();
  });
  it("explains a private address that cannot work from outside", () => {
    for (const ip of ["192.168.1.20", "10.0.0.5", "172.16.4.4", "127.0.0.1"])
      expect(endpointProblem(ip), ip).toMatch(/private address/);
  });
  it("rejects nonsense", () => {
    expect(endpointProblem("")).toMatch(/Enter/);
    expect(endpointProblem("not an address")).toMatch(/does not look like/);
    expect(endpointProblem("999.1.1.1")).toMatch(/not a valid/);
    expect(endpointProblem("a;rm -rf /")).toMatch(/does not look like/);
  });
});

describe("renderServerConf", () => {
  it("gives each person their own address and nothing else", () => {
    const conf = renderServerConf({ privateKey: `${"K".repeat(43)}=`, port: 51820 }, [
      peer(),
      peer({ id: "p2", ip: "10.13.13.3", publicKey: `${"B".repeat(43)}=` }),
    ]);
    expect(conf).toContain("ListenPort = 51820");
    expect(conf).toContain("AllowedIPs = 10.13.13.2/32");
    expect(conf).toContain("AllowedIPs = 10.13.13.3/32");
    expect(conf).not.toContain("0.0.0.0/0");
    expect(conf).not.toContain("Sam"); // names never reach the file
  });
});

describe("renderPeerConf", () => {
  const conf = renderPeerConf({
    privateKey: `${"P".repeat(43)}=`,
    address: "10.13.13.2",
    serverPublicKey: `${"S".repeat(43)}=`,
    endpoint: "home.example.com",
    port: 51820,
  });
  it("sends only the gateway address through the tunnel (a split tunnel)", () => {
    expect(conf).toContain("AllowedIPs = 10.13.13.1/32");
    expect(conf).not.toContain("0.0.0.0/0");
  });
  it("points at the endpoint and keeps the connection alive behind phone networks", () => {
    expect(conf).toContain("Endpoint = home.example.com:51820");
    expect(conf).toContain("PersistentKeepalive = 25");
  });
});

describe("renderRulesScript", () => {
  const script = renderRulesScript(
    [peer(), peer({ id: "p2", ip: "10.13.13.3", services: ["jellyfin", "sonarr"] })],
    SERVICES,
  );

  it("opens only the apps someone was given, on their own ports", () => {
    expect(script).toContain("-s 10.13.13.2 -d $ip_jellyfin -p tcp --dport 8096 -j ACCEPT");
    expect(script).toContain("-s 10.13.13.3 -d $ip_sonarr -p tcp --dport 8989 -j ACCEPT");
  });

  it("never lets a person reach an app that was not given to them", () => {
    expect(script).not.toContain("-s 10.13.13.2 -d $ip_sonarr");
  });

  it("drops everything from the tunnel that is not explicitly allowed", () => {
    expect(script).toContain("iptables -A FORWARD -i wg0 -j DROP");
  });

  it("publishes an app on the gateway address only when somebody may use it", () => {
    const onlyJellyfin = renderRulesScript([peer()], SERVICES);
    expect(onlyJellyfin).toContain("--dport 8096 -j DNAT");
    expect(onlyJellyfin).not.toContain("--dport 8989 -j DNAT");
    expect(renderRulesScript([], SERVICES)).not.toContain("DNAT --to-destination");
  });

  it("keeps connections that are already open when rules change", () => {
    expect(script).toContain("--ctstate ESTABLISHED,RELATED -j ACCEPT");
  });

  it("does nothing when neither the rules nor the addresses changed, and reapplies when they do", () => {
    expect(script).toContain('[ "$state" = "$last" ] && exit 0');
    const a = /v=([0-9a-f]+)/.exec(script)?.[1];
    const b = /v=([0-9a-f]+)/.exec(renderRulesScript([peer({ services: [] })], SERVICES))?.[1];
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  it("refuses anything that could become a shell command", () => {
    expect(() => renderRulesScript([], [{ id: "x; reboot", port: 80 }])).toThrow(/unsafe/);
    expect(() => renderRulesScript([], [{ id: "ok", port: Number.NaN }])).toThrow(/unsafe/);
    expect(() => renderRulesScript([peer({ ip: "10.13.13.2; reboot" })], SERVICES)).toThrow(/unsafe/);
  });
});

describe("parseWgDump", () => {
  const dump = [
    "PRIV\tPUB\t51820\toff",
    "PEERKEY1\t(none)\t203.0.113.9:40000\t10.13.13.2/32\t1700000000\t1234\t5678\t25",
    "PEERKEY2\t(none)\t(none)\t10.13.13.3/32\t0\t0\t0\t25",
  ].join("\n");
  it("reads who connected and when", () => {
    const [a, b] = parseWgDump(dump);
    expect(a).toEqual({
      publicKey: "PEERKEY1",
      endpoint: "203.0.113.9:40000",
      latestHandshake: 1700000000,
      rx: 1234,
      tx: 5678,
    });
    expect(b).toMatchObject({ publicKey: "PEERKEY2", endpoint: null, latestHandshake: null });
  });
  it("copes with an empty answer", () => {
    expect(parseWgDump("")).toEqual([]);
  });
});
