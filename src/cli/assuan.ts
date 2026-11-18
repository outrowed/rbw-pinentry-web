import fs from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CreatePromptRequest, CreatePromptResponse, WaitPromptResponse } from "../shared/protocol.js";
import { encodeAssuanData, inferPromptKind } from "../shared/protocol.js";

export interface PinentryClientOptions {
    daemonUrl: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
    clientName?: string;
    sourceName?: string;
    webUrl?: string;
}

/**
 * Writes a protocol line without letting a closed parent pipe crash the
 * process. When rbw exits first, stdout emits EPIPE; responding with ERR
 * instead of throwing keeps the agent's worker alive.
 *
 * Note: the peer (`rbw-agent`) still does an unchecked socket write of its
 * own, so losing this race can panic one of its tokio workers upstream. We
 * cannot patch that binary here, so the warning below tells the operator what
 * they will see and that it is survivable.
 */
function safeWrite(stream: Writable, text: string, label = "stdout"): boolean {
    try {
        stream.write(text);

        return true;
    }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "unknown";
        process.stderr.write(
            `[rbw-web-pinentry] ${label} closed (${code}); abandoning this prompt. `
            + "rbw-agent may log a socket 'Broken pipe' panic - that is an upstream unchecked "
            + "write, not a fatal error, and the agent process keeps running.\n",
        );

        return false;
    }
}

/**
 * Warning path that also works while the process is shutting down: write
 * through the given stream, then flush a real descriptor synchronously.
 */
function warnTo(stderr: Writable, message: string): void {
    try {
        stderr.write(message);

        const fd = (stderr as { fd?: number }).fd;

        if (typeof fd === "number") {
            try {
                fs.fsyncSync(fd);
            }
            catch {
                // Descriptor may already be closed; the write stands.
            }
        }
    }
    catch {
        try {
            fs.writeSync(2, message);
        }
        catch {
            // Nothing else can be reported at this point.
        }
    }
}

interface AssuanSessionState {
    title: string;
    prompt: string;
    desc: string;
    error: string | null;
}

async function requestWebPrompt(
    state: AssuanSessionState,
    options: PinentryClientOptions,
    stderr: Writable,
    signal?: AbortSignal,
    warn: (message: string) => void = message => warnTo(stderr, message),
): Promise<WaitPromptResponse> {
    const fetchFn = options.fetchImpl ?? fetch;
    const baseUrl = options.daemonUrl.replace(/\/+$/, "");
    const payload: CreatePromptRequest = {
        ...state,
        client: options.clientName ?? "rbw-agent / web-pinentry",
        source: options.sourceName ?? process.env.HOSTNAME ?? "local",
        kind: inferPromptKind(state.prompt, state.desc),
        pid: process.ppid,
    };

    const createRes = await fetchFn(`${baseUrl}/internal/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
    });

    if (!createRes.ok) {
        throw new Error(`Daemon request failed with HTTP ${createRes.status}`);
    }

    const created = await createRes.json() as CreatePromptResponse;
    const approvalUrl = options.webUrl ?? process.env.WEB_PINENTRY_PUBLIC_URL ?? "http://localhost:3088";
    stderr.write(`\n[rbw-web-pinentry] Approval required: ${approvalUrl} (request ${created.sessionId.slice(0, 8)})\n`);

    const waitUrl = `${baseUrl}/internal/wait/${encodeURIComponent(created.sessionId)}`;
    const abandonUrl = `${baseUrl}/internal/abandon/${encodeURIComponent(created.sessionId)}`;

    const abandon = async (): Promise<void> => {
        try {
            await fetchFn(abandonUrl, {
                method: "POST",
                signal: AbortSignal.timeout(2_000),
            });
        }
        catch {
            // Best effort only; the daemon TTL is the final fallback.
        }
    };

    // A terminating rbw or a supervisor timeout must not leave the browser
    // prompt waiting for a client that no longer exists. Let the abandon
    // request finish (bounded to 2s) before exiting.
    const onSignal = (): void => {
        void abandon().finally(() => process.exit(130));
    };

    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);

    try {
        const waitRes = await fetchFn(waitUrl, {
            method: "GET",
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
                : AbortSignal.timeout(options.timeoutMs),
        });

        if (waitRes.status === 200) {
            return await waitRes.json() as WaitPromptResponse;
        }

        if (waitRes.status === 409) {
            return { status: "cancelled" };
        }

        if (waitRes.status === 408) {
            return { status: "expired" };
        }

        if (waitRes.status === 410) {
            return { status: "abandoned" };
        }

        throw new Error(`Unexpected wait status HTTP ${waitRes.status}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Pinentry request aborted";
        await abandon();

        throw new Error(`Prompt ${created.sessionId.slice(0, 8)} failed: ${message}`);
    }
    finally {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
    }
}

export async function runAssuanSession(
    stdin: Readable,
    stdout: Writable,
    stderr: Writable,
    options: PinentryClientOptions,
): Promise<void> {
    const state: AssuanSessionState = {
        title: "rbw",
        prompt: "Master Password",
        desc: "Please enter the master password",
        error: null,
    };

    if (!safeWrite(stdout, "OK\n", "stdout")) {
        return;
    }

    const rl = createInterface({
        input: stdin,
        crlfDelay: Infinity,
    });
    let activePromptAbort: AbortController | undefined;

    const warn = (message: string): void => warnTo(stderr, message);

    const onSignal = (): void => {
        if (activePromptAbort) {
            // This runs while the process is going down, so write through the
            // injected stream and flush its descriptor synchronously.
            warn(
                "[rbw-web-pinentry] terminated while a prompt was pending; abandoning it. "
                + "If rbw-agent logs a socket 'Broken pipe' panic, that is an upstream unchecked "
                + "write in the agent and the agent process keeps running.\n",
            );
        }

        activePromptAbort?.abort();
        rl.close();
    };

    const onStdoutError = (error: NodeJS.ErrnoException): void => {
        if (error.code === "EPIPE") {
            warn(
                "[rbw-web-pinentry] stdout closed while the prompt was pending; abandoning it. "
                + "If rbw-agent logs a socket 'Broken pipe' panic, that is an upstream unchecked "
                + "write in the agent and the agent process keeps running.\n",
            );
        }
        else {
            process.exitCode = 1;
        }

        activePromptAbort?.abort();
        rl.close();
    };

    const onStderrError = (error: NodeJS.ErrnoException): void => {
        if (error.code !== "EPIPE") {
            process.exitCode = 1;
        }
    };

    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    stdout.on("error", onStdoutError);
    stderr.on("error", onStderrError);

    try {
        for await (const rawLine of rl) {
            const line = rawLine.trim();

            if (!line || line.startsWith("#")) {
                continue;
            }

            const spaceIndex = line.indexOf(" ");
            const command = (spaceIndex === -1 ? line : line.slice(0, spaceIndex)).toUpperCase();
            const arg = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);

            switch (command) {
                case "SETTITLE": {
                    state.title = arg || "rbw";
                    safeWrite(stdout, "OK\n");
                    break;
                }

                case "SETPROMPT": {
                    state.prompt = arg || "Master Password";
                    safeWrite(stdout, "OK\n");
                    break;
                }

                case "SETDESC": {
                    state.desc = arg || "Please enter the master password";
                    safeWrite(stdout, "OK\n");
                    break;
                }

                case "SETERROR": {
                    state.error = arg || null;
                    safeWrite(stdout, "OK\n");
                    break;
                }

                case "OPTION":
                case "SETKEYINFO":
                case "SETREPEAT":
                case "SETREPEATERROR":
                case "SETOK":
                case "SETCANCEL":
                case "SETNOTOK":
                case "SETQUALITYBAR":
                case "SETQUALITYBAR_TT":
                case "SETGENPIN":
                case "SETGENPIN_TT":

                case "SETTIMEOUT": {
                    safeWrite(stdout, "OK\n");
                    break;
                }

                case "GETINFO": {
                    const subcommand = arg.trim().toLowerCase();
                    safeWrite(stdout, subcommand === "pid"
                        ? `D ${process.pid}\nOK\n`
                        : subcommand === "version"
                            ? "D 0.2.0\nOK\n"
                            : "OK\n");
                    break;
                }

                case "GETPIN": {
                    const requestAbort = new AbortController();
                    activePromptAbort = requestAbort;

                    try {
                        const result = await requestWebPrompt(state, options, stderr, requestAbort.signal, message => warnTo(stderr, message));

                        if (result.status === "approved") {
                            safeWrite(stdout, `D ${encodeAssuanData(result.password)}\nOK\n`);
                        }
                        else {
                            safeWrite(stdout, "ERR 83886179 Operation cancelled <Pinentry>\n");
                        }
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : "Daemon unreachable";
                        stderr.write(`[rbw-web-pinentry] ${message}\n`);
                        safeWrite(stdout, "ERR 83886179 Operation cancelled <Pinentry>\n");
                    }
                    finally {
                        activePromptAbort = undefined;
                    }

                    break;
                }

                case "CONFIRM":

                case "MESSAGE": {
                    safeWrite(stdout, "OK\n");
                    break;
                }

                case "RESET": {
                    state.title = "rbw";
                    state.prompt = "Master Password";
                    state.desc = "Please enter the master password";
                    state.error = null;
                    safeWrite(stdout, "OK\n");
                    break;
                }

                case "BYE": {
                    safeWrite(stdout, "OK\n");
                    rl.close();
                    return;
                }

                default: {
                    safeWrite(stdout, "ERR 83886355 Unknown command <Pinentry>\n");
                }
            }
        }
    }
    finally {
        activePromptAbort?.abort();
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        stdout.off("error", onStdoutError);
        stderr.off("error", onStderrError);
    }
}
