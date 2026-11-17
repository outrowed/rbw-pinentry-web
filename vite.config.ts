import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    build: {
        outDir: "dist-client",
        emptyOutDir: true,
    },
    server: {
        host: "0.0.0.0",
        port: 3088,
        proxy: {
            "/api": "http://127.0.0.1:3089",
            "/internal": "http://127.0.0.1:3089",
        },
    },
});
