// AUDIT-ONLY: builds the continuous/iOS probe from the UC-5 suite scaffolding (read, never modified).
const fs = require("fs");
const H = "../../../../../../services/api";
const src = fs.readFileSync("D:/pv-uca/services/api/test/uc5-ios-screen-capture.integration.test.ts", "utf8");
let head = src.slice(0, src.indexOf('  it("seals an iOS broadcast'));
head = head.split('"../src/').join(`"${H}/src/`).split('"./integration-harness.js"').join(`"${H}/test/integration-harness.js"`);
head = head.replace('describe("UC-5 iOS system broadcast — live PostgreSQL 16"', 'describe("UCA probes — continuous/iOS sealing (AUDIT ONLY)"');
const rep = (a, b) => { if (!head.includes(a)) throw new Error("anchor missing: " + a.slice(0, 60)); head = head.replace(a, b); };
rep("orientationTransition?: boolean;\n    } = {},", "orientationTransition?: boolean;\n      device?: Record<string, unknown>;\n      totalDurationMs?: number;\n      uploadOnly?: number;\n      mode?: string;\n    } = {},");
rep('mode: "DIRECT_SCREEN_CAPTURE_IOS",\n      teamId: owner().teamId,', 'mode: opts.mode ?? "DIRECT_SCREEN_CAPTURE_IOS",\n      teamId: owner().teamId,');
rep("for (const i of uploadOrder) {", "for (const i of uploadOrder) {\n      if (opts.uploadOnly !== undefined && i >= opts.uploadOnly) continue;");
rep("for (let i = 0; i < segCount; i++) {\n      if (opts.omitLastSegment", "for (let i = 0; i < (opts.uploadOnly ?? segCount); i++) {\n      if (opts.omitLastSegment");
rep('device: {\n        platform: "ios",', 'device: opts.device ?? {\n        platform: "ios",');
rep("totalDurationMs: segCount * 1000,", "totalDurationMs: opts.totalDurationMs ?? segCount * 1000,");
rep('await uploadAndDeclare(token, evidenceId, sessionId, segCount, Buffer.from(manifestJson, "utf8"), "CONTINUOUS_MANIFEST");\n    return { token, sessionId, evidenceId, manifestJson, manifestPartIndex: segCount };',
  'const manifestPartIndex = opts.uploadOnly ?? segCount;\n    await uploadAndDeclare(token, evidenceId, sessionId, manifestPartIndex, Buffer.from(manifestJson, "utf8"), "CONTINUOUS_MANIFEST");\n    return { token, sessionId, evidenceId, manifestJson, manifestPartIndex };');
fs.writeFileSync("test/uca-continuous-ios.integration.test.ts", head + fs.readFileSync("continuous-ios-body.ts.txt", "utf8"));
console.log("ok");
