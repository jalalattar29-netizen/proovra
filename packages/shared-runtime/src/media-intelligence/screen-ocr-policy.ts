/**
 * UC-4 — the LOCAL-OCR workspace gate.
 *
 * `resolveWorkspaceAiPolicy` (services/api) remains THE authority for AI
 * decisions that send content to an external provider (the ordered gate:
 * global platform flag + provider config + features + data class + roles). Local
 * deterministic OCR needs none of that — no external provider, no egress — so its
 * only workspace-owned control is `workspace_ai_policies.ai_enabled &&
 * .ocr_allowed`, read here from the SAME canonical row with the SAME fail-closed
 * default (no row ⇒ ocrAllowed = false).
 *
 * This is enforced at OCR TIME (the worker) AND surfaced at trigger time (the
 * API), so a workspace that disables OCR after a run is queued still does not get
 * OCR — deterministic keyframe/overlap processing continues and the DERIVED
 * result is truthfully PARTIAL. It is ONE reader, not a second policy engine.
 */

import type { PrismaClient } from "@prisma/client";

import { getRegisteredPrisma } from "../prisma-registry.js";

/** Fail-closed default mirroring DEFAULT_WORKSPACE_AI_POLICY (ai on, ocr off). */
const DEFAULT_OCR_ALLOWED = false;

export async function resolveWorkspaceOcrAllowed(
  teamId: string | null,
  client: PrismaClient = getRegisteredPrisma(),
): Promise<boolean> {
  if (!teamId) return DEFAULT_OCR_ALLOWED;
  try {
    const row = await client.workspaceAiPolicy.findUnique({
      where: { teamId },
      select: { aiEnabled: true, ocrAllowed: true },
    });
    if (!row) return DEFAULT_OCR_ALLOWED;
    return row.aiEnabled && row.ocrAllowed;
  } catch {
    // Fail closed on a read error — never run OCR we cannot prove is permitted.
    return DEFAULT_OCR_ALLOWED;
  }
}
