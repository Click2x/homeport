import { parse } from "smol-toml";

/**
 * The settings a person can only change by editing homeport.toml by hand. Anything that lowers a
 * protection lives here on purpose: there is deliberately no button for it.
 */
export interface HomeportConfig {
  downloads: {
    /** Let the download client run without a VPN. Default false. */
    allowUnprotected: boolean;
  };
}

export const DEFAULT_CONFIG: HomeportConfig = { downloads: { allowUnprotected: false } };

export class ConfigError extends Error {}

/** A starter file explaining each setting in plain words. */
export const CONFIG_TEMPLATE = `# Homeport settings. Edit this file by hand, then restart Homeport.

[downloads]
# BitTorrent shows your home IP address to everyone sharing a file, and your internet provider can
# see it too. Homeport therefore only starts the download client behind a VPN it has verified.
#
# Set this to true ONLY if you have decided to download without a VPN. You are responsible for
# what you download and for the laws that apply to you.
allow_unprotected = false
`;

export function parseConfig(text: string): HomeportConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(
      `homeport.toml has a mistake and could not be read: ${(e as Error).message.split("\n")[0]}`,
    );
  }
  const downloads = (raw.downloads ?? {}) as Record<string, unknown>;
  const flag = downloads.allow_unprotected ?? false;
  if (typeof flag !== "boolean")
    throw new ConfigError("homeport.toml: downloads.allow_unprotected must be true or false (no quotes).");
  return { downloads: { allowUnprotected: flag } };
}
