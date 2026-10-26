# Homeport

**One friendly place to roll out your whole media stack and home services, already wired together.**

Homeport is an open-source project that aims to take a complete beginner from "I have Docker Desktop" to a working Sonarr + Radarr + Prowlarr + qBittorrent (behind a VPN) + Jellyfin + Seerr setup, with no YAML and no copying API keys between apps. Advanced users get an Advanced mode and an exportable compose file.

Homeport is a **standalone product**: it needs no account, no cloud service and no other software besides Docker. The guided experience is described in [`docs/UX.md`](docs/UX.md).

> ## Status: early prototype. There is no app yet.
>
> What exists today is a **headless proof of concept** (the "spike") that shows the hard part works. There is **no web UI, no installer and no released version**. Do not expect to install Homeport yet.

## What works today (the spike)

Run on **Docker Desktop for Windows (WSL2)** against real containers:

- Deploys Prowlarr, Sonarr, Radarr, qBittorrent and Jellyfin from one compose file, plus Seerr.
- **Generates API keys itself** and injects them as environment variables, instead of scraping config files.
- **Wires the apps together** through their APIs: root folders, qBittorrent as the download client in Sonarr and Radarr, Prowlarr linked to both.
- Finishes the **Jellyfin first-run wizard** and creates the Movies and TV libraries.
- Applies **TRaSH-guide quality profiles** with Recyclarr.
- Signs **Seerr** in through Jellyfin, enables the libraries, and links Sonarr and Radarr.
- **Idempotent:** running it again changes nothing.
- A first **storage check** (do hardlinks work on the data volume?).
- An optional **gluetun VPN overlay** that puts qBittorrent behind the tunnel, with a **kill-switch check** (qBittorrent must share the VPN's network, the firewall must default to DROP, and the exit IP must not be your home IP). Verified against a real ProtonVPN WireGuard tunnel, including dropping the tunnel and confirming nothing leaks.

See [`spike/`](spike/). The spike keeps its generated secrets in a git-ignored `.env`.

## What does not work yet

- No web app, wizard, dashboard, authentication or installer.
- Only tested on Windows with Docker Desktop. **Linux is a planned target but untested.**
- The storage checker only does the hardlink test so far. The tiers and fixes below are a design, not code.
- No built-in WireGuard server or QR invites yet.
- Images use `latest` tags and are not pinned. Recyclarr uses only a minimal profile config (no custom-format groups yet).
- Indexers are not configured. You add your own.
- No test suite or CI.

## Plan

1. Scaffold a TypeScript monorepo (server, web, manifests, connectors) and port the spike into it.
2. Storage checker with **Best / Good / Compatible** tiers. NTFS stays supported, and a checker explains problems and offers fixes (hardlink test, same-filesystem check, atomic rename, throughput, inotify, permissions, free space, path mapping).
3. Guided wizard with a Simple and an Advanced mode, live deploy progress, health checks and updates.
4. Built-in **WireGuard** remote access with per-person QR invites that can be revoked and limited to chosen services, with Tailscale as an alternative for people who cannot forward a port.
5. Optional extra services (Home Assistant, Pi-hole, Vaultwarden, Nextcloud and others) as community-extensible manifests.
6. Linux support through a small platform adapter.

Design notes: [`docs/DESIGN.md`](docs/DESIGN.md). Experience notes: [`docs/UX.md`](docs/UX.md).

## Development

The real app is being built as a TypeScript monorepo under [`packages/`](packages/), starting from the proven spike:

| Package | What it holds |
|---|---|
| `@homeport/core` | The app manifest schema, the catalog of services (`manifests/*.yaml`) and the goals that select them |
| `@homeport/engine` | Turns a plan into a Docker Compose project (storage modes, VPN routing, generated-key placeholders) and runs the Docker side: deploy, first-run checks, Recyclarr |
| `@homeport/connectors` | Typed, idempotent wiring for Sonarr, Radarr, Prowlarr, qBittorrent, Jellyfin and Seerr |

```bash
npm install
npm test           # unit tests, no Docker needed (wiring runs against in-memory fakes)
npm run typecheck  # tsc -b
npm run lint       # Biome
npm run e2e        # deploys a real stack, wires it, wires it again, tears it down (needs Docker; downloads images)
```

A manifest is a short YAML file, so adding a service to the catalog needs no code. The engine's output is checked against the spike's known-good compose file, and the end-to-end test proves the TypeScript wiring against real containers (second run changes nothing).

## Ground rules

- Homeport does **not** bundle or recommend indexers or content sources. You are responsible for what you download and for following the laws that apply to you.
- The app will hold access to the Docker socket, which is root-equivalent, so authentication and a security review are required before any 1.0.

## Quick start (the spike)

You need **Docker** (Docker Desktop on Windows or macOS, or Docker Engine with Compose v2 on Linux) and **Node 20 or newer** (tested on 22). Nothing else.

```bash
git clone https://github.com/Click2x/homeport.git
cd homeport/spike
node wire.mjs up
```

The first run downloads several GB of images and takes a few minutes. When it finishes it prints where to open each service. Jellyfin has an admin user `homeport`; its password, and qBittorrent's, are in `spike/.env` (generated for you; never committed).

| Command | What it does |
|---|---|
| `node wire.mjs up` | Deploy and wire everything. Safe to run again; it changes nothing that is already set up. |
| `node wire.mjs down` | Stop the stack. Your data is kept. |
| `node wire.mjs reset --yes` | Stop the stack **and delete its data** for a fresh start. |
| `node wire.mjs vpn-test` | Re-run the VPN kill-switch check. |

**What it uses:** host ports 19696 (Prowlarr), 18989 (Sonarr), 17878 (Radarr), 18080 (qBittorrent), 18096 (Jellyfin) and 15055 (Seerr), chosen so they do not collide with a normal install. Change them, or run a second copy, with the settings in [`spike/example.env`](spike/example.env).

**Using a VPN for qBittorrent:** copy `spike/example.env` to `spike/.env`, set your provider details, and run `node wire.mjs up`. The VPN overlay turns on and the run ends with a kill-switch check. Do this before you add any download sources.

**Tested with** (images use `latest` tags, so newer releases may behave differently): Prowlarr 2.6.5, Sonarr 4.0.20, Radarr 6.4.4, qBittorrent 5.2.4, Jellyfin 12.2, Seerr 3.5.0, Recyclarr 8.8.0, on Docker Desktop for Windows. Linux and macOS are not tested yet.

**If something goes wrong**
- *"Docker is not running"*: start Docker Desktop, then retry.
- *"Ports already in use"*: another program uses one of the ports above; change it in `spike/.env`.
- *qBittorrent login problems*: qBittorrent bans an address after several bad logins. Restart its container and run `node wire.mjs up` again.
- Anything else: open an issue with the output of `node wire.mjs up` (it does not print your keys).

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version of Homeport as a network service, you must offer its source to the users of that service.
