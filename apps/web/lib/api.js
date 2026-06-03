/* eslint-env browser */
// Committed compiled output of api.ts. The .ts source is canonical; this .js
// artifact must remain in sync. ESLint scans both; the browser env directive
// prevents no-undef on fetch/localStorage/Headers etc.
const DEFAULT_API_BASE = "https://api.proovra.com";
const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? DEFAULT_API_BASE;
const API_BASE = RAW_API_BASE.replace(/\/+$/, "");
export class ApiError extends Error {
    code;
    statusCode;
    requestId;
    details;
    constructor(response, statusCode) {
        super(response.error.message);
        this.code = response.error.code;
        this.statusCode = statusCode;
        this.requestId = response.error.requestId;
        this.details = response.error.details;
        this.name = "ApiError";
    }
}
function asObject(value) {
    return value && typeof value === "object"
        ? value
        : null;
}
function readToken() {
    if (typeof window === "undefined")
        return null;
    try {
        return localStorage.getItem("proovra-token");
    }
    catch {
        return null;
    }
}
async function fetchWithAuthRetry(url, init, opts) {
    const makeHeaders = () => {
        const headers = new Headers(init.headers);
        if (!headers.has("content-type") && init.body) {
            headers.set("content-type", "application/json");
        }
        if (typeof window !== "undefined") {
            headers.set("x-web-client", "1");
        }
        const token = readToken();
        if (opts.auth && token) {
            headers.set("authorization", `Bearer ${token}`);
        }
        else {
            headers.delete("authorization");
        }
        return headers;
    };
    const first = await fetch(url, {
        ...init,
        headers: makeHeaders(),
        credentials: "include",
        cache: "no-store",
    });
    if (first.status !== 401 || !opts.retryAuthOnce) {
        return first;
    }
    const second = await fetch(url, {
        ...init,
        headers: makeHeaders(),
        credentials: "include",
        cache: "no-store",
    });
    return second;
}
export async function apiFetch(path, init = {}, opts) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${API_BASE}${normalizedPath}`;
    const finalOpts = {
        auth: opts?.auth !== false,
        retryAuthOnce: opts?.retryAuthOnce !== false,
    };
    let res;
    try {
        res = await fetchWithAuthRetry(url, init, finalOpts);
    }
    catch (err) {
        const e = new Error(err instanceof Error ? err.message : "Network error while calling API");
        e.code = "NETWORK_ERROR";
        e.statusCode = 0;
        throw e;
    }
    if (!res.ok) {
        const headerReqId = res.headers.get("x-request-id") ?? undefined;
        let raw = "";
        try {
            raw = await res.text();
        }
        catch {
            raw = "";
        }
        let parsed = null;
        try {
            parsed = raw ? JSON.parse(raw) : null;
        }
        catch {
            parsed = null;
        }
        const obj = asObject(parsed);
        const errObj = obj ? asObject(obj["error"]) : null;
        const hasStandardShape = !!errObj &&
            typeof errObj["code"] === "string" &&
            typeof errObj["message"] === "string";
        if (hasStandardShape) {
            const requestIdFromBody = typeof errObj["requestId"] === "string"
                ? errObj["requestId"]
                : undefined;
            const timestampFromBody = typeof errObj["timestamp"] === "string"
                ? errObj["timestamp"]
                : undefined;
            const detailsFromBodyRaw = errObj["details"];
            const detailsFromBody = detailsFromBodyRaw && typeof detailsFromBodyRaw === "object"
                ? detailsFromBodyRaw
                : undefined;
            const normalized = {
                error: {
                    code: String(errObj["code"]),
                    message: String(errObj["message"]),
                    requestId: requestIdFromBody ?? headerReqId,
                    timestamp: timestampFromBody ?? new Date().toISOString(),
                    details: detailsFromBody,
                },
            };
            throw new ApiError(normalized, res.status);
        }
        const messageFromBody = obj && typeof obj["message"] === "string"
            ? obj["message"]
            : "";
        const codeFromBody = obj && typeof obj["code"] === "string" ? obj["code"] : "";
        const detailsFromBody = obj && typeof obj["details"] === "object" && obj["details"] !== null
            ? obj["details"]
            : undefined;
        const billingWall = obj && typeof obj["billingWall"] === "object" && obj["billingWall"] !== null
            ? obj["billingWall"]
            : undefined;
        // Evidence Lifecycle REAL FIX — some legacy routes return denial info at
        // TOP LEVEL of the error body (e.g. `{denial: "ENTITLEMENT_REQUIRED",
        // entitlement: "FEATURE_X"}`) instead of nesting it under `details`.
        // Pre-fix, `error.details` was undefined for these responses, so the
        // frontend's denial mapper never matched and rendered a generic error
        // instead of the entitlement panel. We now treat the whole body as
        // `details` when no explicit `details` field is present AND the body
        // contains canonical denial fields. This is additive — routes already
        // sending `details` are unaffected.
        const topLevelDenialFields = ["denial", "entitlement", "requiredTier", "requiredEntitlement"];
        const bodyHasTopLevelDenial = obj &&
            !detailsFromBody &&
            topLevelDenialFields.some((k) => typeof obj[k] === "string");
        const promotedDetails = bodyHasTopLevelDenial
            ? obj
            : undefined;
        const message = messageFromBody || (raw && raw.trim()) || `HTTP ${res.status}: API error`;
        const requestIdFromBody = obj && typeof obj["requestId"] === "string"
            ? obj["requestId"]
            : undefined;
        const requestId = requestIdFromBody ?? headerReqId;
        const error = new Error(requestId ? `${message} (requestId: ${requestId})` : message);
        error.code =
            codeFromBody ||
                (typeof obj?.["denial"] === "string" ? obj["denial"] : "") ||
                (res.status === 401 ? "UNAUTHORIZED" : "API_ERROR");
        error.statusCode = res.status;
        error.requestId = requestId;
        error.details = detailsFromBody ?? promotedDetails ?? billingWall;
        throw error;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
        return null;
    }
    try {
        return await res.json();
    }
    catch {
        const error = new Error("Invalid response format");
        error.code = "PARSE_ERROR";
        error.statusCode = res.status;
        throw error;
    }
}
