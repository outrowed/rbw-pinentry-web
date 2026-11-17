import assert from "node:assert/strict";
import { createServer } from "node:net";
import { afterEach, describe, it } from "vitest";
import { createDaemon } from "../src/server/app.js";
import type { CreatePromptRequest } from "../src/shared/protocol.js";

const allowedUsers = new Set(["operator"]);
const internalAllowedIps = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const prompt: CreatePromptRequest = {
    title: "rbw",
    prompt: "Master Password",
    desc: "Unlock local vault",
    error: null,
    client: "rbw-agent",
    source: "worker-1",
    kind: "unlock",
    pid: 42,
};

async function getFreePort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", resolve);
        server.on("error", reject);
    });

    const address = server.address();

    if (!address || typeof address === "string") {
        throw new Error("Could not read free port");
    }

    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

    return address.port;
}

describe("Fastify pinentry API", () => {
    const daemons: Array<ReturnType<typeof createDaemon>> = [];

    const start = async (overrides: {
        promptTtlMs?: number;
        maxPendingSessions?: number;
    } = {}): Promise<{
        baseUrl: string;
        daemon: ReturnType<typeof createDaemon>;
    }> => {
        const port = await getFreePort();
        const daemon = createDaemon({
            host: "127.0.0.1",
            port,
            promptTtlMs: overrides.promptTtlMs ?? 2_000,
            maxPendingSessions: overrides.maxPendingSessions ?? 5,
            allowedUsers,
            internalAllowedIps,
            clientName: "web-pinentry-test",
            sourceName: "test-host",
            staticDir: "public",
        });
        daemons.push(daemon);
        await daemon.app.listen({
            port,
            host: "127.0.0.1",
        });

        return {
            baseUrl: `http://127.0.0.1:${port}`,
            daemon,
        };
    };

    afterEach(async () => {
        await Promise.all(daemons.splice(0).map(daemon => daemon.close()));
    });

    it("serves authenticated concurrent request inbox without tokens and resolves by session ID", async () => {
        const { baseUrl, daemon } = await start();
        const first = daemon.store.create(prompt);
        const second = daemon.store.create({
            ...prompt,
            source: "test-host-2",
            prompt: "Authenticator code",
            kind: "two-factor",
        });
        const headers = { "Remote-User": "operator" };

        const denied = await fetch(`${baseUrl}/api/requests`);
        assert.equal(denied.status, 403);

        const inbox = await fetch(`${baseUrl}/api/requests`, { headers });
        assert.equal(inbox.status, 200);
        const body = await inbox.json() as { requests: Array<{
            source: string;
            sessionId: string;
        }>; };
        assert.deepEqual(body.requests.map(request => request.source), ["worker-1", "test-host-2"]);
        assert.deepEqual(body.requests.map(request => request.sessionId), [first.sessionId, second.sessionId]);
        const firstRequest = body.requests[0];
        assert.ok(firstRequest);
        assert.equal("token" in firstRequest, false);

        const response = await fetch(`${baseUrl}/api/requests/${first.sessionId}/resolve`, {
            method: "POST",
            headers: {
                ...headers,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                action: "approve",
                value: "test-pass",
            }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await daemon.store.waitForResult(first.sessionId), {
            status: "approved",
            password: "test-pass",
        });
    });

    it("rejects internal requests forwarded through a proxy", async () => {
        const { baseUrl } = await start();
        const response = await fetch(`${baseUrl}/internal/request`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Forwarded-For": "203.0.113.1",
            },
            body: JSON.stringify(prompt),
        });
        assert.equal(response.status, 403);
    });

    it("bounds pending sessions with HTTP 429 and preserves the existing request", async () => {
        const { baseUrl, daemon } = await start({ maxPendingSessions: 1 });
        const first = await fetch(`${baseUrl}/internal/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(prompt),
        });
        assert.equal(first.status, 201);
        const created = await first.json() as { sessionId: string };
        const overflow = await fetch(`${baseUrl}/internal/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(prompt),
        });
        assert.equal(overflow.status, 429);
        assert.deepEqual(daemon.store.list().map(request => request.sessionId), [created.sessionId]);
    });

    it("rejects malformed JSON without creating a request", async () => {
        const { baseUrl, daemon } = await start();
        const malformed = await fetch(`${baseUrl}/internal/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{not json",
        });
        assert.equal(malformed.status, 400);
        assert.equal(daemon.store.pendingCount, 0);
    });

    it("rejects oversized prompt bodies with HTTP 413", async () => {
        const { baseUrl, daemon } = await start();
        const oversized = await fetch(`${baseUrl}/internal/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...prompt,
                desc: "a".repeat(9_000),
            }),
        });
        assert.equal(oversized.status, 413);
        assert.equal(daemon.store.pendingCount, 0);
    });

    it("returns HTTP 404 for unknown waiters and HTTP 410 for stale browser actions", async () => {
        const { baseUrl, daemon } = await start();
        const unknown = await fetch(`${baseUrl}/internal/wait/${"a".repeat(64)}`);
        assert.equal(unknown.status, 404);
        const created = daemon.store.create(prompt);
        assert.equal(daemon.store.cancelBySessionId(created.sessionId), true);
        const stale = await fetch(`${baseUrl}/api/requests/${created.sessionId}/resolve`, {
            method: "POST",
            headers: {
                "Remote-User": "operator",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                action: "approve",
                value: "unused",
            }),
        });
        assert.equal(stale.status, 410);
    });

    it("rejects invalid browser actions without consuming the request", async () => {
        const { baseUrl, daemon } = await start();
        const created = daemon.store.create(prompt);
        const endpoint = `${baseUrl}/api/requests/${created.sessionId}/resolve`;

        const post = (body: unknown, user?: string): Promise<Response> => fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(user ? { "Remote-User": user } : {}),
            },
            body: JSON.stringify(body),
        });

        assert.equal((await post({
            action: "approve",
            value: "secret",
        })).status, 403);
        assert.equal((await post({
            action: "approve",
            value: "secret",
        }, "other")).status, 403);
        assert.equal((await post({
            action: "approve",
            value: "",
        }, "operator")).status, 400);
        assert.equal((await post({
            action: "unknown",
            value: "secret",
        }, "operator")).status, 400);
        assert.equal(daemon.store.pendingCount, 1);
    });

    it("propagates TTL expiration as HTTP 408 and removes the browser request", async () => {
        const { baseUrl, daemon } = await start({ promptTtlMs: 90 });
        const created = daemon.store.create(prompt);
        const expired = await fetch(`${baseUrl}/internal/wait/${created.sessionId}`);
        assert.equal(expired.status, 408);
        assert.deepEqual(await expired.json(), { status: "expired" });
        assert.equal(daemon.store.pendingCount, 0);
        assert.deepEqual(daemon.store.list(), []);
    });

    it("returns Assuan waiter cancellation on browser cancel", async () => {
        const { baseUrl } = await start();
        const created = await fetch(`${baseUrl}/internal/request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(prompt),
        }).then(response => response.json() as Promise<{ sessionId: string }>);
        const waiting = fetch(`${baseUrl}/internal/wait/${created.sessionId}`);

        const response = await fetch(`${baseUrl}/api/requests/${created.sessionId}/resolve`, {
            method: "POST",
            headers: {
                "Remote-User": "operator",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ action: "cancel" }),
        });
        assert.equal(response.status, 200);
        assert.equal((await waiting).status, 409);
    });

    it("streams an authenticated inbox snapshot and prompt lifecycle over SSE", async () => {
        const { baseUrl, daemon } = await start();
        const denied = await fetch(`${baseUrl}/api/events`);
        assert.equal(denied.status, 403);

        const controller = new AbortController();
        const events = await fetch(`${baseUrl}/api/events`, {
            headers: { "Remote-User": "operator" },
            signal: controller.signal,
        });
        assert.equal(events.status, 200);
        assert.match(events.headers.get("content-type") ?? "", /^text\/event-stream/);
        assert.ok(events.body);
        const reader = events.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const nextEvent = async (): Promise<Array<{
            sessionId: string;
            source: string;
        }>> => {
            while (!buffer.includes("\n\n")) {
                const chunk = await reader.read();
                assert.equal(chunk.done, false, "SSE connection closed unexpectedly");
                buffer += decoder.decode(chunk.value, { stream: true });
            }

            const index = buffer.indexOf("\n\n");
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            assert.match(frame, /^event: requests\ndata: /);

            return JSON.parse(frame.slice("event: requests\ndata: ".length)) as Array<{
                sessionId: string;
                source: string;
            }>;
        };

        try {
            assert.deepEqual(await nextEvent(), []);
            const first = daemon.store.create(prompt);
            assert.deepEqual((await nextEvent()).map(request => request.sessionId), [first.sessionId]);
            const second = daemon.store.create({
                ...prompt,
                source: "worker-2",
            });
            assert.deepEqual((await nextEvent()).map(request => request.source), ["worker-1", "worker-2"]);
            assert.equal(daemon.store.cancelBySessionId(first.sessionId), true);
            assert.deepEqual((await nextEvent()).map(request => request.sessionId), [second.sessionId]);
            assert.equal(daemon.store.abandonBySessionId(second.sessionId), true);
            assert.deepEqual(await nextEvent(), []);
        }
        finally {
            controller.abort();
            await reader.cancel().catch(() => undefined);
        }
    }, 5_000);
});
