const isProd = process.env.NODE_ENV === "production";
function prefix(level) {
    return `[api:${level}]`;
}
export function log(...args) {
    if (!isProd) {
        console.log(prefix("info"), ...args);
    }
}
export function warn(...args) {
    if (!isProd) {
        console.warn(prefix("warn"), ...args);
    }
}
export function error(...args) {
    console.error(prefix("error"), ...args);
}
