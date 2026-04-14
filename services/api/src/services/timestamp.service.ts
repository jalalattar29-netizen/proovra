import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function enabled(): boolean {
  return (process.env.TSA_ENABLED ?? "false").toLowerCase() === "true";
}

function timeoutMs(): number {
  const raw = process.env.TSA_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 20000;
  return Number.isFinite(n) && n > 0 ? n : 20000;
}

export type TimestampResult = {
  provider: string;
  url: string;
  serialNumber: string | null;
  genTimeUtc: Date | null;
  tokenBase64: string;
  messageImprint: string;
  hashAlgorithm: string;
  status: "STAMPED" | "FAILED";
  failureReason: string | null;
};

async function mkWorkDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tsa-"));
}

async function cleanup(files: string[]): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      try {
        await fs.rm(f, { force: true, recursive: true });
      } catch {
        // ignore cleanup errors
      }
    })
  );
}

function parseOpenSslReplyText(text: string): {
  serialNumber: string | null;
  genTimeUtc: Date | null;
} {
  const serialMatch = text.match(/Serial number:\s*([^\r\n]+)/i);
  const timeMatch = text.match(/Time stamp:\s*([^\r\n]+)/i);

  const serialNumber = serialMatch?.[1]?.trim() ?? null;

  let genTimeUtc: Date | null = null;
  if (timeMatch?.[1]) {
    const parsed = new Date(timeMatch[1].trim());
    if (!Number.isNaN(parsed.getTime())) {
      genTimeUtc = parsed;
    }
  }

  return { serialNumber, genTimeUtc };
}

export async function createEvidenceTimestamp(params: {
  digestHex: string;
}): Promise<TimestampResult | null> {
  if (!enabled()) return null;

  const tsaUrl = must("TSA_URL");
  const tsaUsername = must("TSA_USERNAME");
  const tsaPassword = must("TSA_PASSWORD");
  const provider = optional("TSA_PROVIDER") ?? "UNSPECIFIED_TSA";
  const hashAlgorithm = optional("TSA_HASH_ALGORITHM") ?? "sha256";

  const digestHex = params.digestHex.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digestHex)) {
    throw new Error("createEvidenceTimestamp: digestHex must be a sha256 hex string");
  }

  const workDir = await mkWorkDir();
  const requestFile = path.join(workDir, "request.tsq");
  const responseFile = path.join(workDir, "response.tsr");

  try {
    await execFileAsync(
      "openssl",
      [
        "ts",
        "-query",
        "-digest",
        digestHex,
        `-${hashAlgorithm}`,
        "-cert",
        "-out",
        requestFile,
      ],
      { timeout: timeoutMs() }
    );

    await execFileAsync(
      "curl",
      [
        "-sS",
        "--fail",
        "-u",
        `${tsaUsername}:${tsaPassword}`,
        "-H",
        "Content-Type: application/timestamp-query",
        "--data-binary",
        `@${requestFile}`,
        "-o",
        responseFile,
        tsaUrl,
      ],
      { timeout: timeoutMs() }
    );

    const { stdout } = await execFileAsync(
      "openssl",
      ["ts", "-reply", "-in", responseFile, "-text"],
      { timeout: timeoutMs() }
    );

const statusMatch = stdout.match(/Status:\s*(Granted|GrantedWithMods)/i);
const granted = Boolean(statusMatch);

    if (!granted) {
      return {
        provider,
        url: tsaUrl,
        serialNumber: null,
        genTimeUtc: null,
        tokenBase64: "",
        messageImprint: digestHex,
        hashAlgorithm,
        status: "FAILED",
        failureReason: "TSA response was not granted",
      };
    }

    const tokenBuffer = await fs.readFile(responseFile);
    const parsed = parseOpenSslReplyText(stdout);

    return {
      provider,
      url: tsaUrl,
      serialNumber: parsed.serialNumber,
      genTimeUtc: parsed.genTimeUtc,
      tokenBase64: tokenBuffer.toString("base64"),
      messageImprint: digestHex,
      hashAlgorithm,
      status: "STAMPED",
      failureReason: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown TSA error";
    return {
      provider,
      url: tsaUrl,
      serialNumber: null,
      genTimeUtc: null,
      tokenBase64: "",
      messageImprint: digestHex,
      hashAlgorithm,
      status: "FAILED",
      failureReason: reason,
    };
  } finally {
    await cleanup([requestFile, responseFile, workDir]);
  }
}