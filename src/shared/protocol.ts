export type PromptKind = "unlock" | "login" | "two-factor" | "api-key" | "confirmation" | "other";

export interface CreatePromptRequest {
    title: string;
    prompt: string;
    desc: string;
    error: string | null;
    client: string;
    source: string;
    kind: PromptKind;
    pid: number;
}

export interface CreatePromptResponse {
    sessionId: string;
    expiresAt: number;
}

export interface PromptView extends Omit<CreatePromptRequest, "pid"> {
    sessionId: string;
    createdAt: number;
    expiresAt: number;
    remainingMs: number;
    pid: number;
}

export type WaitPromptResponse
    = | {
        status: "approved";
        password: string;
    }
    | {
        status: "cancelled";
    }
    | {
        status: "expired";
    }
    | {
        status: "abandoned";
    };

export function encodeAssuanData(value: string): string {
    return value
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
}

export function inferPromptKind(prompt: string, desc: string): PromptKind {
    const context = `${prompt} ${desc}`.toLowerCase();

    if (/two.?factor|two.?step|authenticator|verification code|one.?time code|totp|yubikey|email code|pin you received via email/.test(context)) {
        return "two-factor";
    }

    if (/client[_ ]?id|client[_ ]?secret|api key/.test(prompt.toLowerCase())) {
        return "api-key";
    }

    if (/confirm|confirmation/.test(prompt.toLowerCase())) {
        return "confirmation";
    }

    if (/log in|login|register/.test(desc.toLowerCase())) {
        return "login";
    }

    if (/password|unlock/.test(`${prompt} ${desc}`.toLowerCase())) {
        return "unlock";
    }

    return "other";
}
