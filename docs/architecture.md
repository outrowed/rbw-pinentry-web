# rbw Web Pinentry

## Project shape

`rbw-web-pinentry` is the active Fastify/React implementation. The process serves the compiled React/Vite frontend and the internal HTTP API consumed by a GnuPG Assuan-compatible CLI bridge.

- `src/client/`: React 19 inbox UI, built by Vite with Tailwind CSS v4.
- `src/server/`: Fastify API, memory-only prompt sessions, authentication checks, static serving and SSE updates.
- `src/cli/`: `web-pinentry` bridge speaking the `rbw` Assuan protocol over stdin/stdout.
- `src/shared/`: prompt metadata and Assuan value encoding shared between app layers.

## Visual style

The inbox borrows early-web bulletin-board conventions: centered brand/header, warm pale background, plain white panels, compact content, thin dark-red borders, peach section bars, and square controls. Typography is limited to `"Helvetica Neue", system-ui`; no other font family or downloaded font is used. The live request list stays scrollable within the panel, with visible client/source metadata and a one-second countdown.

## Request flow

1. A client launches `web-pinentry`; the bridge parses Assuan `SETTITLE`, `SETPROMPT`, `SETDESC`, `SETERROR` and `GETPIN`.
2. On `GETPIN`, the bridge creates an internal request with client/source/PID metadata and prints only a short request ID to stderr. It long-polls a distinct internal request ID.
3. Fastify stores each request independently in RAM and publishes inbox changes through `/api/events` (SSE).
4. The React inbox shows active prompts in arrival order. The authenticated user's action resolves exactly one prompt by request ID; the associated waiter receives the value or cancellation. Each request is identified by a random 256-bit ID, and the inbox authenticates through the proxy identity gate plus that per-request ID.
5. When a client wait aborts or times out, it best-effort abandons the pending request. TTL expiry remains a server-side cleanup fallback.

The inbox shows the request's client name, source label, PID, prompt/description/error, start time, and live TTL countdown. Prompt kind is inferred from the Assuan-provided title and description; it is a display hint, not a cryptographic identity assertion.

## Security boundaries

- Browser API and SSE require the trusted `Remote-User` identity added by Caddy Authelia forward-auth. The backend only trusts this header because the public route is expected to be reverse-proxied by Caddy; direct container exposure must remain network-restricted.
- Internal bridge endpoints require an allowlisted peer address and reject proxy-identity/forwarding headers. Caddy must not route public paths to `/internal/*`.
- Passwords and one-time codes are submitted to an authenticated, random per-request ID and held in memory for the waiting request only. No persistence or audit log contains entered values.
- Per-request IDs are random 256-bit identifiers. The inbox resolves actions by ID plus the trusted Authelia-authenticated user identity. API responses remain `no-store`.
- Concurrent clients are supported, but each user action applies to exactly one selected request and one waiter. Do not auto-approve or retry credentials.

## Development and verification

```sh
pnpm install
pnpm dev                 # Vite frontend on port 3088
pnpm dev:server          # Fastify API separately
pnpm typecheck
pnpm test                # includes the real-rbw isolated integration suite
pnpm test:integration    # real-rbw tests only
pnpm build
pnpm check
```

The Vite dev server proxies `/api` and `/internal` to the Fastify server on port 3089; the development server accepts a `DEV_REMOTE_USER` header fallback only in development mode. Production builds place Vite assets in `dist-client/` and server output in `dist-server/`.

### Isolated rbw integration harness

The suite mixes fast unit tests with one slow test that drives the real `rbw` binary.
Running `pnpm test` compiles the bridge first, then runs Vitest.

| File | What it covers |
| --- | --- |
| `tests/protocol.test.ts` | Prompt-kind inference from the Assuan title and description: unlock, login (including device registration), two-factor (authenticator, email PIN, YubiKey, TOTP), API key, confirmation, and the unrecognized fallback |
| `tests/session-store.test.ts` | Session lifecycle: concurrent prompts with separate expiry, resolving the right waiter by request ID, change notification, capacity limits, stale-id rejection, and cleanup of aborted and abandoned clients without disturbing the others |
| `tests/daemon.test.ts` | The Fastify HTTP surface against a real server: the authenticated `/api/events` SSE snapshot and lifecycle, creation, cancellation, and abandonment, plus error responses for proxy-forwarded internal calls, capacity (`429`), malformed JSON, oversized bodies (`413`), unknown waiters (`404`), stale actions (`410`), invalid actions, and TTL expiry (`408`) |
| `tests/assuan.test.ts` | The bridge: correct Assuan encoding and source metadata, abandoning on wait timeout, HTTP-status-to-error mapping without leaking a secret, request rejection, the closed-stdout warning, and the upstream socket-panic warning when a real subprocess is killed mid-prompt |
| `tests/integration/rbw.test.ts` | One end-to-end path through the real `rbw` 1.15.0 binary against a synthetic Vaultwarden |

#### What the integration test actually does

It walks a full login-to-signing path, not just a single prompt:

1. Registers and logs in against the synthetic Vaultwarden, rejecting one wrong
   master password first and retrying to prove the error path works.
2. Answers a two-factor challenge (the authenticator-code prompt).
3. Syncs and stores a synthetic SSH key.
4. Locks and unlocks the vault, then signs an SSH challenge through the
   `rbw-agent` socket, which raises a fresh unlock prompt through the bridge.

All values are fixtures. No real vault, account, or credential is involved.

#### How isolation works

Each run gets a fresh temporary directory with its own `HOME`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, and a
random `RBW_PROFILE`. That keeps the test's agent socket, cache, config, device
ID, and logs separate from your real `rbw` profile.

`rbw` is pointed at a small generated `sh` wrapper that execs the compiled
bridge, so the test exercises the same entry point a real installation uses.

Teardown stops that profile's agent, closes the daemon and the fixture server,
and removes the temporary directory - including the generated SSH key. If a run
is interrupted, check for a leftover `rbw` agent started from a temporary
profile before assuming your own agent is at fault.

Set `RBW_TEST_BINARY` to test a different `rbw` build. Never point it at a
wrapper that drops the test environment variables; that would run against your
real profile instead of the isolated one.

#### What this suite does not prove

It is real `rbw`/Assuan/Fastify integration, but the Vaultwarden in front of it is
a local fixture. It does not verify your actual Vaultwarden server, nor the
Caddy/Authelia route in front of the daemon. The live service is managed
separately in `/home/taruna/srv/rbw-web-pinentry`; see workspace `INFRA.md` for
its current deployment details.
