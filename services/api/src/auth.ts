import type { FastifyRequest } from "fastify";

export function getDevUserId(req: FastifyRequest): string {
  const userId = req.headers["x-dev-user-id"];
  if (typeof userId === "string" && userId.trim().length > 0) return userId.trim();
  // company-grade default for local dev (still requires explicit header in production)
  return "dev-user-0001";
}
