/**
 * PRO-C1-01 — a web Finish writes into the record's OWN workspace, never one the
 * page no longer shows.
 *
 * The record-scoped capture writes (POST /v1/evidence/:id/parts, /complete and
 * the resumable upload-session create) authorize on the RECORD's workspace. A
 * web page that reserved a record in workspace A and then switched to B could
 * keep uploading into, and sealing, A's record while its Review dialog said B.
 * The canonical rule (C-08, resolveResumableDraftRecord) releases such a
 * reservation when the Finish goes through POST /v1/evidence; this is the
 * defence in depth for a client that skips that POST.
 *
 * Only the web client is held to it (it identifies itself with `x-web-client`
 * and always names the workspace on screen). Mobile, the extension and API
 * integrations name a workspace too, but their record writes are bound to the
 * record or the session they opened, so a header that differs means nothing
 * about which workspace the person sees. A request that names no workspace,
 * and a legacy record with no workspace, are unaffected.
 */
import type { FastifyRequest } from "fastify";

import { readWorkspaceHeader } from "../access/request-workspace.js";

export const CAPTURE_WORKSPACE_CHANGED = "CAPTURE_WORKSPACE_CHANGED" as const;

export type CaptureWorkspaceMismatch = {
  statusCode: 409;
  body: { code: typeof CAPTURE_WORKSPACE_CHANGED; message: string };
};

export function captureWorkspaceMismatch(
  req: FastifyRequest,
  recordTeamId: string | null | undefined,
): CaptureWorkspaceMismatch | null {
  if (req.headers?.["x-web-client"] !== "1") return null;
  if (!recordTeamId) return null;
  const named = readWorkspaceHeader(req);
  if (!named || named === recordTeamId) return null;
  return {
    statusCode: 409,
    body: {
      code: CAPTURE_WORKSPACE_CHANGED,
      message:
        "This capture was reserved in another workspace. Finish it again from the workspace you are in now; nothing was added to the other workspace.",
    },
  };
}
