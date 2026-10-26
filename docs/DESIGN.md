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
Implemented in `@homeport/engine` (`checkStorage`). A throwaway container mounts exactly what the stack will mount and measures: hardlinks, atomic rename, whether downloads and library share a drive, write speed, whether the apps' own user can write, free space and filesystem type. Each result has a plain-language explanation, and failures carry an automatic or guided fix. Tiers: **best** (native Linux filesystem on a folder you control), **good**, **compatible** (copy mode), **blocked**.

Not checked yet: inotify (files added from outside Docker being noticed), the "drive not mounted" sentinel, and VHDX size.

**What we measured** (one machine, Docker Desktop on Windows 11, October 2026; yours may differ, which is why Homeport measures instead of assuming):

| Location | Hardlinks | Atomic rename | Write speed |
|---|---|---|---|
| Docker named volume (ext4 inside Docker's disk) | works | works | ~1,400 MB/s |
| NTFS folder on the system drive, bind-mounted | works | works | ~105 MB/s |
| NTFS folder on a second internal drive, bind-mounted | works | works | ~183 MB/s |

So on this setup NTFS hardlinks work, contrary to our earlier assumption, but the shared-drive path is roughly 10x slower than Docker's own storage. A fresh Docker volume is owned by root, so apps cannot write until `prepareStorage` hands the folders to the apps' user (which is also the automatic permission fix).

## Remote access
- Built-in WireGuard in a dedicated sidecar, with QR-code peers. One peer per person, revocable, expiring invites, firewall-scoped to chosen services.
- Tailscale/Headscale as an alternative for users behind CGNAT or without port forwarding.
- A reverse proxy with HTTPS may follow for friends who will not install an app.

## Linux
Same core, via a platform adapter (path resolution, storage tiers, GPU, VPN capabilities, install helper). Storage is simpler there: native filesystems mean most users land in the best tier.

## Security
The Docker socket is root-equivalent. Needs first-run admin setup, LAN-only default binding, rate-limited login, an audit log, and a security review before 1.0.
