import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
    describeRequest,
    selectNewRequests,
    shouldAnnounce,
} from "../src/client/ui/notifications.js";
import type { PromptView } from "../src/shared/protocol.js";

function makePrompt(overrides: Partial<PromptView> = {}): PromptView {
    return {
        sessionId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        title: "rbw",
        prompt: "Master Password",
        desc: "Unlock the local database for 'rbw'",
        error: null,
        client: "rbw-agent / web-pinentry",
        source: "openclaw",
        kind: "unlock",
        createdAt: 1_000,
        expiresAt: 901_000,
        remainingMs: 900_000,
        pid: 1234,
        ...overrides,
    };
}

describe("selectNewRequests", () => {
    it("returns only requests whose ids were not seen yet", () => {
        const seen = new Set(["a", "b"]);
        const fresh = selectNewRequests(seen, [
            makePrompt({ sessionId: "a" }),
            makePrompt({ sessionId: "c" }),
            makePrompt({ sessionId: "b" }),
            makePrompt({ sessionId: "d" }),
        ]);

        assert.deepEqual(fresh.map(request => request.sessionId), ["c", "d"]);
    });

    it("returns nothing when every request is already known", () => {
        const seen = new Set(["a", "b"]);
        const fresh = selectNewRequests(seen, [
            makePrompt({ sessionId: "a" }),
            makePrompt({ sessionId: "b" }),
        ]);

        assert.equal(fresh.length, 0);
    });

    it("treats an empty known set as everything being new", () => {
        const fresh = selectNewRequests(new Set(), [makePrompt({ sessionId: "z" })]);

        assert.equal(fresh.length, 1);
    });
});

describe("describeRequest", () => {
    it("names the prompt kind, subject, client, source, and short id", () => {
        const { title, body } = describeRequest(makePrompt(), "Vault unlock");

        assert.equal(title, "Vault unlock requested");
        assert.match(body, /Master Password/);
        assert.match(body, /rbw-agent \/ web-pinentry/);
        assert.match(body, /openclaw/);
        assert.match(body, /#01234567/);
    });

    it("falls back to the title when the prompt is blank", () => {
        const { body } = describeRequest(makePrompt({
            prompt: "  ",
            title: "rbw unlock",
        }), "Vault unlock");

        assert.match(body, /rbw unlock/);
    });

    it("never includes the session id in full", () => {
        const request = makePrompt();
        const { body } = describeRequest(request, "Vault unlock");

        assert.equal(body.includes(request.sessionId), false);
    });

    it("marks unknown metadata instead of leaving gaps", () => {
        const { body } = describeRequest(
            makePrompt({
                title: "",
                prompt: "",
                client: "",
                source: "",
            }),
            "Pinentry request",
        );

        assert.match(body, /Pinentry request/);
        assert.match(body, /unknown client/);
        assert.match(body, /unknown source/);
    });
});

describe("shouldAnnounce", () => {
    it("stays quiet unless alerts are enabled and granted", () => {
        assert.equal(shouldAnnounce("granted", false, "hidden", false), false);
        assert.equal(shouldAnnounce("default", true, "hidden", false), false);
        assert.equal(shouldAnnounce("denied", true, "hidden", false), false);
        assert.equal(shouldAnnounce("unsupported", true, "hidden", false), false);
    });

    it("announces while the tab is hidden", () => {
        assert.equal(shouldAnnounce("granted", true, "hidden", false), true);
    });

    it("stays quiet when the inbox is already visible and focused", () => {
        assert.equal(shouldAnnounce("granted", true, "visible", true), false);
    });

    it("announces a visible but unfocused tab", () => {
        assert.equal(shouldAnnounce("granted", true, "visible", false), true);
    });
});
