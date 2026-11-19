# rbw Web Pinentry

A web-based pinentry for [`rbw`](https://github.com/doy/rbw), the unofficial
Bitwarden CLI. Instead of typing your master password into a terminal prompt,
`rbw`'s request appears in a small authenticated web inbox that you can open
from any device, including your phone.

It exists because terminal pinentry is awkward the moment the terminal is not
in front of you: an SSH session on a headless box, a long-running script, or a
`git commit -S` that suddenly blocks waiting for a password. The web inbox
turns that blocking prompt into something you can answer from wherever you are.

## How it works

A small Assuan-compatible bridge stands in for the pinentry program that `rbw`
would normally launch. When `rbw` needs a password, the bridge files a request
with a Fastify daemon and long-polls it; the daemon holds the request in memory
and publishes it to a React inbox over Server-Sent Events. When you approve the
request in the browser, the value travels back to the waiting `rbw` process.

Passwords are never persisted. Requests live in RAM only, and each one carries a
random 256-bit identifier so an approval applies to exactly one waiting process.

## Features

- **Answer prompts from another device.** A prompt raised on a headless server
  can be approved from a phone or laptop.
- **Several prompts at once.** Concurrent `rbw` clients each get their own
  request, listed in arrival order with client, source, PID, and a live countdown.
- **Prompt kinds are distinguished.** Requests are labelled Vault unlock, Vault
  login, Two-factor, API credential, Confirmation, or Pinentry request, with a
  filter bar to narrow the list, so you know what is being asked before you type
  anything.
- **Nothing is stored.** Requests and entered values are memory-only, with no
  database, audit log, or on-disk queue.
- **Stale prompts clean themselves up.** A client that dies or times out
  abandons its request instead of leaving it pending until expiry.

## Quick start

Requirements: Node.js 24 and pnpm, plus `rbw` already configured and working
with its normal pinentry.

```sh
pnpm install
pnpm build
PORT=3088 STATIC_DIR=dist-client pnpm start
```

Then open `http://localhost:3088`. The inbox requires an authenticated identity,
which the daemon reads from a `Remote-User` header in production; without one,
the API answers `403`. For local development see
[Running locally](#running-locally) below.

Point `rbw` at the bridge:

```sh
rbw config set pinentry /absolute/path/to/dist-server/src/cli/web-pinentry.js
```

The next time `rbw` needs a password, the request appears in the inbox instead
of the terminal.

## Configuration

The bridge and the daemon are configured separately.

Bridge, read by `web-pinentry`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_PINENTRY_DAEMON_URL` | `http://127.0.0.1:3088` | Daemon the bridge calls |
| `WEB_PINENTRY_PUBLIC_URL` | `http://localhost:3088` | URL printed in the approval message |
| `WEB_PINENTRY_TIMEOUT_MS` | `905000` | How long the bridge waits for approval |
| `PINENTRY_CLIENT_NAME` | `rbw-agent / web-pinentry` | Client label shown in the inbox |
| `PINENTRY_SOURCE_NAME` | container hostname | Source label shown in the inbox |

Daemon, read by the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3088` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `PROMPT_TTL_MS` | `900000` | How long a request stays approvable |
| `MAX_PENDING_SESSIONS` | `16` | Cap on simultaneous requests |
| `ALLOWED_USERS` | `operator` | Usernames accepted from the proxy header |
| `INTERNAL_ALLOWED_IPS` | loopback only | Peers permitted to call `/internal/*` |
| `STATIC_DIR` | `dist-client` | Built frontend assets |

Keep the bridge timeout slightly above the request TTL, so the browser side is
never the first to give up.

## Deployment

The daemon is a long-running service and expects to sit behind a reverse proxy
that authenticates users and adds a `Remote-User` header, such as Caddy with
forward-auth. It must not be exposed directly to the internet: it trusts that
header because the proxy is what guarantees it.

Two protections are built in and worth preserving in any deployment:

- `/internal/*` endpoints refuse requests carrying forwarding or proxy-identity
  headers and only answer allowlisted peer addresses, so they cannot be reached
  through the public route.
- Browser API responses are `no-store`.

A container image is included. The build expects the repository as its context:

```sh
docker build -t rbw-web-pinentry .
docker run -d --name rbw-web-pinentry \
  -p 3088:3088 \
  -e ALLOWED_USERS=you \
  -e PROMPT_TTL_MS=900000 \
  rbw-web-pinentry
```

The container itself does not terminate TLS or provide authentication; put it
behind your proxy.

## Running locally

For development the daemon accepts a fallback identity header so you do not need
a proxy:

```sh
pnpm dev        # Vite frontend on port 3088
pnpm dev:server # Fastify API on port 3089 with DEV_REMOTE_USER
```

The Vite dev server proxies `/api` and `/internal` to the Fastify server, and the
fallback identity is only honored when `NODE_ENV=development`.

## Development

```sh
pnpm typecheck
pnpm test              # includes the isolated real-rbw integration suite
pnpm test:integration  # real-rbw tests only
pnpm check             # lint and formatting
pnpm build
```

The code is split into four areas:

- `src/client/` - React 19 inbox UI, built with Vite and Tailwind CSS v4
- `src/server/` - Fastify API, in-memory sessions, authentication, static serving
- `src/cli/` - the `web-pinentry` bridge that speaks the Assuan protocol
- `src/shared/` - prompt metadata and value encoding shared by both sides

`pnpm test` compiles the bridge first, then runs Vitest. The integration suite
starts the real `rbw` binary against a synthetic Vaultwarden fixture inside a
temporary profile, so it never touches a real vault, account, or credential.

See [`docs/architecture.md`](docs/architecture.md) for request flow, security
boundaries, and the integration harness in more detail.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Taruna Prasetya.
