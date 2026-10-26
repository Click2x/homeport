# Security

## Reporting a problem

Please report security problems privately, not in a public issue: use GitHub's
[private vulnerability reporting](https://github.com/Click2x/homeport/security/advisories/new) for this repository.
Include what you found, how to reproduce it, and what you think the impact is. You will get an answer as soon as a
person can look at it. This is a small project, so please be patient.

## What Homeport is, and why it matters

Homeport runs in a container that holds **access to the Docker socket**. Anyone who controls Homeport can start
containers that mount your whole computer, which is the same as being an administrator. Treat access to Homeport
like access to your computer.

## How it protects itself

- **Local only by default.** The recommended command publishes it on `127.0.0.1` only.
- **First-run setup needs a one-time code** printed in the log, so nobody on your network can claim a fresh install.
- **Passwords** are hashed with scrypt. **Sessions** are random tokens, and only a hash of each is stored.
- **Anti-forgery.** Every change must carry a header that a page on another site cannot add, and requests from other
  origins are refused. Session cookies are `HttpOnly` and `SameSite=Strict`.
- **Lockout.** Repeated failed sign-ins from one address are blocked for a while.
- **Secrets at rest.** API keys, VPN credentials and the tunnel's private key are encrypted with a key kept in a
  separate file from the database. The generated Compose file never contains them.
- **Audit log** of sign-ins, installs, VPN changes and invitations.
- **No shell.** Homeport runs Docker with argument lists, never through a shell, and every value that reaches a file
  or a command is validated first.
- **A hardened run command.** Read-only file system, no extra Linux capabilities, no privilege escalation (see the
  README). The end-to-end test runs with exactly these settings.
- **The VPN rule.** The download client only runs behind a VPN that Homeport has verified. The only way around it is a
  manual edit of `homeport.toml`.
- **Remote access** gives each person their own key and only the apps chosen for them. A firewall drops everything else
  coming from the tunnel, including traffic from a client file edited to reach more. The private key is shown once and
  never stored.

## What it does not do yet

- It has **not had an independent security review.** Do not expose it to the internet.
- The container **runs as root**, because the Docker socket needs it on most systems.
- There is **no HTTPS** of its own. If you put it behind a reverse proxy, terminate HTTPS there.
- The administrator can point the library at any folder on the host, because that is part of the job.
- Two-factor sign-in is not implemented.

## Outside connections

Besides pulling container images, Homeport contacts one outside service on its own: a public-address lookup
(`api.ipify.org`) during the VPN check, and when you click "Find my address" for remote access. There is no telemetry.
