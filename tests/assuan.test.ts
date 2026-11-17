import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "vitest";
import { runAssuanSession } from "../src/cli/assuan.js";

function response(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("Assuan web-pinentry bridge", () => {
    it("registers and resolves a password with correct Assuan encoding and source metadata", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let stdoutText = "";
        let stderrText = "";
        const posted: { value?: Record<string, unknown> } = {};

        stdout.on("data", (chunk: Buffer) => stdoutText += chunk.toString("utf8"));
        stderr.on("data", (chunk: Buffer) => stderrText += chunk.toString("utf8"));

        const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = String(input);

            if (url.endsWith("/internal/request")) {
                posted.value = JSON.parse(String(init?.body)) as Record<string, unknown>;
                return response(201, {
                    sessionId: "a".repeat(64),
                    expiresAt: Date.now() + 60_000,
                    url: "https://rbw.example.test",
                });
            }

            if (url.includes("/internal/wait/")) {
                return response(200, {
                    status: "approved",
                    password: "my%secret\npass",
                });
            }

            throw new Error(`Unexpected URL ${url}`);
        };

        const running = runAssuanSession(stdin, stdout, stderr, {
            daemonUrl: "http://127.0.0.1:3088",
            timeoutMs: 300_000,
            fetchImpl: fetchMock,
            clientName: "rbw-agent test",
            sourceName: "test-container",
            webUrl: "https://rbw.example.test",
        });
        stdin.write("SETTITLE rbw\n");
        stdin.write("SETPROMPT Master Password\n");
        stdin.write("SETDESC Please enter the master password for 'rbw'\n");
        stdin.write("GETPIN\n");
        stdin.end();
        await running;

        assert.equal(stdoutText, "OK\nOK\nOK\nOK\nD my%25secret%0Apass\nOK\n");
        assert.ok(stderrText.includes("Approval required: https://rbw.example.test"));
        assert.ok(!stderrText.includes("?t="));
        assert.equal(posted.value?.client, "rbw-agent test");
        assert.equal(posted.value?.source, "test-container");
        assert.equal(posted.value?.kind, "unlock");
    });

    it("abandons the active request if the CLI wait times out", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let abandoned = false;
        let stdoutText = "";

        stdout.on("data", (chunk: Buffer) => stdoutText += chunk.toString("utf8"));

        const fetchMock = async (input: string | URL | Request): Promise<Response> => {
            const url = String(input);

            if (url.endsWith("/internal/request")) {
                return response(201, {
                    sessionId: "a".repeat(64),
                    expiresAt: Date.now() + 60_000,
                    url: "https://rbw.example.test",
                });
            }

            if (url.includes("/internal/wait/")) {
                throw new Error("The operation was aborted due to timeout");
            }

            if (url.includes("/internal/abandon/")) {
                abandoned = true;
                return response(200, { abandoned: true });
            }

            throw new Error(`Unexpected URL ${url}`);
        };

        const running = runAssuanSession(stdin, stdout, stderr, {
            daemonUrl: "http://127.0.0.1:3088",
            timeoutMs: 10,
            fetchImpl: fetchMock,
        });
        stdin.write("GETPIN\n");
        stdin.end();
        await running;

        assert.equal(abandoned, true);
        assert.ok(stdoutText.includes("ERR 83886179 Operation cancelled <Pinentry>"));
    });

    for (const status of [409, 408, 410, 500]) {
        it(`maps daemon wait HTTP ${status} to an Assuan error without emitting a secret`, async () => {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            let stdoutText = "";
            let stderrText = "";

            stdout.on("data", (chunk: Buffer) => stdoutText += chunk.toString("utf8"));
            stderr.on("data", (chunk: Buffer) => stderrText += chunk.toString("utf8"));

            const fetchMock = async (input: string | URL | Request): Promise<Response> => {
                const url = String(input);

                if (url.endsWith("/internal/request")) {
                    return response(201, {
                        sessionId: "a".repeat(64),
                        expiresAt: Date.now() + 60_000,
                    });
                }

                if (url.includes("/internal/wait/")) {
                    return response(status, { status: "cancelled" });
                }

                if (url.includes("/internal/abandon/")) {
                    return response(200, { abandoned: true });
                }

                throw new Error(`Unexpected URL ${url}`);
            };

            const running = runAssuanSession(stdin, stdout, stderr, {
                daemonUrl: "http://127.0.0.1:3088",
                timeoutMs: 1_000,
                fetchImpl: fetchMock,
            });
            stdin.write("GETPIN\n");
            stdin.end();
            await running;

            assert.equal(stdoutText, "OK\nERR 83886179 Operation cancelled <Pinentry>\n");
            assert.ok(!stdoutText.includes("D "));

            if (status === 500) {
                assert.match(stderrText, /Unexpected wait status HTTP 500/);
            }
        });
    }

    it("maps daemon request rejection to an Assuan error without waiting", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let stdoutText = "";
        let stderrText = "";
        let fetches = 0;

        stdout.on("data", (chunk: Buffer) => stdoutText += chunk.toString("utf8"));
        stderr.on("data", (chunk: Buffer) => stderrText += chunk.toString("utf8"));

        const running = runAssuanSession(stdin, stdout, stderr, {
            daemonUrl: "http://127.0.0.1:3088",
            timeoutMs: 1_000,
            fetchImpl: async () => {
                fetches++;

                return response(429, { error: "Too many pending prompt sessions" });
            },
        });
        stdin.write("GETPIN\n");
        stdin.end();
        await running;

        assert.equal(fetches, 1);
        assert.equal(stdoutText, "OK\nERR 83886179 Operation cancelled <Pinentry>\n");
        assert.match(stderrText, /Daemon request failed with HTTP 429/);
    });
});
