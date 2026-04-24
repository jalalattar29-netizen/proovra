import { ReportViewModel } from "../types.js";
import { renderIntegrityProofSection } from "./integrity-proof.js";

export function renderStorageTimestampingSection(vm: ReportViewModel): string {
  return renderIntegrityProofSection(vm);
}