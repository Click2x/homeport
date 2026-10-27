# Changelog

All notable changes to Homeport. The format follows [Keep a Changelog](https://keepachangelog.com), and
versions follow [Semantic Versioning](https://semver.org). Anything before 1.0 may change between versions.

## [0.1.0] - Unreleased

The first version of the real app. It is an **alpha**: it works end to end for one goal on Windows with
Docker Desktop (and in Linux CI), but it has not had a security review and has not been tried on macOS, on real
Linux hardware, or with a real phone through a real router.

### Added
- A guided web interface: first-run account with a one-time setup code, goal picker, plain-language plan,
  VPN setup (paste a WireGuard file), storage check with fixes, live install progress, and a dashboard.
  Simple and Advanced modes, light and dark themes, works on a phone.
- A catalog of seven services described by short YAML manifests, pinned to exact image digests:
  Prowlarr, Sonarr, Radarr, qBittorrent, Jellyfin, Seerr and the VPN gateway (gluetun).
- Typed, idempotent wiring between the apps (library folders, download client, Prowlarr links, the Jellyfin
  first-run wizard and libraries, TRaSH quality profiles through Recyclarr, Seerr), with API keys Homeport
  generates itself.
- A VPN gate: the download client starts only behind a VPN that Homeport has tested, stops again if a later
  check fails, and the only way to run without one is a manual edit of `homeport.toml`. Proven to fail
  closed against a tunnel that cannot connect.
- A storage checker that measures hardlinks, safe file moves, drive speed, permissions, free space and
  filesystem type, rates the location Best, Good, Compatible or Not ready, and explains each problem.
- Automatic free-port selection, including ports used by programs outside Docker.
- Remote access with WireGuard: one revocable invitation per person (QR code shown once, key never stored),
  each person reaches only the apps chosen for them, optional end dates, and a view of who is connected.
- Security basics: scrypt passwords, hashed session tokens, an anti-forgery header, sign-in lockout, an
  audit log, encrypted secrets at rest, a hardened recommended run command, and no secrets in the exported
  Compose file.
- 223 automated tests, and end-to-end scripts that run the real image against real Docker.

### Known limitations
- Alpha: no security review yet; the container runs as root with access to the Docker socket.
- Docker Desktop for Windows is the platform it is built on. The end-to-end suite also passes on Docker Engine on Ubuntu in GitHub Actions, but it has not been tried on real Linux hardware (home servers, NAS, Raspberry Pi) or on macOS.
- Remote access has not been tested with a real phone through a real router, and does not work behind
  carrier-grade NAT. The Tailscale alternative and automatic router port opening are not built.
- One goal (watch movies and shows). More services are planned as community manifests.

[0.1.0]: https://github.com/Click2x/homeport/releases/tag/v0.1.0
