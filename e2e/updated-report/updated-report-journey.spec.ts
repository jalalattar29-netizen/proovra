/**
 * THE INCIDENT-SHAPED UPDATED-REPORT JOURNEY — real browser, real API, real
 * queue, the PRODUCTION worker image (Linux Chromium PDF renderer), real MinIO.
 *
 *   1. A TEAM workspace with an owner and a second authorized member.
 *   2. A finalized record whose report v1 + package v1 are issued by the worker
 *      while the RFC 3161 timestamp is recorded but NOT validated.
 *   3. v1 PDF/ZIP bytes captured and hashed.
 *   4. Trust advances through product paths: the kept TSA token is validated by
 *      the repair script; the OTS anchor is recorded by the worker's upgrade
 *      processor.
 *   5. In the browser: the Artifacts tab explains the newer facts, "Generate
 *      updated report" opens the dialog, a reason is entered, Confirm sends the
 *      SIGNED offer revision, the durable request + queue job are captured, the
 *      page is reloaded mid-flight and the progress card is still there, the
 *      request completes, v2 is Latest and v1 stays in history.
 *   6. v2 PDF and ZIP are downloaded; the ZIP's embedded report is the stored
 *      v2 PDF byte for byte; v2 states the validated timestamp and the anchor;
 *      v1 bytes are unchanged.
 *
 * Evidence files (hashes, request/job ids, screenshots, trace) are written to
 * the test output directory and summarised in `journey-proof.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { test, expect, type Page } from "@playwright/test";

import {
  SESSION_PASSWORD,
  clearTestRateLimits,
  createGuestSession,
  type GuestSession,
} from "../helpers/api-client";
import {
  addWorkspaceMember,
  anchorOtsThroughUpgrade,
  createFinalizedEvidence,
  downloadVersion,
  personalTeamId,
  readZipEntries,
  sha256Hex,
  sql,
  stackExec,
  status,
  validateKeptTsaToken,
  waitForPair,
} from "./_stack";

test.describe.configure({ mode: "serial" });

const WORKER_DIR = resolve(__dirname, "..", "..", "services", "worker");
const PROOF_DIR = resolve(process.env.RGA_PROOF_DIR ?? join(require("node:os").tmpdir(), "pv-rga-proof"));

function pdfText(bytes: Buffer, name: string): string {
  mkdirSync(PROOF_DIR, { recursive: true });
  const file = join(PROOF_DIR, name);
  writeFileSync(file, bytes);
  const run = spawnSync(process.execPath, [resolve(__dirname, "pdf-text.mjs"), file], { cwd: WORKER_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`pdf-text failed: ${run.stderr}`);
  return run.stdout.replace(/\s+/g, " ");
}

async function signIn(page: Page, email: string) {
  await clearTestRateLimits();
  await page.goto("/login");
  await page.locator('input[placeholder="Email"]:visible').first().fill(email);
  await page.locator('input[placeholder="Password"]:visible').first().fill(SESSION_PASSWORD);
  await page.locator("input.auth-legal-checkbox:visible").first().check();
  await page.locator('[data-auth-email-cta="SIGN_IN"]:visible').first().click();
  await page.waitForURL(/\/home/, { timeout: 60_000 });
}

async function openArtifacts(page: Page, evidenceId: string) {
  await page.goto(`/evidence/${evidenceId}`);
  await page.waitForSelector(".evidence-detail-hero", { timeout: 60_000 });
  await page.getByRole("tab", { name: "Artifacts" }).click();
  await page.waitForSelector("[data-testid='artifact-truth-header']", { timeout: 60_000 });
}

/**
 * The report's own statements about the timestamp and the anchor: the status
 * word and statement of each verification-matrix row, as rendered in the PDF.
 */
const MATRIX_STATUS = "(VERIFIED|FAILED|NOT_CHECKED|NOT_APPLICABLE|UNAVAILABLE)";
function trustStatements(text: string) {
  const row = (label: string) => {
    // A statement runs to the next row's mark (or the matrix summary).
    const m = text.match(new RegExp(`${label}\\s+${MATRIX_STATUS}\\s+([^]{1,260}?)(?=\\s+[!✓i]\\s+[A-Z]|\\s+Summary\\b)`));
    return { status: m?.[1] ?? null, statement: m?.[2]?.replace(/\s+/g, " ").trim() ?? null };
  };
  const tsa = row("Trusted timestamp \\(RFC 3161\\)");
  const ots = row("OpenTimestamps / Bitcoin anchoring");
  return { tsaStatus: tsa.status, tsaStatement: tsa.statement, otsStatus: ots.status, otsStatement: ots.statement };
}

const proof: Record<string, unknown> = {};
function record(key: string, value: unknown) {
  proof[key] = value;
  mkdirSync(PROOF_DIR, { recursive: true });
  writeFileSync(join(PROOF_DIR, "journey-proof.json"), JSON.stringify(proof, null, 2));
}

test.describe("updated report — the real stack, end to end", () => {
  let owner: GuestSession;
  let member: GuestSession;
  let teamId = "";
  let evidenceId = "";
  const v1 = { pdf: Buffer.alloc(0), zip: Buffer.alloc(0) };

  test("v1 is issued by the production worker while the timestamp is recorded but NOT validated", async () => {
    test.setTimeout(420_000);
    await clearTestRateLimits();
    owner = await createGuestSession({ plan: "TEAM" });
    member = await createGuestSession({ plan: "TEAM" });
    teamId = await personalTeamId(owner.api);
    addWorkspaceMember(teamId, member.userId, "ADMIN");

    const ev = await createFinalizedEvidence(owner.api, teamId, "incident");
    evidenceId = ev.id;
    await waitForPair(owner.api, evidenceId, 1);

    const [row] = sql<{ tsa_status: string; tsa_validated_at_utc: string | null; has_token: boolean; team_id: string }>(
      "SELECT tsa_status, tsa_validated_at_utc, (tsa_token_base64 IS NOT NULL AND length(tsa_token_base64) > 0) AS has_token, team_id FROM evidence WHERE id = $1",
      [evidenceId],
    );
    expect(row?.tsa_status).toBe("FAILED");
    expect(row?.tsa_validated_at_utc).toBeNull();
    expect(row?.has_token).toBe(true);
    expect(row?.team_id).toBe(teamId);

    const s = await status(owner.api, evidenceId);
    expect(s.outputs.trust.tsa).toMatchObject({ status: "FAILED", validated: false });
    expect(s.outputs.freshness.hasNewerFacts).toBe(false);

    v1.pdf = await downloadVersion(owner.api, evidenceId, "report", 1);
    v1.zip = await downloadVersion(owner.api, evidenceId, "package", 1);
    expect(v1.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const v1Row = s.versions.versions.find((v) => v.reportVersion === 1)!;
    expect(sha256Hex(v1.pdf)).toBe(v1Row.sha256);
    expect(sha256Hex(v1.zip)).toBe(v1Row.package!.sha256);
    const v1Text = pdfText(v1.pdf, "report-v1.pdf");
    writeFileSync(join(PROOF_DIR, "package-v1.zip"), v1.zip);
    record("evidenceId", evidenceId);
    record("workspaceId", teamId);
    const v1Claims = trustStatements(v1Text);
    // v1 states the truth at its issuance: a token that could not be validated.
    expect(v1Claims.tsaStatus).toBe("NOT_CHECKED");
    expect(v1Claims.tsaStatement ?? "").toMatch(/not validated/i);
    record("v1", {
      reportSha256: sha256Hex(v1.pdf),
      packageSha256: sha256Hex(v1.zip),
      reportBytes: v1.pdf.length,
      packageBytes: v1.zip.length,
      trustStatements: v1Claims,
    });
  });

  test("trust advances through product paths: kept TSA token validated, OTS anchored by the worker", async () => {
    test.setTimeout(300_000);
    const repairOut = validateKeptTsaToken(evidenceId);
    record("tsaRepairOutput", repairOut.split("\n").filter((l) => l.trim()).slice(-6));
    const [tsa] = sql<{ tsa_status: string; tsa_validated_at_utc: string | null; tsa_failure_code: string | null }>(
      "SELECT tsa_status, tsa_validated_at_utc, tsa_failure_code FROM evidence WHERE id = $1",
      [evidenceId],
    );
    expect(tsa?.tsa_status).toBe("STAMPED");
    expect(tsa?.tsa_validated_at_utc).not.toBeNull();
    expect(tsa?.tsa_failure_code).toBeNull();

    anchorOtsThroughUpgrade(evidenceId);
    await expect
      .poll(async () => (await status(owner.api, evidenceId)).outputs.trust.ots.status, { timeout: 180_000, intervals: [2000] })
      .toBe("ANCHORED");
    const s = await status(owner.api, evidenceId);
    expect(s.outputs.trust.ots.anchorCheck).toBe("PROOF_STRUCTURE");
    expect(s.outputs.freshness.hasNewerFacts).toBe(true);
    expect(s.outputs.freshness.changes.map((c) => c.code)).toEqual(
      expect.arrayContaining(["TSA_VALIDATED_AFTER_REPORT", "OTS_ANCHORED_AFTER_REPORT"]),
    );
    expect(s.outputs.newVersion).toMatchObject({ action: "CREATE_NEW_VERSION", currentVersion: 1, nextVersion: 2 });
    record("trustAfter", s.outputs.trust);
    record("freshnessBeforeV2", s.outputs.freshness);
  });

  test("browser: newer facts explained → Generate updated report → Confirm with the signed offer → durable progress survives reload → v2 Latest", async ({ page }) => {
    test.setTimeout(600_000);
    await signIn(page, owner.email);
    await openArtifacts(page, evidenceId);

    const header = page.getByTestId("artifact-truth-header");
    await expect(header.getByTestId("truth-freshness")).toContainText("New verification facts are available");
    await expect(header.getByTestId("truth-freshness")).toContainText("The trusted timestamp was validated after report v1 was generated.");
    await expect(header.getByTestId("truth-freshness")).toContainText("A Bitcoin attestation was added to the OpenTimestamps proof after report v1 was generated.");
    await expect(header.getByTestId("truth-tsa")).toHaveText("Validated");
    await expect(page.getByTestId("pair-1")).toHaveAttribute("data-pair-latest", "true");
    await page.screenshot({ path: join(PROOF_DIR, "01-status-freshness.png"), fullPage: true });

    await page.getByTestId("evidence-new-version").click();
    const dialog = page.getByTestId("updated-report-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Generate report v2");
    await expect(dialog.getByTestId("updated-report-reason")).toBeFocused();
    await expect(dialog.getByTestId("updated-report-confirm")).toBeDisabled();
    await expect(dialog.getByTestId("updated-report-credit")).toHaveText("No evidence credit is used.");
    await dialog.getByTestId("updated-report-reason").fill("Document the validated timestamp and the Bitcoin anchor");
    await expect(dialog.getByTestId("updated-report-confirm")).toBeEnabled();
    await page.screenshot({ path: join(PROOF_DIR, "02-modal.png") });

    const [request, response] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/v1/evidence/${evidenceId}/reports/regenerate`) && r.method() === "POST"),
      page.waitForResponse((r) => r.url().includes(`/v1/evidence/${evidenceId}/reports/regenerate`) && r.request().method() === "POST"),
      dialog.getByTestId("updated-report-confirm").click(),
    ]);
    const sent = JSON.parse(request.postData() ?? "{}") as { intent: string; offerRevision?: string; reason: string; clientRequestKey: string };
    expect(sent.intent).toBe("NEW_VERSION");
    expect(sent.offerRevision).toMatch(/^ofr1\./);
    expect(sent.reason).toBe("Document the validated timestamp and the Bitcoin anchor");
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as { requestId: string; operation: string; outcome: string };
    expect(accepted.operation).toBe("NEW_VERSION");
    const requestId = accepted.requestId;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const jobId = `report-${requestId}`;
    const jobKeyExists = stackExec("redis", ["redis-cli", "EXISTS", `bull:report:${jobId}`]).trim();
    record("durableRequest", { requestId, jobId, jobKeyExistsAtAccept: jobKeyExists, outcome: accepted.outcome, offerRevisionPrefix: sent.offerRevision?.slice(0, 12) });

    // Every durable step the worker writes, sampled straight from the row (the
    // browser polls every 3 s and may skip a fast step; the row does not).
    const durableSteps: string[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const [r] = sql<{ state: string; stage: string | null; progress_stage: string | null }>(
          "SELECT state, stage, progress_stage FROM report_generation_requests WHERE id = $1",
          [requestId],
        );
        const key = `${r?.state}|${r?.stage ?? "-"}|${r?.progress_stage ?? "-"}`;
        if (durableSteps[durableSteps.length - 1] !== key) durableSteps.push(key);
        if (r?.state === "SUCCEEDED" || r?.state?.startsWith("FAILED")) break;
        await new Promise((res) => setTimeout(res, 150));
      }
    })();

    // The dialog closed; the durable progress card follows the request.
    await expect(page.getByTestId("updated-report-dialog")).toHaveCount(0);
    const card = page.getByTestId("output-progress");
    await expect(card).toHaveAttribute("data-output-request-id", requestId, { timeout: 60_000 });
    await page.screenshot({ path: join(PROOF_DIR, "03-progress-accepted.png"), fullPage: true });

    // RELOAD DURING PROCESSING: the step comes back from the database.
    const stepBefore = await card.getAttribute("data-output-progress-step");
    await page.reload();
    await page.getByRole("tab", { name: "Artifacts" }).click();
    const outcomeAfterReload = await page.getByTestId("output-progress").getAttribute("data-output-progress-outcome");
    await expect(page.getByTestId("output-progress")).toHaveAttribute("data-output-request-id", requestId);
    record("reloadDuringProcessing", { stepBefore, outcomeAfterReload, stepAfter: await page.getByTestId("output-progress").getAttribute("data-output-progress-step") });
    await page.screenshot({ path: join(PROOF_DIR, "04-progress-after-reload.png"), fullPage: true });

    // Steps observed while it runs (all from persisted columns).
    const observed = new Set<string>();
    await expect
      .poll(
        async () => {
          const step = await page.getByTestId("output-progress").getAttribute("data-output-progress-step").catch(() => null);
          const outcome = await page.getByTestId("output-progress").getAttribute("data-output-progress-outcome").catch(() => null);
          if (step) observed.add(step);
          return outcome;
        },
        { timeout: 420_000, intervals: [1000] },
      )
      .toBe("SUCCEEDED");
    record("progressStepsObservedInBrowser", [...observed]);
    sampling = false;
    await sampler;
    record("durableStepsFromDatabase", durableSteps);
    expect(durableSteps.some((k) => k.includes("|RENDERING_REPORT"))).toBe(true);
    expect(durableSteps.some((k) => k.includes("|VERIFYING_REPORT") || k.includes("REPORT_COMMITTED"))).toBe(true);
    expect(durableSteps.some((k) => k.includes("|BUILDING_PACKAGE") || k.includes("|VERIFYING_PACKAGE"))).toBe(true);
    await page.screenshot({ path: join(PROOF_DIR, "05-progress-complete.png"), fullPage: true });

    const [reqRow] = sql<{ state: string; stage: string; progress_stage: string; report_version: number; intent: string; regenerate_reason: string }>(
      "SELECT state, stage, progress_stage, report_version, intent, regenerate_reason FROM report_generation_requests WHERE id = $1",
      [requestId],
    );
    expect(reqRow).toMatchObject({ state: "SUCCEEDED", report_version: 2, intent: "NEW_VERSION" });
    record("durableRequestFinal", reqRow);

    // FULL reload: v2 is Latest, v1 stays in history, each paired with its own package.
    await page.reload();
    await page.getByRole("tab", { name: "Artifacts" }).click();
    await expect(page.getByTestId("pair-2")).toHaveAttribute("data-pair-latest", "true");
    await expect(page.getByTestId("pair-2")).toHaveAttribute("data-pair-package-version", "2");
    await expect(page.getByTestId("pair-1")).toHaveAttribute("data-pair-latest", "false");
    await expect(page.getByTestId("pair-1")).toHaveAttribute("data-pair-package-version", "1");
    await expect(page.getByTestId("truth-download-report")).toHaveText("Download Report PDF v2");
    await expect(page.getByTestId("truth-download-package")).toHaveText("Download Verification Package ZIP v2");
    await expect(page.getByTestId("truth-freshness-state")).toHaveText("Current");
    await expect(page.getByTestId("truth-freshness")).toHaveCount(0);
    await page.screenshot({ path: join(PROOF_DIR, "06-version-history.png"), fullPage: true });
  });

  test("artifact proof: real v2 PDF + ZIP, package embeds the exact stored v2 report, v2 states current trust, v1 bytes unchanged", async () => {
    test.setTimeout(300_000);
    const s = await status(owner.api, evidenceId);
    const v2Row = s.versions.versions.find((v) => v.reportVersion === 2)!;
    expect(v2Row.latest).toBe(true);
    expect(v2Row.package?.version).toBe(2);

    const pdf2 = await downloadVersion(owner.api, evidenceId, "report", 2);
    const zip2 = await downloadVersion(owner.api, evidenceId, "package", 2);
    writeFileSync(join(PROOF_DIR, "package-v2.zip"), zip2);
    writeFileSync(join(PROOF_DIR, "report-v2.pdf"), pdf2);
    expect(pdf2.subarray(0, 5).toString()).toBe("%PDF-");
    expect(sha256Hex(pdf2)).toBe(v2Row.sha256);
    expect(sha256Hex(zip2)).toBe(v2Row.package!.sha256);
    expect(v2Row.package!.embeddedReportSha256).toBe(v2Row.sha256);

    // Version-specific storage keys, read back from the object store.
    const keys = sql<{ kind: string; version: number; storage_key: string; s3_version_id: string | null }>(
      `SELECT 'report' AS kind, version, storage_key, s3_version_id FROM reports WHERE evidence_id = $1
       UNION ALL SELECT 'package', version, storage_key, s3_version_id FROM verification_packages WHERE evidence_id = $1 AND state = 'PUBLISHED'
       ORDER BY kind, version`,
      [evidenceId],
    );
    expect(new Set(keys.map((k) => k.storage_key)).size).toBe(keys.length);
    for (const k of keys) expect(k.storage_key).toContain(`/v${k.version}/`);
    const heads = keys.map((k) => ({
      ...k,
      stat: stackExec("minio", ["sh", "-c", `ls -la /data/proovra-rga/${k.storage_key.split("/").slice(0, -1).join("/")} >/dev/null 2>&1 && echo present || echo absent`]).trim(),
    }));
    record("storage", heads);

    // Extract the ZIP and compare the embedded report to the stored v2 PDF.
    const entries = readZipEntries(zip2);
    const names = [...entries.keys()];
    const pdfEntry = names.find((n) => /\.pdf$/i.test(n) && /report/i.test(n));
    expect(pdfEntry, names.join(", ")).toBeTruthy();
    const embedded = entries.get(pdfEntry!)!;
    expect(sha256Hex(embedded)).toBe(sha256Hex(pdf2));
    // EXTRACTED-PACKAGE VERIFICATION: the checksum index covers every entry,
    // the seal binds the index and the v2 report digest, and the Ed25519 seal
    // signature verifies against the key shipped in the package.
    const checksums = JSON.parse(entries.get("package-checksums.json")!.toString("utf8")) as {
      fileCount: number;
      files: Array<{ path: string; sizeBytes: number; sha256: string }>;
    };
    for (const f of checksums.files) {
      const bytes = entries.get(f.path);
      expect(bytes, `missing entry ${f.path}`).toBeTruthy();
      expect(bytes!.length, f.path).toBe(f.sizeBytes);
      expect(sha256Hex(bytes!), f.path).toBe(f.sha256);
    }
    expect(checksums.files.length).toBe(checksums.fileCount);
    expect(checksums.files.some((f) => f.path === pdfEntry && f.sha256 === sha256Hex(pdf2))).toBe(true);
    const sealBytes = entries.get("package-seal.json")!;
    const seal = JSON.parse(sealBytes.toString("utf8")) as {
      checksumsSha256: string; reportFile: string; reportSha256: string; reportVersion: number; evidenceId: string; packageFormatVersion: number;
    };
    expect(seal.checksumsSha256).toBe(sha256Hex(entries.get("package-checksums.json")!));
    expect(seal).toMatchObject({ reportFile: pdfEntry, reportSha256: sha256Hex(pdf2), reportVersion: 2, evidenceId, packageFormatVersion: 5 });
    const sig = JSON.parse(entries.get("package-seal.sig")!.toString("utf8")) as { sealSha256: string; signatureBase64: string; publicKeyFile: string };
    expect(sig.sealSha256).toBe(sha256Hex(sealBytes));
    const { createHash: ch, createPublicKey, verify } = await import("node:crypto");
    const signatureValid = verify(
      null,
      ch("sha256").update(sealBytes).digest(),
      createPublicKey(entries.get(sig.publicKeyFile)!.toString("utf8")),
      Buffer.from(sig.signatureBase64, "base64"),
    );
    expect(signatureValid).toBe(true);
    record("v2", {
      reportSha256: sha256Hex(pdf2),
      packageSha256: sha256Hex(zip2),
      reportBytes: pdf2.length,
      packageBytes: zip2.length,
      zipEntryCount: names.length,
      embeddedReportEntry: pdfEntry,
      embeddedReportSha256: sha256Hex(embedded),
      checksumEntriesVerified: checksums.files.length,
      sealChecksumsSha256: seal.checksumsSha256,
      sealReportSha256: seal.reportSha256,
      sealSignatureEd25519Valid: signatureValid,
    });

    const text2 = pdfText(pdf2, "report-v2.pdf");
    const claims2 = trustStatements(text2);
    record("v2TrustStatements", claims2);
    // v2 states the validated token — with the bounded sentence, never as
    // qualified — and states the anchor proof as present but NOT_CHECKED.
    expect(claims2.tsaStatus).toBe("VERIFIED");
    expect(claims2.tsaStatement ?? "").toMatch(/^RFC 3161 timestamp validated\./);
    expect(claims2.otsStatus).toBe("NOT_CHECKED");
    expect(claims2.otsStatement ?? "").toMatch(/anchor/i);
    expect(claims2.otsStatement ?? "").not.toMatch(/does not match|concern|review required|pending|not recorded/i);

    // v1 is untouched: same bytes, same hashes, still downloadable.
    const pdf1Again = await downloadVersion(owner.api, evidenceId, "report", 1);
    const zip1Again = await downloadVersion(owner.api, evidenceId, "package", 1);
    expect(sha256Hex(pdf1Again)).toBe(sha256Hex(v1.pdf));
    expect(sha256Hex(zip1Again)).toBe(sha256Hex(v1.zip));
    expect(Buffer.compare(pdf1Again, v1.pdf)).toBe(0);
    expect(Buffer.compare(zip1Again, v1.zip)).toBe(0);
    record("v1Unchanged", { report: sha256Hex(pdf1Again), package: sha256Hex(zip1Again) });

    // The second member sees the same truth.
    const asMember = await status(member.api, evidenceId);
    expect(asMember.versions.versions.map((v) => [v.reportVersion, v.latest, v.package?.version])).toEqual([
      [2, true, 2],
      [1, false, 1],
    ]);
  });
});
