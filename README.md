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

## Ground rules

- Homeport does **not** bundle or recommend indexers or content sources. You are responsible for what you download and for following the laws that apply to you.
- The app will hold access to the Docker socket, which is root-equivalent, so authentication and a security review are required before any 1.0.

## Trying the spike

Needs Docker Desktop and Node 22+. It starts real containers and downloads several GB of images, on host ports 1xxxx so it does not collide with an existing stack.

```bash
cd spike
node wire.mjs up     # deploy and wire everything
node wire.mjs down   # stop (volumes kept)
```

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version of Homeport as a network service, you must offer its source to the users of that service.
