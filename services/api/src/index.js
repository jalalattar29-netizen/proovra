import "./env.js";
// Phase 31.22 — register the api's Prisma instance with the
// @proovra/shared-runtime registry BEFORE any service code runs.
import "./register-shared-runtime.js";
import { buildServer } from "./server.js";
const port = Number(process.env.PORT ?? 8081);
buildServer()
    .then((app) => app.listen({ port, host: "0.0.0.0" }))
    .catch((err) => {
    console.error(err);
    process.exit(1);
});
