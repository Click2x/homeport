# Homeport design notes

Early decisions, written down so contributors can challenge them. Nothing here is built yet unless the README says so.

## Architecture
- One container with the Docker socket mounted. TypeScript on Node 22 (Fastify), SQLite (Drizzle), React + Vite + shadcn/ui frontend, Server-Sent Events for progress.
- Apps are described by **YAML manifests** validated by a schema (community-extensible). **Connectors** are typed per-app modules that wire apps together after install and must be idempotent.
- Deploy by generating a real compose project and applying it with `docker compose`, so "export compose" is free.
- Talk to services by **service name on the stack network**, not through host ports. The spike found qBittorrent rejecting logins that arrive through Docker Desktop's host port forward.
- Generate API keys ourselves and inject them via environment variables.

## Storage tiers (Windows / Docker Desktop)
Bind-mounting NTFS into Linux containers is slow and its hardlink behavior is unreliable, so Homeport tests instead of assuming.
- **Best:** an ext4 VHDX file on a spare drive (non-destructive; needs admin to mount). Raw-disk formatting stays expert-only, and the app never formats anything itself.
- **Good:** one NTFS data root that passes the hardlink test, with app configs in named volumes.
- **Compatible:** NTFS that fails the test. Copy mode, rescans, a visible warning.
- App configs and databases always live in named volumes, never on a Windows bind mount.
- Safety: a sentinel file refuses to start downloaders if the media drive is not mounted.

## Storage checker
Hardlink test, same-filesystem check, atomic rename, throughput, inotify, permissions/PUID, free space, host path mapping, config-on-bind-mount, VHDX size. Each failure gets a plain-language explanation and an automatic or guided fix.

## Remote access
- Built-in WireGuard in a dedicated sidecar, with QR-code peers. One peer per person, revocable, expiring invites, firewall-scoped to chosen services.
- Tailscale/Headscale as an alternative for users behind CGNAT or without port forwarding.
- A reverse proxy with HTTPS may follow for friends who will not install an app.

## Linux
Same core, via a platform adapter (path resolution, storage tiers, GPU, VPN capabilities, install helper). Storage is simpler there: native filesystems mean most users land in the best tier.

## Security
The Docker socket is root-equivalent. Needs first-run admin setup, LAN-only default binding, rate-limited login, an audit log, and a security review before 1.0.
