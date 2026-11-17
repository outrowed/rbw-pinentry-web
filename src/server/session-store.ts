import { randomBytes } from "node:crypto";
import type {
    CreatePromptRequest,
    CreatePromptResponse,
    PromptView,
    WaitPromptResponse,
} from "../shared/protocol.js";

interface InternalSession extends CreatePromptRequest {
    sessionId: string;
    createdAt: number;
    expiresAt: number;
    timer: NodeJS.Timeout;
    waiters: Array<{
        resolve: (result: WaitPromptResponse) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
    }>;
    finalResult: WaitPromptResponse | null;
}

export interface SessionStoreOptions {
    ttlMs: number;
    maxPendingSessions: number;
}

export class PromptSessionStore {
    private readonly bySessionId = new Map<string, InternalSession>();
    private readonly listeners = new Set<() => void>();
    private readonly options: SessionStoreOptions;

    public constructor(options: SessionStoreOptions) {
        this.options = options;
    }

    public get pendingCount(): number {
        this.pruneExpired();

        return this.bySessionId.size;
    }

    public subscribe(listener: () => void): () => void {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    public list(): PromptView[] {
        this.pruneExpired();

        const now = Date.now();

        return [...this.bySessionId.values()]
            .filter(session => session.finalResult === null)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(session => ({
                sessionId: session.sessionId,
                title: session.title,
                prompt: session.prompt,
                desc: session.desc,
                error: session.error,
                client: session.client,
                source: session.source,
                kind: session.kind,
                pid: session.pid,
                createdAt: session.createdAt,
                expiresAt: session.expiresAt,
                remainingMs: Math.max(0, session.expiresAt - now),
            }));
    }

    public create(input: CreatePromptRequest): CreatePromptResponse {
        this.pruneExpired();

        if (this.bySessionId.size >= this.options.maxPendingSessions) {
            throw new RangeError("Too many pending prompt sessions");
        }

        const sessionId = randomBytes(32).toString("hex");
        const now = Date.now();
        const expiresAt = now + this.options.ttlMs;
        const timer = setTimeout(() => this.expireSession(sessionId), this.options.ttlMs);
        timer.unref();

        const record: InternalSession = {
            ...input,
            title: input.title.trim() || "rbw",
            prompt: input.prompt.trim() || "Master Password",
            desc: input.desc.trim() || "Unlock Vaultwarden session",
            error: input.error?.trim() || null,
            client: input.client.trim() || "rbw",
            source: input.source.trim() || "local",
            sessionId,
            createdAt: now,
            expiresAt,
            timer,
            waiters: [],
            finalResult: null,
        };

        this.bySessionId.set(sessionId, record);
        this.emitChange();

        return {
            sessionId,
            expiresAt,
        };
    }

    public waitForResult(sessionId: string, signal?: AbortSignal): Promise<WaitPromptResponse | null> {
        if (!/^[a-f0-9]{64}$/i.test(sessionId)) {
            return Promise.resolve(null);
        }

        const session = this.bySessionId.get(sessionId);

        if (!session) {
            return Promise.resolve(null);
        }

        if (session.finalResult !== null) {
            const result = session.finalResult;
            this.bySessionId.delete(sessionId);

            return Promise.resolve(result);
        }

        if (Date.now() >= session.expiresAt) {
            this.expireSession(sessionId);

            return Promise.resolve({ status: "expired" });
        }

        return new Promise<WaitPromptResponse>((resolve) => {
            if (signal?.aborted) {
                this.abandonBySessionId(sessionId);
                resolve({ status: "abandoned" });

                return;
            }

            const waiter: InternalSession["waiters"][number] = {
                resolve,
                signal,
            };
            waiter.onAbort = () => this.abandonWaiter(session, waiter);
            signal?.addEventListener("abort", waiter.onAbort, { once: true });
            session.waiters.push(waiter);
        });
    }

    public approveBySessionId(sessionId: string, password: string): boolean {
        const session = this.getActiveInternalBySessionId(sessionId);

        if (!session || password.length === 0) {
            return false;
        }

        this.settleSession(session, {
            status: "approved",
            password,
        });

        return true;
    }

    public cancelBySessionId(sessionId: string): boolean {
        const session = this.getActiveInternalBySessionId(sessionId);

        if (!session) {
            return false;
        }

        this.settleSession(session, { status: "cancelled" });

        return true;
    }

    public abandonBySessionId(sessionId: string): boolean {
        const session = this.bySessionId.get(sessionId);

        if (!session || session.finalResult !== null) {
            return false;
        }

        this.settleSession(session, { status: "abandoned" });

        return true;
    }

    public clearAll(): void {
        for (const session of this.bySessionId.values()) {
            clearTimeout(session.timer);

            for (const waiter of session.waiters) {
                this.removeWaiterListener(waiter);
                waiter.resolve({ status: "cancelled" });
            }
        }

        this.bySessionId.clear();
        this.emitChange();
    }

    private getActiveInternalBySessionId(sessionId: string): InternalSession | null {
        if (!/^[a-f0-9]{64}$/i.test(sessionId)) {
            return null;
        }

        const session = this.bySessionId.get(sessionId);

        if (!session || Date.now() >= session.expiresAt || session.finalResult !== null) {
            if (session && session.finalResult === null) {
                this.expireSession(sessionId);
            }

            return null;
        }

        return session;
    }

    private expireSession(sessionId: string): void {
        const session = this.bySessionId.get(sessionId);

        if (session && session.finalResult === null) {
            this.settleSession(session, { status: "expired" });
        }
    }

    private settleSession(session: InternalSession, result: WaitPromptResponse): void {
        clearTimeout(session.timer);

        if (session.waiters.length > 0) {
            this.bySessionId.delete(session.sessionId);

            for (const waiter of session.waiters.splice(0)) {
                this.removeWaiterListener(waiter);
                waiter.resolve(result);
            }
        }
        else {
            session.finalResult = result;

            const cleanupTimer = setTimeout(() => {
                this.bySessionId.delete(session.sessionId);
            }, 5_000);
            cleanupTimer.unref();
        }

        this.emitChange();
    }

    private abandonWaiter(
        session: InternalSession,
        waiter: InternalSession["waiters"][number],
    ): void {
        const index = session.waiters.indexOf(waiter);

        if (index === -1) {
            return;
        }

        session.waiters.splice(index, 1);
        this.removeWaiterListener(waiter);
        waiter.resolve({ status: "abandoned" });

        if (session.waiters.length === 0 && session.finalResult === null) {
            this.settleSession(session, { status: "abandoned" });
        }
    }

    private removeWaiterListener(waiter: InternalSession["waiters"][number]): void {
        if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
    }

    private pruneExpired(): void {
        const now = Date.now();

        for (const [sessionId, session] of this.bySessionId.entries()) {
            if (now >= session.expiresAt && session.finalResult === null) {
                this.expireSession(sessionId);
            }
        }
    }

    private emitChange(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
