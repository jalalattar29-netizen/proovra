"use client";

import { UseCasePage } from "../../components/use-case-page";
import { USE_CASES } from "../../components/use-case-data";

export default function ForLawyersPage() {
  return <UseCasePage content={USE_CASES.lawyers} />;
}