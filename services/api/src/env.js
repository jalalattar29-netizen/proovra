import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const loadedEnvSources = [];
function loadEnvFile(path) {
    if (!existsSync(path))
        return;
    const content = readFileSync(path, "utf8");
    let contributed = false;
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const idx = line.indexOf("=");
        if (idx <= 0)
            continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (!key)
            continue;
        if (process.env[key] === undefined) {
            process.env[key] = value;
            contributed = true;
        }
    }
    if (contributed)
        loadedEnvSources.push(path);
}
const cwdEnv = resolve(process.cwd(), ".env");
const serviceEnv = resolve(process.cwd(), "services/api/.env");
const repoRootEnv = resolve(process.cwd(), "../../.env");
loadEnvFile(cwdEnv);
if (serviceEnv !== cwdEnv) {
    loadEnvFile(serviceEnv);
}
if (repoRootEnv !== cwdEnv && repoRootEnv !== serviceEnv) {
    loadEnvFile(repoRootEnv);
}
export function getEnvSourceHint() {
    if (loadedEnvSources.length === 0)
        return "none";
    return loadedEnvSources
        .map((p) => {
        const parts = p.replace(/\\/g, "/").split("/");
        return parts.slice(-2).join("/");
    })
        .join(",");
}
