/**
 * PROOVRA Phase 3A Closure — Deepgram transcription client wrapper.
 *
 * Real `@deepgram/sdk` integration. Transcribes operator-supplied
 * audio bytes (or a URL) and maps word-level timings into bounded
 * `AUDIO_RANGE_MS` candidates whenever the transcript text trips
 * the REGEX_PII catalog.
 *
 * Hard rules:
 *   * Bounded probe — READY only when `DEEPGRAM_API_KEY` is bound.
 *   * NEVER logs the raw transcript or raw audio bytes.
 *   * Bounded preview labels — masked to first/last chars.
 *   * Sentry capture on UNEXPECTED errors; quota / auth mapped to
 *     bounded provider states.
 */

import { createClient, type DeepgramClient } from "@deepgram/sdk";

import type {
  RedactionConfidenceBand,
  RedactionDetectionKind,
  RedactionDetectionProviderState,
  RedactionMethod,
  RedactionRegionKind,
} from "@proovra/shared";
import { classifyConfidence } from "@proovra/shared";

import { getSecret } from "../../../config/runtime-secrets.js";
import { captureException } from "../../../observability/sentry.js";

// ---------------------------------------------------------------------------
// Bounded probe + types
// ---------------------------------------------------------------------------

export type DeepgramProbe = {
  state: RedactionDetectionProviderState;
  reason: string | null;
};

export type DeepgramDetectionRow = {
  kind: RedactionDetectionKind;
  rawConfidence: number;
  confidenceBand: RedactionConfidenceBand;
  suggestedRegionKind: RedactionRegionKind;
  suggestedRegionGeometry: Record<string, unknown>;
  suggestedMethod: RedactionMethod;
  previewLabel: string | null;
};

export type DeepgramRunResult = {
  state: RedactionDetectionProviderState;
  reason: string | null;
  rows: DeepgramDetectionRow[];
  /** Bounded full transcript text — orchestrator may persist via existing
   * transcript-foundations service. NEVER persisted by this wrapper. */
  transcript: string | null;
  /** Bounded word-level timings the orchestrator can map onto regions. */
  words: ReadonlyArray<DeepgramWord> | null;
};

export type DeepgramWord = {
  word: string;
  startMs: number;
  endMs: number;
  confidence: number;
  speaker: number | null;
};

export type DeepgramTranscribeInput = {
  audioBytes: Uint8Array | null;
  /** Bounded URL when bytes are not supplied inline. */
  audioUrl?: string | null;
  /** Mime type for byte uploads. Defaults to audio/mpeg. */
  contentType?: string;
};

// ---------------------------------------------------------------------------
// Lazy client construction
// ---------------------------------------------------------------------------

let cachedClient: DeepgramClient | null = null;

function resolveKey(): string | null {
  const fromSecret = getSecret("DEEPGRAM_API_KEY");
  if (fromSecret) return fromSecret;
  const fromEnv = (process.env.DEEPGRAM_API_KEY ?? "").trim();
  return fromEnv.length > 0 ? fromEnv : null;
}

export function probeDeepgram(): DeepgramProbe {
  const key = resolveKey();
  if (!key) {
    return {
      state: "NOT_CONFIGURED",
      reason: "DEEPGRAM_API_KEY is not bound",
    };
  }
  return { state: "READY", reason: null };
}

function buildClient(): DeepgramClient | null {
  const probe = probeDeepgram();
  if (probe.state !== "READY") return null;
  if (cachedClient) return cachedClient;
  const key = resolveKey();
  if (!key) return null;
  cachedClient = createClient(key);
  return cachedClient;
}

// ---------------------------------------------------------------------------
// REGEX catalog (subset — bounded for transcript scanning)
// ---------------------------------------------------------------------------

type TranscriptPattern = {
  kind: RedactionDetectionKind;
  rx: RegExp;
  rawConfidence: number;
  label: string;
};

const TRANSCRIPT_PATTERNS: ReadonlyArray<TranscriptPattern> = [
  {
    kind: "EMAIL",
    rx: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g,
    rawConfidence: 0.95,
    label: "email_spoken",
  },
  {
    kind: "PHONE",
    rx: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
    rawConfidence: 0.8,
    label: "phone_spoken",
  },
  {
    kind: "CREDIT_CARD",
    rx: /\b(?:\d{4}[ -]?){3}\d{1,4}\b/g,
    rawConfidence: 0.75,
    label: "credit_card_spoken",
  },
  {
    kind: "NATIONAL_INSURANCE",
    rx: /\b(?:\d{3}-\d{2}-\d{4}|[A-Z]{2}\d{6}[A-Z])\b/g,
    rawConfidence: 0.9,
    label: "government_id_spoken",
  },
];

// ---------------------------------------------------------------------------
// transcribe
// ---------------------------------------------------------------------------

/**
 * Transcribe audio + emit bounded detection candidates for any
 * REGEX_PII hit in the transcript. Regions are bounded by the
 * word-level millisecond timings Deepgram supplies; if a regex
 * spans multiple words the candidate covers the union of their
 * `startMs..endMs` ranges.
 *
 * The wrapper returns both:
 *   * `rows` — redaction candidates the orchestrator persists.
 *   * `transcript` — bounded full text the orchestrator may also
 *     hand to the existing `recordTranscriptSegment` foundation to
 *     populate the search index.
 */
export async function transcribeAndScan(
  input: DeepgramTranscribeInput,
  client: DeepgramClient | null = buildClient(),
): Promise<DeepgramRunResult> {
  if (!client) {
    return {
      state: "NOT_CONFIGURED",
      reason: probeDeepgram().reason,
      rows: [],
      transcript: null,
      words: null,
    };
  }
  if ((!input.audioBytes || input.audioBytes.length === 0) && !input.audioUrl) {
    return {
      state: "NOT_CONFIGURED",
      reason: "deepgram_transcribe_requires_audio_bytes_or_url",
      rows: [],
      transcript: null,
      words: null,
    };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdk = client.listen.prerecorded as unknown as {
      transcribeFile: (
        source: Uint8Array,
        opts: Record<string, unknown>,
      ) => Promise<{ result: unknown; error: unknown }>;
      transcribeUrl: (
        source: { url: string },
        opts: Record<string, unknown>,
      ) => Promise<{ result: unknown; error: unknown }>;
    };
    const transcribeOptions = {
      model: "nova-2",
      smart_format: true,
      punctuate: true,
      diarize: true,
      utterances: false,
    };
    const out = input.audioBytes
      ? await sdk.transcribeFile(input.audioBytes, transcribeOptions)
      : await sdk.transcribeUrl(
          { url: input.audioUrl as string },
          transcribeOptions,
        );
    if (out.error) {
      return mapException("transcribe", out.error);
    }
    const result = out.result as {
      results?: {
        channels?: ReadonlyArray<{
          alternatives?: ReadonlyArray<{
            transcript?: string;
            confidence?: number;
            words?: ReadonlyArray<{
              word?: string;
              start?: number;
              end?: number;
              confidence?: number;
              speaker?: number;
              punctuated_word?: string;
            }>;
          }>;
        }>;
      };
    };
    const alt = result.results?.channels?.[0]?.alternatives?.[0];
    const transcript = alt?.transcript ?? "";
    const words: DeepgramWord[] = (alt?.words ?? []).map((w) => ({
      word: (w.punctuated_word ?? w.word ?? "").trim(),
      startMs: Math.max(0, Math.round((w.start ?? 0) * 1000)),
      endMs: Math.max(0, Math.round((w.end ?? 0) * 1000)),
      confidence: Number.isFinite(w.confidence) ? (w.confidence as number) : 0,
      speaker: typeof w.speaker === "number" ? w.speaker : null,
    }));
    const rows = scanTranscriptForCandidates(transcript, words);
    return { state: "READY", reason: null, rows, transcript, words };
  } catch (err) {
    return mapException("transcribe", err);
  }
}

// ---------------------------------------------------------------------------
// Internal — transcript scanner
// ---------------------------------------------------------------------------

/**
 * For each REGEX_PII hit on the transcript, map the character
 * range back to the union of word timings that produced it. Pure;
 * exported so tests can prove the mapping independently.
 */
export function scanTranscriptForCandidates(
  transcript: string,
  words: ReadonlyArray<DeepgramWord>,
): DeepgramDetectionRow[] {
  if (!transcript || transcript.length === 0) return [];
  // Build an index: char-offset → word index. We re-assemble the
  // transcript by joining words with a single space so the offsets
  // are deterministic against the bounded word list.
  const charToWord: number[] = [];
  const reassembled: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].word;
    if (i > 0) {
      charToWord.push(i); // the inserted space gets attributed to word i.
      reassembled.push(" ");
    }
    for (let k = 0; k < w.length; k++) {
      charToWord.push(i);
    }
    reassembled.push(w);
  }
  const corpus = reassembled.join("");
  if (corpus.length === 0) return [];

  const rows: DeepgramDetectionRow[] = [];
  for (const pattern of TRANSCRIPT_PATTERNS) {
    const rx = new RegExp(pattern.rx.source, pattern.rx.flags.replace("g", "") + "g");
    let m: RegExpExecArray | null;
    while ((m = rx.exec(corpus)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (end > charToWord.length) break;
      const startWordIdx = charToWord[start] ?? 0;
      const endWordIdx = charToWord[Math.min(end - 1, charToWord.length - 1)] ?? startWordIdx;
      const startMs = words[startWordIdx]?.startMs ?? 0;
      const endMs = words[endWordIdx]?.endMs ?? startMs + 1;
      rows.push({
        kind: pattern.kind,
        rawConfidence: pattern.rawConfidence,
        confidenceBand: classifyConfidence(pattern.rawConfidence),
        suggestedRegionKind: "AUDIO_RANGE_MS",
        suggestedRegionGeometry: { startMs, endMs },
        suggestedMethod: "MUTE",
        previewLabel: maskTranscriptPreview(pattern.label, m[0]),
      });
    }
  }
  return rows;
}

function maskTranscriptPreview(label: string, value: string): string {
  const t = value.trim();
  if (t.length <= 4) return label;
  if (t.includes("@")) {
    const at = t.indexOf("@");
    return `${label} *…${t.slice(at)}`.slice(0, 80);
  }
  return `${label} ${t[0]}***${t[t.length - 1]}`.slice(0, 80);
}

function mapException(operation: string, err: unknown): DeepgramRunResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (/quota|rate|429|TooManyRequests/i.test(msg)) {
    return {
      state: "RATE_LIMITED",
      reason: `deepgram_${operation}_rate_limited`,
      rows: [],
      transcript: null,
      words: null,
    };
  }
  if (/401|403|Unauthorized|Forbidden|invalid_credentials/i.test(msg)) {
    return {
      state: "NOT_CONFIGURED",
      reason: `deepgram_${operation}_credentials_rejected`,
      rows: [],
      transcript: null,
      words: null,
    };
  }
  captureException(err, { operation });
  return {
    state: "ERROR",
    reason: `deepgram_${operation}_unexpected`,
    rows: [],
    transcript: null,
    words: null,
  };
}

// ---------------------------------------------------------------------------
// Test helpers — bounded dependency injection.
// ---------------------------------------------------------------------------

export function __setTestClient(client: DeepgramClient | null): void {
  cachedClient = client;
}
