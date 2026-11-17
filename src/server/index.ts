import { createDaemon, loadConfig } from "./app.js";

const config = loadConfig();
const daemon = createDaemon(config);

await daemon.app.listen({
    port: config.port,
    host: config.host,
});
process.stdout.write(`[rbw-web-pinentry] listening on http://${config.host}:${config.port}\n`);

const shutdown = async (): Promise<void> => {
    try {
        await daemon.close();
    }
    finally {
        process.exit(0);
    }
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
