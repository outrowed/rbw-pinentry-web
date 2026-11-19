import type { IncomingMessage } from "node:http";
import { hostname } from "node:os";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import type { CreatePromptRequest, PromptKind, WaitPromptResponse } from "../shared/protocol.js";
import { inferPromptKind } from "../shared/protocol.js";
import { PromptSessionStore } from "./session-store.js";

export interface DaemonConfig {
    host: string;
    port: number;
    promptTtlMs: number;
    maxPendingSessions: number;
    allowedUsers: ReadonlySet<string>;
    internalAllowedIps: ReadonlySet<string>;
    clientName: string;
    sourceName: string;
    staticDir: string;
}

export interface RunningDaemon {
    app: FastifyInstance;
    store: PromptSessionStore;
    close: () => Promise<void>;
}

interface IncomingPrompt {
    title?: unknown;
    prompt?: unknown;
    desc?: unknown;
    error?: unknown;
    client?: unknown;
    source?: unknown;
    kind?: unknown;
    pid?: unknown;
}

interface ResolveBody {
    action?: unknown;
    value?: unknown;
}

const SECURITY_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "Expires": "0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function isInternalRequestAuthorized(
    req: IncomingMessage,
    allowedIps: ReadonlySet<string>,
): boolean {
    if (
        req.headers["x-forwarded-for"] !== undefined
        || req.headers.forwarded !== undefined
        || req.headers["remote-user"] !== undefined
    ) {
        return false;
    }

    return allowedIps.has(req.socket.remoteAddress ?? "");
}

function getAuthenticatedUser(req: FastifyRequest, allowedUsers: ReadonlySet<string>): string | null {
    const header = req.headers["remote-user"];
    const forwardedUsername = Array.isArray(header) ? header[0] : header;
    const developmentUsername = process.env.NODE_ENV === "development"
        ? process.env.DEV_REMOTE_USER
        : undefined;
    const username = forwardedUsername ?? developmentUsername;

    if (!username) {
        return null;
    }

    const trimmed = username.trim();

    return allowedUsers.has(trimmed) ? trimmed : null;
}

function requiredUser(req: FastifyRequest, users: ReadonlySet<string>): string | null {
    return getAuthenticatedUser(req, users);
}

function invalidUser(reply: FastifyReply): FastifyReply {
    return reply.code(403).send({ error: "Authenticated user required" });
}

function parsePromptPayload(input: IncomingPrompt, defaults: Pick<DaemonConfig, "clientName" | "sourceName">): CreatePromptRequest {
    const prompt = typeof input.prompt === "string" ? input.prompt : "Master Password";
    const desc = typeof input.desc === "string" ? input.desc : "Please enter the master password";
    const kind = typeof input.kind === "string" && ["unlock", "login", "two-factor", "api-key", "confirmation", "other"].includes(input.kind)
        ? input.kind as PromptKind
        : inferPromptKind(prompt, desc);

    return {
        title: typeof input.title === "string" ? input.title : "rbw",
        prompt,
        desc,
        error: typeof input.error === "string" ? input.error : null,
        client: typeof input.client === "string" ? input.client : defaults.clientName,
        source: typeof input.source === "string" ? input.source : defaults.sourceName,
        kind,
        pid: typeof input.pid === "number" && Number.isInteger(input.pid) ? input.pid : 0,
    };
}

export function createDaemon(config: DaemonConfig): RunningDaemon {
    const app = Fastify({
        logger: false,
        bodyLimit: 8192,
    });
    const store = new PromptSessionStore({
        ttlMs: config.promptTtlMs,
        maxPendingSessions: config.maxPendingSessions,
    });

    app.addHook("onSend", async (_request, reply, payload) => {
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
            reply.header(name, value);
        }

        return payload;
    });

    app.register(fastifyStatic, {
        root: resolve(config.staticDir),
        prefix: "/",
        decorateReply: true,
        wildcard: false,
    });

    app.get("/api/health", async () => ({
        status: "ok",
        pendingSessions: store.pendingCount,
    }));

    app.post<{ Body: IncomingPrompt }>("/internal/request", async (request, reply) => {
        if (!isInternalRequestAuthorized(request.raw, config.internalAllowedIps)) {
            return reply.code(403).send({ error: "Forbidden internal endpoint" });
        }

        try {
            const created = store.create(parsePromptPayload(request.body ?? {}, config));

            return reply.code(201).send(created);
        }
        catch (error) {
            if (error instanceof RangeError) {
                return reply.code(429).send({ error: error.message });
            }

            return reply.code(400).send({ error: "Invalid request payload" });
        }
    });

    app.get<{ Params: { sessionId: string } }>("/internal/wait/:sessionId", async (request, reply) => {
        if (!isInternalRequestAuthorized(request.raw, config.internalAllowedIps)) {
            return reply.code(403).send({ error: "Forbidden internal endpoint" });
        }

        const controller = new AbortController();

        const onSocketClose = (): void => controller.abort();

        request.raw.socket.once("close", onSocketClose);

        let result: WaitPromptResponse | null = null;

        try {
            result = await store.waitForResult(request.params.sessionId, controller.signal);
        }
        finally {
            request.raw.socket.removeListener("close", onSocketClose);
        }

        if (!result) {
            return reply.code(404).send({ error: "Unknown or consumed session" });
        }

        if (result.status === "approved") {
            return reply.code(200).send(result);
        }

        if (result.status === "cancelled") {
            return reply.code(409).send(result);
        }

        if (result.status === "expired") {
            return reply.code(408).send(result);
        }

        return reply.code(410).send(result);
    });

    app.post<{ Params: { sessionId: string } }>("/internal/abandon/:sessionId", async (request, reply) => {
        if (!isInternalRequestAuthorized(request.raw, config.internalAllowedIps)) {
            return reply.code(403).send({ error: "Forbidden internal endpoint" });
        }

        return reply.send({ abandoned: store.abandonBySessionId(request.params.sessionId) });
    });

    app.get("/api/requests", async (request, reply) => {
        if (!requiredUser(request, config.allowedUsers)) {
            return invalidUser(reply);
        }

        return reply.send({ requests: store.list() });
    });

    app.get("/api/events", (request, reply) => {
        if (!requiredUser(request, config.allowedUsers)) {
            return reply.code(403).send({ error: "Authenticated user required" });
        }

        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });
        raw.write(`event: requests\ndata: ${JSON.stringify(store.list())}\n\n`);

        const unsubscribe = store.subscribe(() => {
            raw.write(`event: requests\ndata: ${JSON.stringify(store.list())}\n\n`);
        });
        const heartbeat = setInterval(() => raw.write(": keepalive\n\n"), 20_000);

        let cleaned = false;

        const cleanup = (): void => {
            if (cleaned) {
                return;
            }

            cleaned = true;
            clearInterval(heartbeat);
            unsubscribe();
        };

        request.raw.on("close", cleanup);
        raw.on("close", cleanup);
    });

    app.post<{
        Params: { sessionId: string };
        Body: ResolveBody;
    }>("/api/requests/:sessionId/resolve", async (request, reply) => {
        if (!requiredUser(request, config.allowedUsers)) {
            return invalidUser(reply);
        }

        const body = request.body ?? {};
        const action = body.action;

        if (action === "cancel") {
            const cancelled = store.cancelBySessionId(request.params.sessionId);

            return reply.code(cancelled ? 200 : 410).send({ status: cancelled ? "cancelled" : "expired" });
        }

        if (action !== "approve" || typeof body.value !== "string" || body.value.length === 0) {
            return reply.code(400).send({ error: "A non-empty value and supported action are required" });
        }

        const approved = store.approveBySessionId(request.params.sessionId, body.value);

        return reply.code(approved ? 200 : 410).send({ status: approved ? "approved" : "expired" });
    });

    const close = async (): Promise<void> => {
        store.clearAll();
        await app.close();
    };

    return {
        app,
        store,
        close,
    };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
    const parseNumber = (value: string | undefined, fallback: number, minimum = 1): number => {
        const parsed = Number.parseInt(value ?? "", 10);

        return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
    };

    const csvSet = (value: string | undefined, fallback: string[]): ReadonlySet<string> => new Set(
        (value ? value.split(",") : fallback).map(item => item.trim()).filter(Boolean),
    );

    return {
        host: env.HOST ?? "0.0.0.0",
        port: parseNumber(env.PORT, 3088),
        promptTtlMs: parseNumber(env.PROMPT_TTL_MS, 900_000, 1000),
        maxPendingSessions: parseNumber(env.MAX_PENDING_SESSIONS, 16),
        allowedUsers: csvSet(env.ALLOWED_USERS, ["operator"]),
        internalAllowedIps: csvSet(env.INTERNAL_ALLOWED_IPS, ["127.0.0.1", "::1", "::ffff:127.0.0.1"]),
        clientName: env.PINENTRY_CLIENT_NAME ?? "rbw-agent / web-pinentry",
        sourceName: env.PINENTRY_SOURCE_NAME ?? hostname(),
        staticDir: env.STATIC_DIR ?? resolve(process.cwd(), "dist-client"),
    };
}
