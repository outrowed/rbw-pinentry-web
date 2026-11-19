import type { PromptView } from "../../shared/protocol.js";

export type AlertSupport = NotificationPermission | "unsupported";

const STORAGE_KEY = "rbw-web-pinentry:alerts";

/**
 * Alerts stay off until the operator opts in, and the browser only grants
 * permission from a user gesture. Storing the choice keeps a reload from
 * silently dropping it.
 */
export function readAlertPreference(): boolean {
    try {
        return window.localStorage.getItem(STORAGE_KEY) === "on";
    }
    catch {
        // Storage can be unavailable; fall back to off for this session.
        return false;
    }
}

export function writeAlertPreference(enabled: boolean): void {
    try {
        if (enabled) {
            window.localStorage.setItem(STORAGE_KEY, "on");
        }
        else {
            window.localStorage.removeItem(STORAGE_KEY);
        }
    }
    catch {
        // The preference just will not survive a reload.
    }
}

export function currentPermission(): AlertSupport {
    if (typeof window === "undefined" || !("Notification" in window)) {
        return "unsupported";
    }

    return Notification.permission;
}

/**
 * Newly arrived requests, in arrival order. Used to keep a poll of the same
 * list from re-announcing requests that were already shown.
 */
export function selectNewRequests(
    known: ReadonlySet<string>,
    requests: readonly PromptView[],
): PromptView[] {
    return requests.filter(request => !known.has(request.sessionId));
}

export function describeRequest(
    request: PromptView,
    kindLabel: string,
): {
    title: string;
    body: string;
} {
    const subject = request.prompt.trim() || request.title.trim() || "Pinentry request";
    const source = request.source.trim() || "unknown source";
    const client = request.client.trim() || "unknown client";

    return {
        title: `${kindLabel} requested`,
        body: `${subject} - ${client} on ${source} (#${request.sessionId.slice(0, 8)})`,
    };
}

export function showRequestNotification(
    request: PromptView,
    kindLabel: string,
): Notification | null {
    if (currentPermission() !== "granted") {
        return null;
    }

    const { title, body } = describeRequest(request, kindLabel);
    const notification = new Notification(title, {
        body,
        tag: request.sessionId,
    });

    notification.onclick = () => {
        window.focus();
        notification.close();
    };

    return notification;
}

/**
 * Announce each request once, and only when the inbox is not already in front
 * of the operator. A visible, focused tab makes a desktop notification noise
 * rather than a signal.
 */
export function shouldAnnounce(
    permission: AlertSupport,
    enabled: boolean,
    visibility: DocumentVisibilityState,
    focused: boolean,
): boolean {
    if (!enabled || permission !== "granted") {
        return false;
    }

    return visibility !== "visible" || !focused;
}
