import { createDemoRequest } from "../services/demo-request.service.js";
function readHeader(req, name) {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value))
        return value[0] ?? null;
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function readIp(req) {
    const forwarded = readHeader(req, "x-forwarded-for");
    if (forwarded) {
        const first = forwarded.split(",")[0]?.trim();
        if (first)
            return first;
    }
    return req.ip ?? null;
}
export async function demoRequestsRoutes(app) {
    app.post("/v1/demo-requests", async (req, reply) => {
        const result = await createDemoRequest(req.body, {
            ipAddress: readIp(req),
            userAgent: readHeader(req, "user-agent"),
        });
        return reply.code(201).send(result);
    });
}
