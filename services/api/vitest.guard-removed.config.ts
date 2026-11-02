/**
 * Runs the GOV-001 known positive with the guard taken out, for this process only:
 * the source on disk is untouched. See `test/write-sweep-known-positive.integration.test.ts`.
 *
 *   npx vitest run --config vitest.guard-removed.config.ts test/write-sweep-known-positive.integration.test.ts
 */
import { mergeConfig } from "vitest/config";

import base from "./vitest.integration.config.js";

const GUARD = "await assertRecordsInWorkspace(prisma, input.teamId, evidenceIds);";

process.env.SWEEP_REMOVE_GOV001_GUARD = "1";

export default mergeConfig(base, {
  plugins: [
    {
      name: "remove-gov-001-guard",
      enforce: "pre",
      transform(code: string, id: string) {
        if (!id.includes("destruction-governance.service")) return null;
        if (!code.includes(GUARD)) throw new Error("GOV-001 guard not found: this proof no longer tests anything");
        return code.replace(GUARD, "");
      },
    },
  ],
});
