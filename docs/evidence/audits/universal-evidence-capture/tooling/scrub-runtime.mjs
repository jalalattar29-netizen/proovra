#!/usr/bin/env node
/**
 * AUDIT-ONLY: redact credentials from runtime evidence before it is committed.
 * Every value redacted here was minted on a disposable loopback stack that no
 * longer exists, but evidence files are shared, so none are kept.
 * Idempotent; prints the number of replacements per file.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), "../runtime");
const RULES = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<jwt-redacted>"],
  // A token a log line truncated to its first segments is still credential material.
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}[A-Za-z0-9_.…-]*/g, "<jwt-redacted>"],
  [/pvs_[A-Za-z0-9_-]{20,}/g, "pvs_<redacted>"],
  [/(X-Amz-(?:Signature|Credential|Security-Token)=)(?!<redacted>)[^&"\s\\]+/g, "$1<redacted>"],
  [/("(?:rawToken|token|secretBase32|otpauthUri|accessToken|access_token|code_verifier|sessionBearer|bearer)"\s*:\s*")(?!<redacted>")[^"]+"/g, '$1<redacted>"'],
  // The same keys inside a stored response-body STRING, where the quotes are escaped.
  [/(\\"(?:rawToken|token|secretBase32|otpauthUri|accessToken|access_token|code_verifier|sessionBearer|bearer)\\"\s*:\s*\\")(?!<redacted>)[^"\\]+/g, "$1<redacted>"],
  [/([?&]secret=)[A-Z2-7]{16,}/g, "$1<redacted>"],
  [/("recoveryCodes"\s*:\s*)\[(?!"<redacted>"\])[^\]]*\]/g, '$1["<redacted>"]'],
  // Escaped form: the replacement keeps the quotes escaped so the stored body stays a valid JSON string.
  [/(\\"recoveryCodes\\"\s*:\s*)\[(?!\\"<redacted>\\"\])[^\]]*\]/g, '$1[\\"<redacted>\\"]'],
  [/(\/v1\/external-intake\/)[A-Za-z0-9_.%-]{16,}/g, "$1<intake-token-redacted>"],
  [/(\/public\/verify\/)(?!pvs_<redacted>)[A-Za-z0-9_-]{40,}/g, "$1<token-redacted>"],
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(json|jsonl|log|txt|md)$/.test(name)) out.push(p);
  }
  return out.sort();
}

let total = 0;
for (const file of walk(RUNTIME)) {
  let s = readFileSync(file, "utf8");
  let n = 0;
  for (const [re, rep] of RULES) s = s.replace(re, (...m) => { n += 1; return rep.replace(/\$1/g, m[1] ?? ""); });
  if (n) {
    writeFileSync(file, s);
    total += n;
    console.log(`${n}\t${file.slice(RUNTIME.length + 1)}`);
  }
}
console.log(`total redactions ${total}`);
