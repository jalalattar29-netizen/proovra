/**
 * RETIRED ROUTE (team remediation T-079, stage D) — redirect only.
 * Coding schemas are a section of Review settings now.
 */
import { redirect } from "next/navigation";

export default function CodingSchemasRetired(): never {
  redirect("/review/settings?section=schemas");
}
