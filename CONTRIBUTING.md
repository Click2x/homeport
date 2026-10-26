# Contributing

Thank you for helping. Homeport is aimed at complete beginners, so the bar for wording, error messages and
accessibility is as important as the code.

## Set up

You need Node 20 or newer (22 is what the project is tested on) and, for the end-to-end tests, Docker.

```bash
git clone https://github.com/Click2x/homeport.git
cd homeport
npm install
npm test           # unit and interface tests, no Docker needed
npm run typecheck
npm run lint       # Biome; `npm run format` fixes what it can
npm run build
```

The end-to-end scripts start real containers and download images. They are not part of every pull request, but run
the relevant one if you change that area:

| If you change… | Run |
|---|---|
| Wiring between apps, the deploy flow, the API | `npm run e2e:server` |
| The VPN gate | `npm run e2e:vpn` |
| Remote access or the sidecar in `docker/wireguard` | `npm run e2e:wireguard` |

## How the code is organised

See the table in the [README](README.md#development). In short: `core` describes services, `engine` turns a plan into
Compose and checks storage and the VPN, `connectors` wires the apps together, `server` is the API, `web` is the
interface.

## Adding a service

A service is one YAML file in [`packages/core/manifests/`](packages/core/manifests). Copy a similar one, and keep:

- a plain-language `purpose` a beginner understands,
- the app's **own settings in a named volume** (`kind: config`), never a host folder,
- an exact image **digest** (`digest: sha256:…`) plus the tested version, so installs are reproducible,
- `vpn: required` for anything that must run behind the VPN.

The catalog test checks every manifest. If the service needs to be linked to others after install, that is a
connector in `packages/connectors`, with a test against the in-memory fakes and an addition to the end-to-end script.

## Principles to keep

- **Honesty.** The interface and docs say what is not done, not tested or not safe.
- **Plain language.** Error messages say what happened and what to do, with no jargon.
- **The model never acts.** Nothing that suggests an action may perform it without a click from the person.
- **Safe by default, with a deliberate way out.** Lowering a protection means editing a file, never a toggle.
- **Idempotent.** Running any step again must change nothing that is already right.
- **No secrets in logs, errors, the browser or the exported Compose file.**

## Pull requests

Keep them focused, include tests, and describe what you ran. By contributing you agree that your work is licensed
under the project's [AGPL-3.0](LICENSE).
