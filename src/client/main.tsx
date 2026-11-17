import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.js";
import "./ui/theme.css";
import "./ui/classic.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
    throw new Error("Missing React root element");
}

createRoot(rootElement).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
