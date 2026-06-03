/**
 * PROOVRA Phase 3B — Deepgram adapter.
 *
 * Bounded adapter on top of the Phase 3A Closure
 * `deepgram-client.ts`. Maps transcript output into bounded
 * `TRANSCRIPT_SEGMENT`, `SPEAKER_SEGMENT`, and `TRANSCRIPT_WORD`
 * records the media-intelligence pipeline persists. Bills usage
 * in audio minutes.
 */
import { createHash } from "node:crypto";
import { classifyIntelligenceConfidence, } from "@proovra/shared";
import { probeDeepgram, transcribeAndScan, } from "../../redaction/providers/deepgram-client.js";
import { registerAdapter, } from "./provider-adapter.js";
const PROVIDER = "DEEPGRAM_TRANSCRIPT";
const SUPPORTED = [
    "TRANSCRIBE_AUDIO",
    "TRANSCRIBE_VIDEO_AUDIO_TRACK",
];
/**
 * Bounded Deepgram pricing — `nova-2` lists at $0.0043 per minute
 * at retail. Stored in USD micros.
 */
const COST_PER_MINUTE_USD_MICROS = 4300;
export const deepgramAdapter = {
    provider: PROVIDER,
    supportedOperations: SUPPORTED,
    probe() {
        const p = probeDeepgram();
        return {
            provider: PROVIDER,
            state: p.state,
            operations: SUPPORTED,
            reason: p.reason,
        };
    },
    async transcribeAudio(input) {
        return runDeepgram({
            audioBytes: input.bytes ?? null,
            audioUrl: input.url ?? null,
            contentType: input.contentType,
        });
    },
};
registerAdapter(deepgramAdapter);
// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------
async function runDeepgram(input) {
    const res = await transcribeAndScan({
        audioBytes: input.audioBytes,
        audioUrl: input.audioUrl,
        contentType: input.contentType ?? undefined,
    });
    if (res.state !== "READY") {
        return {
            ok: false,
            state: res.state,
            reason: res.reason,
            usage: {
                provider: PROVIDER,
                operation: "TRANSCRIBE_AUDIO",
                unit: "MINUTE",
                units: 0,
                estimatedCostUsdMicros: 0,
            },
        };
    }
    const transcript = res.transcript ?? "";
    const words = res.words ?? [];
    // Build per-speaker segments from contiguous same-speaker runs.
    const speakerSegments = [];
    for (const w of words) {
        const last = speakerSegments[speakerSegments.length - 1];
        if (last && last.speaker === w.speaker) {
            last.endMs = w.endMs;
            last.text = (last.text + " " + w.word).trim();
            last.confidenceSum += w.confidence;
            last.wordCount += 1;
            continue;
        }
        speakerSegments.push({
            speaker: w.speaker,
            startMs: w.startMs,
            endMs: w.endMs,
            text: w.word,
            confidenceSum: w.confidence,
            wordCount: 1,
        });
    }
    const records = [];
    // One TRANSCRIPT_SEGMENT row per speaker segment, bounded label.
    for (const seg of speakerSegments) {
        const meanConf = seg.wordCount > 0 ? seg.confidenceSum / seg.wordCount : 0;
        const anchor = {
            startMs: seg.startMs,
            endMs: seg.endMs,
            speaker: seg.speaker,
        };
        records.push({
            kind: "TRANSCRIPT_SEGMENT",
            modality: "AUDIO",
            providerConfidence: meanConf,
            providerConfidenceBand: classifyIntelligenceConfidence(meanConf),
            label: maskTranscriptLabel(seg.text),
            anchor,
            payload: {
                wordCount: seg.wordCount,
                text: seg.text.slice(0, 4000),
                speaker: seg.speaker,
            },
            providerRecordKey: hashKey([PROVIDER, "TRANSCRIPT_SEGMENT", String(seg.startMs), String(seg.endMs), String(seg.speaker ?? "")]),
        });
        // Bounded SPEAKER_SEGMENT mirror for the speaker-intelligence
        // queue.
        records.push({
            kind: "SPEAKER_SEGMENT",
            modality: "AUDIO",
            providerConfidence: meanConf,
            providerConfidenceBand: classifyIntelligenceConfidence(meanConf),
            label: seg.speaker === null
                ? "speaker_unknown"
                : `speaker_${seg.speaker}`,
            anchor,
            payload: { speaker: seg.speaker, wordCount: seg.wordCount },
            providerRecordKey: hashKey([PROVIDER, "SPEAKER_SEGMENT", String(seg.startMs), String(seg.endMs), String(seg.speaker ?? "")]),
        });
    }
    // Bounded usage — bill in audio minutes (ceiling).
    const durationMs = words.length > 0 ? words[words.length - 1].endMs : 0;
    const minutes = Math.max(0.25, Math.ceil(durationMs / 60000));
    return {
        ok: true,
        records,
        entities: [],
        extractedText: transcript,
        usage: {
            provider: PROVIDER,
            operation: "TRANSCRIBE_AUDIO",
            unit: "MINUTE",
            units: minutes,
            estimatedCostUsdMicros: Math.round(minutes * COST_PER_MINUTE_USD_MICROS),
        },
    };
}
function maskTranscriptLabel(text) {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length <= 60)
        return t.slice(0, 80);
    return `${t.slice(0, 60)}…`.slice(0, 80);
}
function hashKey(parts) {
    return createHash("sha256")
        .update(parts.join("|"), "utf8")
        .digest("hex")
        .slice(0, 64);
}
