import { useCallback, useEffect, useMemo, useState } from "react";
import type { PromptKind, PromptView } from "../../shared/protocol.js";

type RequestRecord = PromptView;
type Status = "connecting" | "live" | "offline";
type ResolveAction = "approve" | "cancel";
type KindFilter = "all" | PromptKind;

const KIND_LABELS: Record<PromptKind, string> = {
    "unlock": "Vault unlock",
    "login": "Vault login",
    "two-factor": "Two-factor",
    "api-key": "API credential",
    "confirmation": "Confirmation",
    "other": "Pinentry request",
};

const FILTERS: Array<{
    id: KindFilter;
    label: string;
}> = [
    {
        id: "all",
        label: "All",
    },
    {
        id: "unlock",
        label: "Password",
    },
    {
        id: "two-factor",
        label: "2FA",
    },
    {
        id: "login",
        label: "Login",
    },
];

function formatRemaining(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function useRequests(): {
    requests: RequestRecord[];
    status: Status;
    error: string | null;
} {
    const [requests, setRequests] = useState<RequestRecord[]>([]);
    const [status, setStatus] = useState<Status>("connecting");
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        const response = await fetch("/api/requests", { cache: "no-store" });

        if (!response.ok) {
            throw new Error(response.status === 403 ? "Your authenticated session is not authorized." : `Request list failed (${response.status}).`);
        }

        const payload = await response.json() as { requests: RequestRecord[] };
        setRequests(payload.requests);
        setError(null);
    }, []);

    useEffect(() => {
        let alive = true;
        let source: EventSource | null = null;

        void refresh()
            .then(() => {
                if (alive) {
                    source = new EventSource("/api/events");
                    source.addEventListener("requests", (event) => {
                        const message = event as MessageEvent<string>;
                        setRequests(JSON.parse(message.data) as RequestRecord[]);
                        setStatus("live");
                        setError(null);
                    });
                    source.onopen = () => setStatus("live");
                    source.onerror = () => setStatus("connecting");
                }
            })
            .catch((reason: unknown) => {
                if (alive) {
                    setStatus("offline");
                    setError(reason instanceof Error ? reason.message : "Unable to load requests.");
                }
            });

        const timer = window.setInterval(() => {
            setRequests(current => current.map(request => ({
                ...request,
                remainingMs: Math.max(0, request.expiresAt - Date.now()),
            })));
        }, 1000);

        return () => {
            alive = false;
            source?.close();
            window.clearInterval(timer);
        };
    }, [refresh]);

    return {
        requests,
        status,
        error,
    };
}

function RequestCard({ request, onResolve }: {
    request: RequestRecord;
    onResolve: (request: RequestRecord, action: ResolveAction, value?: string) => Promise<void>;
}): React.JSX.Element {
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isCode = request.kind === "two-factor";
    const lifetime = Math.max(1, request.expiresAt - request.createdAt);
    const progress = Math.max(0, Math.min(100, (request.remainingMs / lifetime) * 100));
    const urgent = request.remainingMs < 30_000;

    const submit = async (action: ResolveAction): Promise<void> => {
        setBusy(true);
        setError(null);

        try {
            await onResolve(request, action, value);
            setValue("");
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : "Unable to resolve this request.");
        }
        finally {
            setBusy(false);
        }
    };

    return (
        <article className={`request-card request-${request.kind}`} aria-labelledby={`title-${request.sessionId}`}>
            <div className="request-topline">
                <span className="request-kind">{KIND_LABELS[request.kind]}</span>
                <span className="request-id">
                    #
                    {request.sessionId.slice(0, 8)}
                </span>
                <span className={`countdown ${urgent ? "countdown-urgent" : ""}`} title={`Expires in ${formatRemaining(request.remainingMs)}`}>
                    {formatRemaining(request.remainingMs)}
                </span>
            </div>
            <h3 id={`title-${request.sessionId}`}>{request.title || request.prompt}</h3>
            <div className="ttl-track" aria-hidden="true">
                <span className={`ttl-fill ${urgent ? "ttl-fill-urgent" : ""}`} style={{ width: `${String(progress)}%` }} />
            </div>
            <p className="request-description">{request.desc}</p>
            {request.error && <p className="request-error" role="alert">{request.error}</p>}
            <dl className="request-meta">
                <div>
                    <dt>Client</dt>
                    <dd>{request.client}</dd>
                </div>
                <div>
                    <dt>Source</dt>
                    <dd>{request.source}</dd>
                </div>
                <div>
                    <dt>PID</dt>
                    <dd>{request.pid || "n/a"}</dd>
                </div>
                <div>
                    <dt>Started</dt>
                    <dd>{new Date(request.createdAt).toLocaleTimeString()}</dd>
                </div>
            </dl>
            <form
                className="resolve-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    void submit("approve");
                }}
            >
                <label htmlFor={`value-${request.sessionId}`}>{request.prompt}</label>
                <div className="resolve-controls">
                    <input
                        id={`value-${request.sessionId}`}
                        type={isCode ? "text" : "password"}
                        inputMode={isCode ? "numeric" : undefined}
                        autoComplete={isCode ? "one-time-code" : "current-password"}
                        value={value}
                        onChange={event => setValue(event.target.value)}
                        autoCapitalize="none"
                        spellCheck={false}
                        disabled={busy}
                        required
                    />
                    <button type="submit" className="classic-button approve-button" disabled={busy || !value || request.remainingMs <= 0}>
                        {busy ? "Approving…" : "Approve"}
                    </button>
                    <button type="button" className="classic-button cancel-button" disabled={busy} onClick={() => void submit("cancel")}>
                        Cancel
                    </button>
                </div>
            </form>
            {error && <p className="request-error" role="alert">{error}</p>}
        </article>
    );
}

function BrandMark(): React.JSX.Element {
    return (
        <div className="brand">
            <svg className="brand-symbol" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
                <rect className="brand-frame" x="2" y="2" width="44" height="44" />
                <circle className="brand-keyhole" cx="24" cy="18.5" r="6.5" />
                <path className="brand-keyhole" d="M20.5 23h7l3 15h-13z" />
                <path className="brand-tick" d="M7 7h7v2H9v5H7z" />
                <path className="brand-tick" d="M41 41h-7v-2h5v-5h2z" />
            </svg>
            <div className="brand-copy">
                <h1 id="brand-title">pinentry</h1>
                <p>for rbw</p>
            </div>
        </div>
    );
}

export function App(): React.JSX.Element {
    const { requests, status, error } = useRequests();
    const [notice, setNotice] = useState<string | null>(null);
    const [showIntro, setShowIntro] = useState(true);
    const [filter, setFilter] = useState<KindFilter>("all");

    const visibleRequests = useMemo(() => (
        filter === "all" ? requests : requests.filter(request => request.kind === filter)
    ), [requests, filter]);

    const resolve = useCallback(async (request: RequestRecord, action: ResolveAction, value?: string): Promise<void> => {
        const response = await fetch(`/api/requests/${encodeURIComponent(request.sessionId)}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                action,
                value,
            }),
        });

        if (!response.ok) {
            throw new Error(response.status === 410 ? "This request has expired or was already handled." : `Request failed (${response.status}).`);
        }

        setNotice(action === "approve"
            ? `Approval sent for request ${request.sessionId.slice(0, 8)}. Waiting for the client to finish.`
            : `Request ${request.sessionId.slice(0, 8)} cancelled.`);
    }, []);

    const statusLabel = status === "live" ? "Connected" : status === "offline" ? "Offline" : "Connecting";

    return (
        <main className="page-shell">
            <div className="page-content">
                <header className="page-brand">
                    <BrandMark />
                    <p className="brand-caption">Approve rbw logins and vault unlocks</p>
                </header>
                {showIntro && (
                    <section className="classic-panel intro-panel" aria-labelledby="intro-heading">
                        <header className="panel-heading intro-heading">
                            <h2 id="intro-heading">About this page</h2>
                            <button type="button" className="close-button" aria-label="Hide introduction" onClick={() => setShowIntro(false)}>×</button>
                        </header>
                        <div className="intro-content">
                            <p>
                                {"This page answers pending "}
                                <strong>rbw</strong>
                                {" pinentry prompts. Prompts arrive from your clients and can be answered once."}
                            </p>
                            <p className="safety-note">Only approve prompts you started. Check the client and source before entering a password or verification code.</p>
                        </div>
                    </section>
                )}
                {!showIntro && (
                    <button type="button" className="reopen-intro" onClick={() => setShowIntro(true)}>Show about this page</button>
                )}
                <section className="classic-panel request-panel" aria-labelledby="requests-heading">
                    <header className="panel-heading request-heading">
                        <h2 id="requests-heading">
                            Pending requests
                            <span className="count-badge">{requests.length}</span>
                        </h2>
                        <div className="panel-status" role="status">
                            <span className={`status-dot status-${status}`} aria-hidden="true" />
                            {statusLabel}
                        </div>
                    </header>
                    <nav className="filter-bar" aria-label="Filter requests by type">
                        {FILTERS.map(item => (
                            <button
                                key={item.id}
                                type="button"
                                className={`filter-tab ${filter === item.id ? "filter-active" : ""}`}
                                aria-pressed={filter === item.id}
                                onClick={() => setFilter(item.id)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </nav>
                    {error && (
                        <p className="page-error" role="alert">
                            {error}
                            {" "}
                            Check your Authelia session, then reload.
                        </p>
                    )}
                    {notice && <p className="page-notice" role="status">{notice}</p>}
                    <div className="request-list" aria-live="polite">
                        {visibleRequests.length === 0
                            ? (
                                    <div className="empty-state">
                                        <strong>No pending requests</strong>
                                        <span>
                                            {requests.length === 0
                                                ? "Waiting for an rbw pinentry prompt."
                                                : "No requests match this filter."}
                                        </span>
                                    </div>
                                )
                            : visibleRequests.map(request => <RequestCard key={request.sessionId} request={request} onResolve={resolve} />)}
                    </div>
                </section>
            </div>
        </main>
    );
}
