/**
 * Phase 15 — Similarity detection service.
 *
 * Produces ADVISORY similarity hints between evidence rows. Three
 * deterministic signals (no AI required):
 *
 *   1. HASH_DUPLICATE      — exact fileSha256 match within workspace.
 *   2. FILENAME_SIMILAR    — Jaccard on filename tokens.
 *   3. OCR_SIMILAR /
 *      TRANSCRIPT_SIMILAR  — Jaccard on extracted text tokens.
 *
 * Wording rules (per Phase 15 brief):
 *   - "possible related evidence"
 *   - "possible duplicate"
 *   - "similar metadata detected"
 *   - NEVER "same evidence confirmed"
 *
 * The service NEVER auto-merges, auto-deletes, or modifies the
 * evidence row. Findings live on `evidence_similarities`.
 */
import { filenameTokens, jaccardSimilarity, similaritySummaryFor, textSimilarity, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
const FILENAME_THRESHOLD = 0.6;
const TEXT_THRESHOLD = 0.4;
// -----------------------------------------------------------------------------
// Persistence helpers
// -----------------------------------------------------------------------------
async function upsertSimilarity(client, input) {
    if (input.sourceEvidenceId === input.targetEvidenceId)
        return null;
    // Normalise pair so (A,B,kind) and (B,A,kind) don't both exist —
    // we store the smaller id first.
    const [a, b] = input.sourceEvidenceId < input.targetEvidenceId
        ? [input.sourceEvidenceId, input.targetEvidenceId]
        : [input.targetEvidenceId, input.sourceEvidenceId];
    try {
        return await client.evidenceSimilarity.upsert({
            where: {
                sourceEvidenceId_targetEvidenceId_kind: {
                    sourceEvidenceId: a,
                    targetEvidenceId: b,
                    kind: input.kind,
                },
            },
            create: {
                teamId: input.teamId,
                sourceEvidenceId: a,
                targetEvidenceId: b,
                kind: input.kind,
                score: Math.max(0, Math.min(1, input.score)),
                advisorySummary: similaritySummaryFor(input.kind),
            },
            update: {
                score: Math.max(0, Math.min(1, input.score)),
                advisorySummary: similaritySummaryFor(input.kind),
            },
        });
    }
    catch {
        return null;
    }
}
// -----------------------------------------------------------------------------
// Detector — hash duplicates
// -----------------------------------------------------------------------------
export async function detectHashDuplicatesForEvidence(evidenceId, client = defaultPrisma) {
    const me = await client.evidence.findUnique({
        where: { id: evidenceId },
        select: { id: true, teamId: true, fileSha256: true },
    });
    if (!me || !me.fileSha256)
        return [];
    const peers = await client.evidence.findMany({
        where: {
            teamId: me.teamId,
            fileSha256: me.fileSha256,
            id: { not: me.id },
            deletedAt: null,
        },
        select: { id: true },
        take: 50,
    });
    const out = [];
    for (const p of peers) {
        const row = await upsertSimilarity(client, {
            teamId: me.teamId,
            sourceEvidenceId: me.id,
            targetEvidenceId: p.id,
            kind: "HASH_DUPLICATE",
            score: 1,
        });
        if (row)
            out.push(row);
    }
    return out;
}
// -----------------------------------------------------------------------------
// Detector — filename similarity
// -----------------------------------------------------------------------------
export async function detectFilenameSimilarForEvidence(evidenceId, client = defaultPrisma) {
    const me = await client.evidence.findUnique({
        where: { id: evidenceId },
        select: {
            id: true,
            teamId: true,
            displayFileName: true,
            originalFileName: true,
        },
    });
    if (!me)
        return [];
    const myName = me.displayFileName ?? me.originalFileName ?? "";
    const myTokens = filenameTokens(myName);
    if (myTokens.size < 2)
        return [];
    const peers = await client.evidence.findMany({
        where: {
            teamId: me.teamId,
            id: { not: me.id },
            deletedAt: null,
        },
        select: { id: true, displayFileName: true, originalFileName: true },
        take: 500,
    });
    const out = [];
    for (const p of peers) {
        const peerName = p.displayFileName ?? p.originalFileName ?? "";
        const peerTokens = filenameTokens(peerName);
        const score = jaccardSimilarity(myTokens, peerTokens);
        if (score >= FILENAME_THRESHOLD) {
            const row = await upsertSimilarity(client, {
                teamId: me.teamId,
                sourceEvidenceId: me.id,
                targetEvidenceId: p.id,
                kind: "FILENAME_SIMILAR",
                score,
            });
            if (row)
                out.push(row);
        }
    }
    return out;
}
// -----------------------------------------------------------------------------
// Detector — OCR / transcript text similarity (workspace-scoped)
// -----------------------------------------------------------------------------
export async function detectTextSimilarForEvidence(input, client = defaultPrisma) {
    const sourceTextKind = input.kind === "OCR_SIMILAR" ? ["OCR_PDF", "OCR_IMAGE"] : ["TRANSCRIPT_AUDIO", "TRANSCRIPT_VIDEO"];
    const me = await client.evidence.findUnique({
        where: { id: input.evidenceId },
        select: { id: true, teamId: true },
    });
    if (!me)
        return [];
    const myTexts = await client.evidenceExtractedText.findMany({
        where: {
            evidenceId: me.id,
            status: "COMPLETED",
            kind: { in: sourceTextKind },
        },
        select: { text: true },
    });
    const myText = myTexts
        .map((t) => t.text ?? "")
        .filter(Boolean)
        .join("\n");
    if (myText.trim().length < 64)
        return [];
    const peers = await client.evidenceExtractedText.findMany({
        where: {
            teamId: me.teamId,
            status: "COMPLETED",
            kind: { in: sourceTextKind },
            evidenceId: { not: me.id },
        },
        select: { evidenceId: true, text: true },
        take: 200,
    });
    const grouped = new Map();
    for (const p of peers) {
        const prev = grouped.get(p.evidenceId) ?? "";
        grouped.set(p.evidenceId, `${prev}\n${p.text ?? ""}`.trim());
    }
    const out = [];
    for (const [peerId, peerText] of grouped.entries()) {
        const score = textSimilarity(myText, peerText);
        if (score >= TEXT_THRESHOLD) {
            const row = await upsertSimilarity(client, {
                teamId: me.teamId,
                sourceEvidenceId: me.id,
                targetEvidenceId: peerId,
                kind: input.kind,
                score,
            });
            if (row)
                out.push(row);
        }
    }
    return out;
}
// -----------------------------------------------------------------------------
// Aggregated runner — convenience for the route layer
// -----------------------------------------------------------------------------
export async function reconcileSimilaritiesForEvidence(evidenceId, client = defaultPrisma) {
    const [hash, filename, ocr, transcript] = await Promise.all([
        detectHashDuplicatesForEvidence(evidenceId, client),
        detectFilenameSimilarForEvidence(evidenceId, client),
        detectTextSimilarForEvidence({ evidenceId, kind: "OCR_SIMILAR" }, client),
        detectTextSimilarForEvidence({ evidenceId, kind: "TRANSCRIPT_SIMILAR" }, client),
    ]);
    return {
        hash: hash.length,
        filename: filename.length,
        ocr: ocr.length,
        transcript: transcript.length,
    };
}
// -----------------------------------------------------------------------------
// Read helpers
// -----------------------------------------------------------------------------
export async function listSimilaritiesForEvidence(evidenceId, client = defaultPrisma) {
    return client.evidenceSimilarity.findMany({
        where: {
            OR: [
                { sourceEvidenceId: evidenceId },
                { targetEvidenceId: evidenceId },
            ],
        },
        orderBy: [{ kind: "asc" }, { score: "desc" }],
    });
}
export function projectSimilarity(row, forEvidenceId) {
    const other = row.sourceEvidenceId === forEvidenceId
        ? row.targetEvidenceId
        : row.sourceEvidenceId;
    return {
        id: row.id,
        kind: row.kind,
        otherEvidenceId: other,
        score: row.score,
        advisorySummary: row.advisorySummary,
        createdAt: row.createdAt.toISOString(),
    };
}
