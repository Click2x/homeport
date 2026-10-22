# Homeport experience

**Status: draft. Nothing here is built.** This describes how Homeport should feel to a complete beginner. [DESIGN.md](DESIGN.md) covers the machinery.

Homeport is a standalone product. It needs no account, no cloud service and no other app. The goal is to replace the usual setup ritual (pick apps, map folders, copy API keys between them) with a short, friendly, guided flow that ends with a working stack.

## Principles

1. **Goals, not apps.** People say "I want to watch my movies anywhere," not "install Sonarr."
2. **Plain language, with detail one click away.** Simple mode explains in everyday words. Advanced mode shows images, ports, volumes and the generated compose file.
3. **Nothing happens without a click.** Homeport shows what it is about to do and why, and the user confirms.
4. **Safe by default, with a deliberate way out.** Risky choices are not hidden. Turning off a protection means editing a config file, never clicking a toggle.
5. **Local and private.** No telemetry and no cloud calls.
6. **Honest about its state.** When something is not set up, not working or not checked, the interface says so plainly.

## The flow

### 1. What do you want to do?
The first screen asks, with big choices and a free-text box: `Watch movies & shows`, `Photos & backups`, `Block ads`, `Smart home`, `Passwords`, `Something else`. Each choice maps to a bundle of services. Free text is matched to goals by keywords; if nothing matches, Homeport says so and shows the choices again.

### 2. The plan
A plan card lists what will be installed, in plain names with a one-line purpose, plus rough disk and memory needs and what is optional. Advanced mode adds the technical details and a "download compose file" button, so nobody is locked in.

### 3. Storage
Homeport checks the drive and explains the result in plain words, recommending a tier (see DESIGN.md). A "Check my storage" button reruns the full checker whenever something seems off, and each failure comes with an automatic or guided fix.

### 4. Downloads need a VPN
If the plan includes a BitTorrent client, Homeport always says this plainly:

> Downloading with BitTorrent exposes your home IP address to everyone sharing the file, and your internet provider can see it. Please only run it behind a VPN. We'll set that up with you now, and the download client won't start until the VPN is confirmed working. You're responsible for what you download and for the laws that apply to you.

- The VPN step is part of the plan, not an afterthought. After the user enters their provider settings, Homeport runs the **kill-switch check**: the client must share the VPN's network, the firewall must default to DROP, and the exit IP must differ from the home IP.
- The download client is held back until that check passes and is re-checked on a schedule.
- **There is no "skip" button.** A person who has decided to run without a VPN must edit the config file themselves:

  ```toml
  # homeport.toml
  [downloads]
  allow_unprotected = false   # set to true and restart to run without a VPN
  ```

  Homeport points to the file and explains the risk, but never changes it for the user.

### 5. Deploy
Live progress with plain-language steps. Failures say what went wrong in everyday words (for example "port 8080 is already used by another program") and offer a fix.

### 6. Finish with proof
A dashboard with a link to every service, health status, and a first "request a movie" test that shows the whole chain working.

### 7. Everything after
Updates, backups, health alerts, adding services and remote access (WireGuard with QR invites, or Tailscale) all live in the same interface.

## Config summary
| File | Setting | Default | Effect |
|---|---|---|---|
| `homeport.toml` | `downloads.allow_unprotected` | `false` | The BitTorrent client only starts after a verified VPN |

## Decisions still to make
- Exact wording of the VPN notice. It needs a legal read before the first release.
- Whether goal matching stays keyword-based or gains something smarter.
- How much of the flow Simple mode may hide versus ask.
