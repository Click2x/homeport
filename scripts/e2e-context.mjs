// Pure helpers with no imports, so they run both on the host and in the bare helper container.
export const SELECTED = ["prowlarr", "sonarr", "radarr", "qbittorrent", "jellyfin", "seerr"];

/** Build the connectors' context. `internal` maps app id -> { host, port } as seen inside the network. */
export function contextFrom(internal, keyVars, secrets, log) {
  const keys = {};
  for (const id of ["prowlarr", "sonarr", "radarr"]) keys[id] = secrets[keyVars[id]];
  return {
    url: (id) => `http://${internal[id].host}:${internal[id].port}`,
    internal: (id) => internal[id],
    keys,
    qbittorrent: { password: secrets.QBIT_PASS, firstRunPassword: secrets.QBIT_FIRST_RUN || undefined },
    jellyfin: { adminUser: "homeport", adminPassword: secrets.JELLYFIN_PASS },
    log,
  };
}
