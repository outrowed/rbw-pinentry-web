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

    try {
        const waitRes = await fetchFn(waitUrl, {
            method: "GET",
            signal: AbortSignal.timeout(options.timeoutMs),
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

        try {
            await fetchFn(`${baseUrl}/internal/abandon/${encodeURIComponent(created.sessionId)}`, {
                method: "POST",
                signal: AbortSignal.timeout(2_000),
            });
        }
        catch {
            // Best-effort cleanup; the daemon's TTL is the fallback.
        }

        throw new Error(`Prompt ${created.sessionId.slice(0, 8)} failed: ${message}`);
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

    stdout.write("OK\n");

    const rl = createInterface({
        input: stdin,
        crlfDelay: Infinity,
    });

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
                stdout.write("OK\n");
                break;
            }

            case "SETPROMPT": {
                state.prompt = arg || "Master Password";
                stdout.write("OK\n");
                break;
            }

            case "SETDESC": {
                state.desc = arg || "Please enter the master password";
                stdout.write("OK\n");
                break;
            }

            case "SETERROR": {
                state.error = arg || null;
                stdout.write("OK\n");
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
                stdout.write("OK\n");
                break;
            }

            case "GETINFO": {
                const subcommand = arg.trim().toLowerCase();
                stdout.write(subcommand === "pid"
                    ? `D ${process.pid}\nOK\n`
                    : subcommand === "version"
                        ? "D 0.2.0\nOK\n"
                        : "OK\n");
                break;
            }

            case "GETPIN": {
                try {
                    const result = await requestWebPrompt(state, options, stderr);

                    if (result.status === "approved") {
                        stdout.write(`D ${encodeAssuanData(result.password)}\nOK\n`);
                    }
                    else {
                        stdout.write("ERR 83886179 Operation cancelled <Pinentry>\n");
                    }
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : "Daemon unreachable";
                    stderr.write(`[rbw-web-pinentry] ${message}\n`);
                    stdout.write("ERR 83886179 Operation cancelled <Pinentry>\n");
                }

                break;
            }

            case "CONFIRM":

            case "MESSAGE": {
                stdout.write("OK\n");
                break;
            }

            case "RESET": {
                state.title = "rbw";
                state.prompt = "Master Password";
                state.desc = "Please enter the master password";
                state.error = null;
                stdout.write("OK\n");
                break;
            }

            case "BYE": {
                stdout.write("OK\n");
                rl.close();
                return;
            }

            default: {
                stdout.write("ERR 83886355 Unknown command <Pinentry>\n");
            }
        }
    }
}
