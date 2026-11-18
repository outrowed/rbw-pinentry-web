import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

    it("warns on a closed stdout pipe without crashing the pinentry process", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let stderrText = "";
        stderr.on("data", (chunk: Buffer) => stderrText += chunk.toString("utf8"));
        const originalStderrWrite = process.stderr.write.bind(process.stderr);
        const processWarnings: string[] = [];
        process.stderr.write = ((chunk: string | Uint8Array) => {
            processWarnings.push(String(chunk));

            return true;
        }) as typeof process.stderr.write;
        stdout.write = (() => {
            const error = new Error("write EPIPE") as NodeJS.ErrnoException;
            error.code = "EPIPE";
            throw error;
        }) as typeof stdout.write;

        try {
            await runAssuanSession(stdin, stdout, stderr, {
                daemonUrl: "http://127.0.0.1:3088",
                timeoutMs: 1_000,
                fetchImpl: async () => response(503, {}),
            });
        }
        finally {
            process.stderr.write = originalStderrWrite;
        }

        const warnings = processWarnings.join("");
        assert.match(warnings, /stdout closed \(EPIPE\)/);
        assert.match(warnings, /rbw-agent may log a socket 'Broken pipe' panic/);
        assert.equal(stderrText.includes("fatal"), false);
    });

    it("warns that an agent socket panic is upstream when a real subprocess is terminated mid-prompt", async () => {
        const directory = await mkdtemp(join(tmpdir(), "pinentry-signal-"));
        const script = join(directory, "pinentry.mjs");
        const stderrPath = join(directory, "stderr.log");
        const daemonUrl = "http://127.0.0.1:3088";
        await writeFile(script, [
            `import { runAssuanSession } from ${JSON.stringify(resolve("dist-server/src/cli/assuan.js"))};`,
            "import { PassThrough } from 'node:stream';",
            "import { createWriteStream } from 'node:fs';",
            "const out = createWriteStream(process.argv[2]);",
            "const stdin = new PassThrough();",
            "const stdout = new PassThrough();",
            "const running = runAssuanSession(stdin, stdout, out, {",
            `  daemonUrl: ${JSON.stringify(daemonUrl)},`,
            "  timeoutMs: 30000,",
            "  fetchImpl: async (input) => {",
            "    const url = String(input);",
            "    if (url.endsWith('/internal/request')) {",
            "      return new Response(JSON.stringify({ sessionId: 'a'.repeat(64), expiresAt: Date.now() + 60000 }), { status: 201 });",
            "    }",
            "    if (url.includes('/internal/abandon/')) {",
            "      return new Response(JSON.stringify({ abandoned: true }), { status: 200 });",
            "    }",
            "    return new Promise(() => {});",
            "  },",
            "});",
            "stdin.write('GETPIN\\n');",
            "setInterval(() => {}, 1000);",
            "await running;",
        ].join("\n"));
        const child = spawn(process.execPath, [script, stderrPath], { stdio: "ignore" });

        try {
            // Wait until the child has actually created the prompt before
            // signalling it; Node startup time varies under a test runner.
            const deadline = Date.now() + 10_000;

            while (Date.now() < deadline) {
                const current = await readFile(stderrPath, "utf8").catch(() => "");

                if (current.includes("Approval required")) {
                    break;
                }

                await new Promise(resolveWait => setTimeout(resolveWait, 50));
            }

            child.kill("SIGTERM");
            await new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
            const text = await readFile(stderrPath, "utf8");
            assert.match(text, /terminated while a prompt was pending/, `GOT: ${JSON.stringify(text)}`);
            assert.match(text, /upstream unchecked write/);
        }
        finally {
            child.kill("SIGKILL");
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    }, 15_000);
});
