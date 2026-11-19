#!/usr/bin/env node
import { runAssuanSession } from "./assuan.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("web-pinentry 0.2.0\n");
    process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: web-pinentry [--timeout N] [--display DISPLAY] [--ttyname TTY] [--no-global-grab]\n");
    process.exit(0);
}

const timeoutMsRaw = Number.parseInt(process.env.WEB_PINENTRY_TIMEOUT_MS ?? "905000", 10);
const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 905_000;

void runAssuanSession(process.stdin, process.stdout, process.stderr, {
    daemonUrl: process.env.WEB_PINENTRY_DAEMON_URL ?? "http://127.0.0.1:3088",
    timeoutMs,
    clientName: process.env.PINENTRY_CLIENT_NAME,
    sourceName: process.env.PINENTRY_SOURCE_NAME,
    webUrl: process.env.WEB_PINENTRY_PUBLIC_URL,
}).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[rbw-web-pinentry] fatal: ${message}\n`);
    process.exitCode = 1;
});
