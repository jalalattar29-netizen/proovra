"use client";

/**
 * THE ONE MOUNT of the canonical updated-report dialog for Evidence Detail.
 *
 * It used to live inside the Artifacts tab, which made it unreachable from the
 * Overview "Evidence outputs" card. It is mounted once by the page now and
 * opened through `ctx.openUpdatedReport` from either surface — the same
 * dialog, the same signed-offer revalidation at Confirm, the same submit. The
 * dialog returns focus to whichever button opened it.
 */

import { apiFetch } from "../../../../../lib/api";
import { UpdatedReportDialog } from "../../../../../components/evidence-outputs/UpdatedReportDialog";
import type { ArtifactOutputsExtras } from "../../../../../components/evidence-outputs/artifact-status-types";
import type { EvidenceDetailCtx } from "./_lib";

export function UpdatedReportDialogHost({
  ctx,
  open,
  onClose,
}: {
  ctx: Pick<EvidenceDetailCtx, "workspace" | "evidenceId" | "createNewVersion" | "loadWorkspace">;
  open: boolean;
  onClose: () => void;
}) {
  // `workspace` is the review-workspace record, read destructured like every
  // tab (the platform tenancy envelope is a different object).
  const { workspace } = ctx;
  const outputs = workspace.artifactStatus.outputs;
  return (
    <UpdatedReportDialog
      open={open}
      onClose={onClose}
      initial={{
        newVersion: outputs.newVersion ?? null,
        offer: outputs.offer ?? null,
        freshness: outputs.freshness ?? null,
      }}
      loadStatus={async () =>
        (await apiFetch(`/v1/evidence/${ctx.evidenceId}/artifacts/status`)) as {
          outputs?: ArtifactOutputsExtras | null;
        }
      }
      submit={ctx.createNewVersion}
      // ACCEPTED, NOT COMPLETE: the re-read carries the durable request (and the
      // attention it projects) from "Request accepted" to its terminal state.
      onAccepted={() => {
        void ctx.loadWorkspace();
      }}
    />
  );
}
