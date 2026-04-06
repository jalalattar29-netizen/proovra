import type { FastifyReply, FastifyRequest } from "fastify";
import { assertUserHasRequiredLegalAcceptances } from "../services/legal-acceptance.service.js";

export async function requireLegalAcceptance(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const userId = (req.user as { sub?: string } | undefined)?.sub;

  if (!userId) {
    return reply.code(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required.",
        requestId: req.id,
      },
    });
  }

  try {
    await assertUserHasRequiredLegalAcceptances({ userId });
  } catch (err) {
    const code =
      err instanceof Error && "code" in err && typeof err.code === "string"
        ? err.code
        : "LEGAL_REACCEPT_REQUIRED";

    const statusCode =
      err instanceof Error &&
      "statusCode" in err &&
      typeof err.statusCode === "number"
        ? err.statusCode
        : 428;

    const details =
      err instanceof Error && "details" in err ? err.details : undefined;

    return reply.code(statusCode).send({
      error: {
        code,
        message: "You must accept the latest legal policies before continuing.",
        requestId: req.id,
        details,
      },
    });
  }
}