import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, createCipheriv, createHmac, pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createDaemon, type RunningDaemon } from "../../src/server/app.js";
import type { PromptView } from "../../src/shared/protocol.js";

const rbw = process.env.RBW_TEST_BINARY ?? "rbw";
const email = "pinentry-test@example.invalid";
const masterPassword = "synthetic master % password";
const otp = "123456";
const daemonIdentity = "test-operator";

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolveRun, reject) => {
        execFile(command, args, { env }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));

                return;
            }

            resolveRun({
                stdout,
                stderr,
            });
        });
    });
}

function cipherstring(value: Buffer, encryptionKey: Buffer, macKey: Buffer): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    const mac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest();

    return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${mac.toString("base64")}`;
}

function fixtureKeys(): {
    protectedKey: string;
    protectedPrivateKey: string;
    vaultKeys: Buffer;
} {
    const raw = pbkdf2Sync(masterPassword, email, 1, 32, "sha256");
    const encKey = createHmac("sha256", raw).update(Buffer.from("enc\x01")).digest();
    const macKey = createHmac("sha256", raw).update(Buffer.from("mac\x01")).digest();
    const vaultKeys = randomBytes(64);

    return {
        protectedKey: cipherstring(vaultKeys, encKey, macKey),
        protectedPrivateKey: cipherstring(Buffer.from("synthetic-private-key"), vaultKeys.subarray(0, 32), vaultKeys.subarray(32)),
        vaultKeys,
    };
}

interface FakeVault {
    server: Server;
    url: string;
    requests: string[];
    publicKey: string;
    keyDirectory: string;
    close: () => Promise<void>;
}

async function startFakeVault(): Promise<FakeVault> {
    const keys = fixtureKeys();
    const keyDir = await mkdtemp(join(tmpdir(), "rbw-pinentry-key-"));
    const keyPath = join(keyDir, "synthetic");
    await run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "pinentry-integration",
        "-f",
        keyPath,
    ]);
    const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
    const privateKey = await readFile(keyPath, "utf8");
    const sshCipher = {
        Id: "synthetic-ssh-key",
        FolderId: null,
        OrganizationId: null,
        Name: "synthetic signing key",
        Login: null,
        Card: null,
        Identity: null,
        SecureNote: null,
        SshKey: {
            PrivateKey: cipherstring(Buffer.from(privateKey), keys.vaultKeys.subarray(0, 32), keys.vaultKeys.subarray(32)),
            PublicKey: cipherstring(Buffer.from(publicKey), keys.vaultKeys.subarray(0, 32), keys.vaultKeys.subarray(32)),
            Fingerprint: null,
        },
        Notes: null,
        PasswordHistory: null,
        Fields: null,
        DeletedDate: null,
        Key: null,
        Reprompt: 0,
    };
    const derivedKey = pbkdf2Sync(masterPassword, email, 1, 32, "sha256");
    const expectedHash = pbkdf2Sync(derivedKey, masterPassword, 1, 32, "sha256").toString("base64");
    const requests: string[] = [];

    const server = createServer(async (req, res) => {
        const path = req.url ?? "";
        requests.push(`${req.method} ${path}`);

        const send = (status: number, body: unknown): void => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        };

        if (path === "/identity/accounts/prelogin") {
            send(200, {
                Kdf: "0",
                KdfIterations: 1,
                KdfMemory: null,
                KdfParallelism: null,
            });

            return;
        }

        if (path === "/identity/connect/token") {
            const chunks: Buffer[] = [];

            for await (const chunk of req) {
                chunks.push(Buffer.from(chunk as Buffer));
            }

            const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));

            if (body.get("password") !== expectedHash) {
                send(400, {
                    error: "invalid_grant",
                    error_description: "invalid_username_or_password",
                    ErrorModel: { Message: "Password is incorrect. Try again." },
                });

                return;
            }

            if (body.get("twoFactorToken") !== otp) {
                send(400, {
                    error: "invalid_grant",
                    error_description: "Two factor required.",
                    TwoFactorProviders: ["0"],
                });

                return;
            }

            send(200, {
                access_token: "synthetic-access-token",
                refresh_token: "synthetic-refresh-token",
                Key: keys.protectedKey,
            });

            return;
        }

        if (path === "/api/sync") {
            send(200, {
                Ciphers: [sshCipher],
                Folders: [],
                Profile: {
                    Key: keys.protectedKey,
                    PrivateKey: keys.protectedPrivateKey,
                    Organizations: [],
                },
            });

            return;
        }

        send(404, { error: "unsupported fixture endpoint" });
    });

    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    return {
        server,
        url: `http://127.0.0.1:${address.port}`,
        requests,
        publicKey,
        keyDirectory: keyDir,
        close: () => new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
    };
}

async function waitForPrompt(daemon: RunningDaemon, kind: PromptView["kind"]): Promise<PromptView> {
    return new Promise<PromptView>((resolvePrompt, reject) => {
        const existing = daemon.store.list().find(request => request.kind === kind);

        if (existing) {
            resolvePrompt(existing);

            return;
        }

        const unsubscribe = daemon.store.subscribe(() => {
            const prompt = daemon.store.list().find(request => request.kind === kind);

            if (prompt) {
                clearTimeout(timer);
                unsubscribe();
                resolvePrompt(prompt);
            }
        });
        const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error(`Timed out waiting for ${kind} prompt`));
        }, 6_000);
    });
}

function spawnRbw(args: string[], env: NodeJS.ProcessEnv): {
    child: ChildProcessWithoutNullStreams;
    completed: Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
    }>;
} {
    const child = spawn(rbw, args, {
        env,
        stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString("utf8"));
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString("utf8"));
    const completed = new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
    }>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolveExit({
            code,
            stdout,
            stderr,
        }));
    });

    return {
        child,
        completed,
    };
}

describe("real rbw binary with isolated synthetic vault", () => {
    let daemon: RunningDaemon | undefined;
    let fakeVault: FakeVault | undefined;
    let directory: string | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let env: NodeJS.ProcessEnv | undefined;

    afterEach(async () => {
        child?.kill("SIGTERM");

        if (env) {
            const stopped = spawnRbw(["stop-agent"], env);
            await Promise.race([stopped.completed, new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
            stopped.child.kill("SIGTERM");
        }

        await daemon?.close();
        await fakeVault?.close();

        if (fakeVault) {
            await rm(fakeVault.keyDirectory, {
                recursive: true,
                force: true,
            });
        }

        if (directory) {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it("logs in with 2FA, then serves and signs with a vault SSH key through the real Assuan pinentry", async () => {
        fakeVault = await startFakeVault();
        directory = await mkdtemp(join(tmpdir(), "rbw-pinentry-integration-"));
        const profile = `pinentry-${randomBytes(8).toString("hex")}`;
        const config = join(directory, ".config", `rbw-${profile}`);
        const runtime = join(directory, ".run");
        await mkdir(config, { recursive: true });
        await mkdir(runtime, { recursive: true });
        const cliPath = resolve("dist-server/src/cli/web-pinentry.js");
        const wrapper = join(directory, "web-pinentry");
        await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`, { mode: 0o700 });
        await writeFile(join(config, "config.json"), JSON.stringify({
            email,
            sso_id: null,
            base_url: fakeVault.url,
            identity_url: null,
            ui_url: null,
            notifications_url: null,
            lock_timeout: 300,
            sync_interval: 3600,
            pinentry: wrapper,
            client_cert_path: null,
        }));

        daemon = createDaemon({
            host: "127.0.0.1",
            port: 0,
            promptTtlMs: 10_000,
            maxPendingSessions: 4,
            allowedUsers: new Set([daemonIdentity]),
            internalAllowedIps: new Set(["127.0.0.1", "::ffff:127.0.0.1"]),
            clientName: "rbw-integration",
            sourceName: "isolated",
            staticDir: resolve("dist-client"),
        });
        await daemon.app.listen({
            host: "127.0.0.1",
            port: 0,
        });
        const daemonUrl = daemon.app.listeningOrigin;
        env = {
            ...process.env,
            HOME: directory,
            XDG_CONFIG_HOME: join(directory, ".config"),
            XDG_CACHE_HOME: join(directory, ".cache"),
            XDG_DATA_HOME: join(directory, ".local", "share"),
            XDG_RUNTIME_DIR: runtime,
            RBW_PROFILE: profile,
            WEB_PINENTRY_DAEMON_URL: daemonUrl,
            WEB_PINENTRY_PUBLIC_URL: daemonUrl,
            WEB_PINENTRY_TIMEOUT_MS: "12000",
            PINENTRY_CLIENT_NAME: "rbw-integration",
            PINENTRY_SOURCE_NAME: "isolated",
        };

        const login = spawnRbw(["login"], env);
        child = login.child;
        const passwordPrompt = await Promise.race([
            waitForPrompt(daemon, "login"),
            login.completed.then((result) => { throw new Error(`rbw exited before login prompt: code=${result.code} stderr=${result.stderr}`); }),
        ]);
        assert.equal(passwordPrompt.prompt, "Master Password");
        assert.equal(passwordPrompt.client, "rbw-integration");
        let answer = await fetch(`${daemonUrl}/api/requests/${passwordPrompt.sessionId}/resolve`, {
            method: "POST",
            headers: {
                "Remote-User": daemonIdentity,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                action: "approve",
                value: "wrong synthetic password",
            }),
        });
        assert.equal(answer.status, 200);

        const retryPrompt = await waitForPrompt(daemon, "login");
        assert.notEqual(retryPrompt.sessionId, passwordPrompt.sessionId);
        assert.match(retryPrompt.error ?? "", /Password is incorrect/);
        answer = await fetch(`${daemonUrl}/api/requests/${retryPrompt.sessionId}/resolve`, {
            method: "POST",
            headers: {
                "Remote-User": daemonIdentity,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                action: "approve",
                value: masterPassword,
            }),
        });
        assert.equal(answer.status, 200);

        const otpPrompt = await waitForPrompt(daemon, "two-factor");
        assert.match(otpPrompt.prompt, /Authenticator/);
        answer = await fetch(`${daemonUrl}/api/requests/${otpPrompt.sessionId}/resolve`, {
            method: "POST",
            headers: {
                "Remote-User": daemonIdentity,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                action: "approve",
                value: otp,
            }),
        });
        assert.equal(answer.status, 200);

        const result = await Promise.race([
            login.completed,
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("rbw login hung")), 7_000)),
        ]);
        assert.equal(result.code, 0, result.stderr);
        assert.ok(fakeVault.requests.includes("GET /api/sync"));
        assert.equal(daemon.store.pendingCount, 0);
        const cached = await readFile(join(directory, ".cache", `rbw-${profile}`, `${encodeURIComponent(fakeVault.url)}:${email}.json`), "utf8");
        assert.ok(cached.includes("synthetic-access-token"));

        const locked = spawnRbw(["lock"], env);
        assert.equal((await locked.completed).code, 0);
        const unlock = spawnRbw(["unlock"], env);
        child = unlock.child;
        const unlockPrompt = await Promise.race([
            waitForPrompt(daemon, "unlock"),
            unlock.completed.then((result) => { throw new Error(`rbw exited before unlock prompt: code=${result.code} stderr=${result.stderr}`); }),
        ]);
        assert.equal(unlockPrompt.prompt, "Master Password");
        answer = await fetch(`${daemonUrl}/api/requests/${unlockPrompt.sessionId}/resolve`, {
            method: "POST",
            headers: {
                "Remote-User": daemonIdentity,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                action: "approve",
                value: masterPassword,
            }),
        });
        assert.equal(answer.status, 200);
        const unlocked = await Promise.race([
            unlock.completed,
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("rbw unlock hung")), 7_000)),
        ]);
        assert.equal(unlocked.code, 0, unlocked.stderr);
        assert.equal(daemon.store.pendingCount, 0);

        const sshSocket = join(runtime, `rbw-${profile}`, "ssh-agent-socket");
        const listed = await run("ssh-add", ["-l"], {
            ...env,
            SSH_AUTH_SOCK: sshSocket,
        });
        assert.match(listed.stdout, /ED25519/);

        const publicKeyPath = join(directory, "synthetic.pub");
        await writeFile(publicKeyPath, `${fakeVault.publicKey}\n`);
        const reLocked = spawnRbw(["lock"], env);
        assert.equal((await reLocked.completed).code, 0);

        const sshTest = spawn("ssh-add", ["-T", publicKeyPath], {
            env: {
                ...env,
                SSH_AUTH_SOCK: sshSocket,
            },
            stdio: "pipe",
        });
        let sshStdout = "";
        let sshStderr = "";
        sshTest.stdout.on("data", (chunk: Buffer) => sshStdout += chunk.toString("utf8"));
        sshTest.stderr.on("data", (chunk: Buffer) => sshStderr += chunk.toString("utf8"));
        const sshCompleted = new Promise<number | null>((resolveExit, reject) => {
            sshTest.once("error", reject);
            sshTest.once("exit", resolveExit);
        });
        child = sshTest;
        const sshUnlockPrompt = await Promise.race([
            waitForPrompt(daemon, "unlock"),
            sshCompleted.then((code) => { throw new Error(`ssh-add exited before unlock prompt: code=${code} stdout=${sshStdout} stderr=${sshStderr}`); }),
        ]);
        assert.match(sshUnlockPrompt.desc, /Unlock the local database/);
        const sshApproval = await fetch(`${daemonUrl}/api/requests/${sshUnlockPrompt.sessionId}/resolve`, {
            method: "POST",
            headers: {
                "Remote-User": daemonIdentity,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                action: "approve",
                value: masterPassword,
            }),
        });
        assert.equal(sshApproval.status, 200);
        const sshResult = await Promise.race([
            sshCompleted,
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("ssh-add sign test hung")), 7_000)),
        ]);
        assert.equal(sshResult, 0, `${sshStdout}\n${sshStderr}`);
    }, 30_000);
});
