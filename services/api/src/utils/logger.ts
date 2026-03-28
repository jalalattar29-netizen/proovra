const isProd = process.env.NODE_ENV === "production";

function prefix(level: string) {
  return `[api:${level}]`;
}

export function log(...args: unknown[]) {
  if (!isProd) {
    console.log(prefix("info"), ...args);
  }
}

export function warn(...args: unknown[]) {
  if (!isProd) {
    console.warn(prefix("warn"), ...args);
  }
}

export function error(...args: unknown[]) {
  console.error(prefix("error"), ...args);
}