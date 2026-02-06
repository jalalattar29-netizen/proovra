import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyJwt } from "../services/jwt.js";

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) {
      return decodeURIComponent(part.slice(name.length + 1));
    }
  }
  return null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    const auth = req.headers.authorization ?? "";
    const [, headerToken] = auth.split(" ");
    const cookieToken = readCookie(req.headers.cookie, "proovra_session");
    const token = headerToken || cookieToken;
    if (!token) {
      reply.code(401).send({ message: "Unauthorized" });
      return;
    }
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) throw new Error("AUTH_JWT_SECRET is not set");
    const payload = verifyJwt(token, secret);
    req.user = { sub: payload.sub, provider: payload.provider, email: payload.email };
  } catch {
    reply.code(401).send({ message: "Unauthorized" });
    return;
  }
}
