import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import type { CreatePromptRequest } from "../src/shared/protocol.js";
import { PromptSessionStore } from "../src/server/session-store.js";

const prompt = (overrides: Partial<CreatePromptRequest> = {}): CreatePromptRequest => ({
    title: "rbw",
    prompt: "Master Password",
    desc: "Unlock local vault",
    error: null,
    client: "rbw-agent",
    source: "host-a",
    kind: "unlock",
    pid: 1234,
    ...overrides,
});

describe("PromptSessionStore", () => {
    const stores: PromptSessionStore[] = [];

    const createStore = (ttlMs = 10_000, maxPendingSessions = 4): PromptSessionStore => {
        const store = new PromptSessionStore({
            ttlMs,
            maxPendingSessions,
        });
        stores.push(store);

        return store;
    };

    afterEach(() => {
        for (const store of stores.splice(0)) {
            store.clearAll();
        }
    });

    it("stores concurrent prompts with source metadata and separate expiry", () => {
        const store = createStore();
        const first = store.create(prompt({ source: "host-a" }));
        const second = store.create(prompt({
            prompt: "Authenticator code",
            source: "host-b",
            kind: "two-factor",
        }));

        assert.equal(store.pendingCount, 2);
        assert.deepEqual(store.list().map(item => item.source), ["host-a", "host-b"]);
        assert.deepEqual(store.list().map(item => item.kind), ["unlock", "two-factor"]);
        assert.notEqual(first.sessionId, second.sessionId);
        const listed = store.list();
        assert.ok(listed[0]);
        assert.equal("token" in listed[0], false);
    });

    it("resolves the right waiting client by isolated request ID", async () => {
        const store = createStore();
        const first = store.create(prompt({ source: "worker-a" }));
        const second = store.create(prompt({ source: "worker-b" }));
        const firstWait = store.waitForResult(first.sessionId);
        const secondWait = store.waitForResult(second.sessionId);

        assert.equal(store.approveBySessionId(second.sessionId, "code-for-b"), true);
        assert.equal(store.cancelBySessionId(first.sessionId), true);
        assert.deepEqual(await secondWait, {
            status: "approved",
            password: "code-for-b",
        });
        assert.deepEqual(await firstWait, { status: "cancelled" });
    });

    it("publishes changes when prompts arrive, resolve, and expire", async () => {
        const store = createStore(70);
        let changeCount = 0;
        const unsubscribe = store.subscribe(() => changeCount++);
        const created = store.create(prompt());

        assert.equal(changeCount, 1);
        const result = await store.waitForResult(created.sessionId);
        assert.deepEqual(result, { status: "expired" });
        assert.equal(changeCount, 2);
        unsubscribe();
    });

    it("enforces max pending requests and rejects stale request IDs", () => {
        const store = createStore(10_000, 1);
        const created = store.create(prompt());

        assert.throws(() => store.create(prompt()), RangeError);
        assert.equal(store.cancelBySessionId(created.sessionId), true);
        assert.equal(store.approveBySessionId(created.sessionId, "stale"), false);
    });

    it("cleans up an aborted wait request and preserves other concurrent clients", async () => {
        const store = createStore();
        const first = store.create(prompt({ source: "client-a" }));
        const second = store.create(prompt({ source: "client-b" }));
        const controller = new AbortController();
        const firstWait = store.waitForResult(first.sessionId, controller.signal);
        const secondWait = store.waitForResult(second.sessionId);

        controller.abort();

        assert.deepEqual(await firstWait, { status: "abandoned" });
        assert.deepEqual(store.list().map(item => item.source), ["client-b"]);
        assert.equal(store.approveBySessionId(second.sessionId, "still-active"), true);
        assert.deepEqual(await secondWait, {
            status: "approved",
            password: "still-active",
        });
    });

    it("cleans up an abandoned foreground client request", async () => {
        const store = createStore();
        const created = store.create(prompt());
        const wait = store.waitForResult(created.sessionId);

        assert.equal(store.abandonBySessionId(created.sessionId), true);
        assert.deepEqual(await wait, { status: "abandoned" });
        assert.equal(store.pendingCount, 0);
    });
});
