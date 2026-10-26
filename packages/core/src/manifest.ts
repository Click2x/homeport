import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * An app manifest describes one service Homeport can deploy. Manifests are plain YAML files so the
 * community can add services without writing code. Wiring between apps lives in connectors, not here.
 */
export const PortSchema = Type.Object({
  name: Type.String({ description: "Short label, e.g. web" }),
  container: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: Type.Optional(Type.Union([Type.Literal("tcp"), Type.Literal("udp")])),
});

export const VolumeSchema = Type.Object({
  kind: Type.Union([Type.Literal("config"), Type.Literal("data")], {
    description:
      "config = the app's own settings (always a named volume); data = the shared media/downloads root",
  }),
  container: Type.String({ pattern: "^/" }),
});

export const AppManifestSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
  name: Type.String(),
  purpose: Type.String({ description: "One plain-language sentence for beginners" }),
  category: Type.Union([
    Type.Literal("media-manager"),
    Type.Literal("downloader"),
    Type.Literal("media-server"),
    Type.Literal("requests"),
    Type.Literal("vpn-gateway"),
    Type.Literal("home"),
  ]),
  image: Type.String(),
  tag: Type.String(),
  testedVersion: Type.Optional(Type.String()),
  /** linuxserver.io images take PUID, PGID and TZ. */
  linuxserver: Type.Optional(Type.Boolean()),
  init: Type.Optional(Type.Boolean()),
  /** Linux capabilities and devices, e.g. the VPN gateway needs NET_ADMIN and /dev/net/tun. */
  capAdd: Type.Optional(Type.Array(Type.String())),
  devices: Type.Optional(Type.Array(Type.String())),
  /** Env var names forwarded from the user's .env as ${NAME:-} (e.g. VPN provider settings). */
  passthroughEnv: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }))),
  ports: Type.Array(PortSchema),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Env var through which Homeport injects a generated API key (so keys are never scraped). */
  apiKeyEnv: Type.Optional(Type.String()),
  volumes: Type.Array(VolumeSchema),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  /** required = must run behind the VPN gateway (e.g. BitTorrent clients). */
  vpn: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("recommended")])),
  ramMB: Type.Optional(Type.Integer({ minimum: 0 })),
  gpu: Type.Optional(Type.Boolean()),
});

export type AppManifest = Static<typeof AppManifestSchema>;

export class ManifestError extends Error {}

/** Validate untrusted data (a community manifest) and return it typed, or throw a readable error. */
export function parseManifest(data: unknown, source = "manifest"): AppManifest {
  if (Value.Check(AppManifestSchema, data)) return data;
  const first = [...Value.Errors(AppManifestSchema, data)][0];
  throw new ManifestError(`${source}: ${first?.path || "/"} ${first?.message ?? "is invalid"}`);
}
