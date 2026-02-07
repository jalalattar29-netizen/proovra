import type { FastifyRequest } from "fastify";

export function getAuthUserId(req: FastifyRequest): string {
  if (!req.user?.sub) {
    throw new Error("Unauthenticated");
  }
  return req.user.sub;
}
