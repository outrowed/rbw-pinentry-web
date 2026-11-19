# rbw Web Pinentry

## Project shape

`rbw-web-pinentry` is the active Fastify/React implementation. The previous server-rendered service is preserved at `rbw-web-pinentry-legacy`. The process serves the compiled React/Vite frontend and the internal HTTP API consumed by a GnuPG Assuan-compatible CLI bridge.

- `src/client/`: React 19 inbox UI, built by Vite with Tailwind CSS v4.
- `src/server/`: Fastify API, memory-only prompt sessions, authentication checks, static serving and SSE updates.
- `src/cli/`: `web-pinentry` bridge speaking the `rbw` Assuan protocol over stdin/stdout.
- `src/shared/`: prompt metadata and Assuan value encoding shared between app layers.

## Visual style

The inbox borrows early-web bulletin-board conventions: centered brand/header, warm pale background, plain white panels, compact content, thin dark-red borders, peach section bars, and square controls. Typography is limited to `"Helvetica Neue", system-ui`; no other font family or downloaded font is used. The live request list stays scrollable within the panel, with visible client/source metadata and a one-second countdown.

## Request flow

1. A client launches `web-pinentry`; the bridge parses Assuan `SETTITLE`, `SETPROMPT`, `SETDESC`, `SETERROR` and `GETPIN`.
2. On `GETPIN`, the bridge creates an internal request with client/source/PID metadata and prints only a short request ID to stderr (never the bearer token). It long-polls a distinct internal request ID.
3. Fastify stores each request independently in RAM and publishes inbox changes through `/api/events` (SSE).
4. The React inbox shows active prompts in arrival order. The authenticated user's action resolves exactly one prompt by request ID; the associated waiter receives the value or cancellation. Each request is identified by a random 256-bit ID; the inbox uses the authentication gate plus that per-request ID and does not expose any additional approval token.
5. When a client wait aborts or times out, it best-effort abandons the pending request. TTL expiry remains a server-side cleanup fallback.

The inbox shows the request's client name, source label, PID, prompt/description/error, start time, and live TTL countdown. Prompt kind is inferred from the Assuan-provided title and description; it is a display hint, not a cryptographic identity assertion.

## Legacy comparison

The previous server-rendered service is preserved in the `rbw-web-pinentry-legacy` checkout and remains the deployed backend until migration is verified. Its package name and specification are now marked legacy; the deployed container keeps its original image and service name.

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

`pnpm test` builds the CLI bridge before running Vitest. `tests/protocol.test.ts` covers prompt-kind inference, including rbw's password, authenticator, email-code, YubiKey, and API-key labels. `tests/daemon.test.ts` opens a real Fastify `/api/events` SSE stream and checks the initial snapshot, prompt creation, cancellation, and abandonment with an authenticated `Remote-User` header. It also verifies HTTP failures for capacity, malformed/oversized input, unknown or stale requests, invalid actions, and expiry. `tests/assuan.test.ts` checks CLI error mapping for request rejection, cancelled/expired/abandoned waits, and unexpected daemon failures. `tests/integration/rbw.test.ts` starts the installed `rbw` 1.15.0 binary against a loopback-only synthetic Vaultwarden fixture. It exercises a rejected master password followed by a retry, then an authenticator-code challenge, a synthetic database sync, a lock/unlock round trip, and an SSH signing request through the agent socket that triggers a fresh unlock prompt using the real Assuan bridge. All values are test fixtures; no real vault, account, or credentials are used.

The harness generates a fresh random `RBW_PROFILE` and temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, and `XDG_RUNTIME_DIR`. This keeps the test agent socket, cache, config, device ID, and logs separate from the real `rbw` profile. A temporary executable wrapper invokes the compiled CLI. After each test the harness stops its own profile agent and removes the temporary directory. Set `RBW_TEST_BINARY` if `rbw` is not on `PATH`; never point it at a wrapper that silently drops the test environment variables.

This is real `rbw`/Assuan/Fastify integration against a fake Vaultwarden protocol endpoint, not an authentication test of the deployed Vaultwarden or Caddy/Authelia route. The live service is managed separately in `/home/taruna/srv/rbw-web-pinentry`; see workspace `INFRA.md` for its current deployment details.
