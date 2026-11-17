import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { inferPromptKind, type PromptKind } from "../src/shared/protocol.js";

describe("inferPromptKind", () => {
    const cases: Array<{
        prompt: string;
        desc: string;
        kind: PromptKind;
    }> = [
        {
            prompt: "Master Password",
            desc: "Unlock the local database for 'rbw'",
            kind: "unlock",
        },
        {
            prompt: "Master Password",
            desc: "Log in to vaultwarden.example.test",
            kind: "login",
        },
        {
            prompt: "Master Password",
            desc: "Register this device",
            kind: "login",
        },
        {
            prompt: "Authenticator App",
            desc: "Enter the 6 digit verification code from your authenticator app.",
            kind: "two-factor",
        },
        {
            prompt: "Email Code",
            desc: "Enter the PIN you received via email.",
            kind: "two-factor",
        },
        {
            prompt: "Yubikey",
            desc: "Insert your Yubikey and push the button.",
            kind: "two-factor",
        },
        {
            prompt: "TOTP",
            desc: "Two-step login",
            kind: "two-factor",
        },
        {
            prompt: "API key client__id",
            desc: "Log in to vaultwarden.example.test",
            kind: "api-key",
        },
        {
            prompt: "API key client__secret",
            desc: "Log in to vaultwarden.example.test",
            kind: "api-key",
        },
        {
            prompt: "Confirm",
            desc: "Continue?",
            kind: "confirmation",
        },
        {
            prompt: "PIN",
            desc: "Unrecognized prompt",
            kind: "other",
        },
    ];

    for (const { prompt, desc, kind } of cases) {
        it(`classifies ${prompt} / ${desc} as ${kind}`, () => {
            assert.equal(inferPromptKind(prompt, desc), kind);
        });
    }
});
