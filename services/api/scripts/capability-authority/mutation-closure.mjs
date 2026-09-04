/**
 * PHASE 13 §B — MUTATION CLOSURE, over the import-resolved call graph.
 *
 * WHAT THIS ANSWERS
 * ---------------------------------------------------------------------------
 * The tenant pass asks "which rows may this caller reach". This asks the
 * question underneath it: WHERE does this system change state, what reaches
 * each of those places, and is the change governed on every path in.
 *
 * A TERMINAL WRITER is the last statement before state actually changes — the
 * Prisma call, the enqueue, the provider request. Everything above it is a
 * wrapper, and a wrapper is exactly what lets one mutation look governed from
 * one entrypoint and be ungoverned from another.
 *
 * WHY IT IS NOT A SECOND SCANNER
 * ---------------------------------------------------------------------------
 * Three authorities already exist and this module CONSUMES them rather than
 * re-deriving them:
 *
 *   - `call-graph.mjs` — the import-resolved graph. A call is followed only
 *     when it resolves to a declaration through the file's own import table;
 *     anything unresolved is RECORDED, which is what lets
 *     `MutationReachabilityUnresolved` be a real number instead of a hopeful
 *     zero.
 *   - `prisma/schema.prisma` — the delegate names. Detection keys on the MODEL
 *     rather than on the receiver's variable name, so an aliased, destructured
 *     or factory-returned client is caught without a name list to maintain.
 *   - `packages/shared/src/queue-integrity/registry.ts` — the canonical work
 *     registry. It already names, per job: the one producer, the one processor,
 *     the worker registration, the terminal writer, the idempotency strategy,
 *     the retry and recovery policy, the reconciler and the external boundary.
 *     Re-deriving those from source would create the second opinion this
 *     repository has spent phases eliminating; this module checks the registry
 *     AGAINST the tree instead.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 * Reachability is STATIC. A writer reachable from a route is not proof that a
 * request reaches it; an unreachable writer is not proof that nothing calls it.
 * Both directions are reported, and the second is counted as unresolved rather
 * than quietly dropped. `mutationClosurePass` stays false while ANY reachable
 * writer is unclassified or ANY required invariant is unmeasured.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { resolveCall, resolveModuleExport, ts, REPO } from "./call-graph.mjs";

// ===========================================================================
// PRISMA DELEGATES — derived from the schema, never hand-listed.
// ===========================================================================

const SCHEMA_PATH = "services/api/prisma/schema.prisma";
const delegateName = (model) => model.charAt(0).toLowerCase() + model.slice(1);

export function deriveDelegates() {
  const text = readFileSync(path.join(REPO, SCHEMA_PATH), "utf8");
  const out = new Set();
  for (const m of text.matchAll(/^model\s+(\w+)\s*\{/gm)) out.add(delegateName(m[1]));
  return out;
}
const DELEGATES = deriveDelegates();

const WRITE_OPS = new Set([
  "create", "createMany", "createManyAndReturn",
  "update", "updateMany", "updateManyAndReturn",
  "upsert", "delete", "deleteMany",
]);
const RAW_OPS = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRaw", "$queryRawUnsafe"]);

/**
 * SQL that CHANGES state. A read-only SELECT is not a mutation.
 *
 * Every keyword requires a following token. The first revision listed bare
 * `GRANT`, and `\bGRANT` matched the TYPE NAME `GrantProbe` in a pure `SELECT`
 * — three read-only queries were reported as raw-SQL mutations with an
 * unresolvable target table. A keyword with nothing after it is a word, not a
 * statement.
 */
const MUTATING_SQL = /\b(INSERT\s+INTO\s|UPDATE\s+(?:ONLY\s+)?["\w]|DELETE\s+FROM\s|CREATE\s+(?:TABLE|INDEX|SCHEMA|EXTENSION|FUNCTION|TRIGGER|TYPE|VIEW|MATERIALIZED)\s|ALTER\s+(?:TABLE|INDEX|TYPE|SCHEMA|SEQUENCE)\s|DROP\s+(?:TABLE|INDEX|TYPE|SCHEMA|VIEW|FUNCTION|TRIGGER)\s|TRUNCATE\s+["\w]|GRANT\s+\w+\s+ON\s|REVOKE\s+\w+\s+ON\s|REFRESH\s+MATERIALIZED\s|SELECT\s+pg_advisory)/i;

/**
 * The SQL text a raw call actually carries — the template literal or string
 * argument, never the whole call expression. Testing the call text let
 * identifiers and TypeScript type arguments masquerade as SQL keywords.
 */
function rawSqlText(call) {
  const parts = [];
  for (const arg of call.arguments ?? []) {
    if (ts.isNoSubstitutionTemplateLiteral(arg) || ts.isStringLiteralLike(arg)) parts.push(arg.text);
    else if (ts.isTemplateExpression(arg)) {
      parts.push(arg.head.text, ...arg.templateSpans.map((s) => s.literal.text));
    }
  }
  // `prisma.$executeRaw\`…\`` is a TAGGED template: the SQL is the tag's
  // template, not an argument.
  if (parts.length === 0 && ts.isTaggedTemplateExpression(call.parent)) {
    const t = call.parent.template;
    if (ts.isNoSubstitutionTemplateLiteral(t)) parts.push(t.text);
    else parts.push(t.head.text, ...t.templateSpans.map((s) => s.literal.text));
  }
  return parts.join(" ");
}

// ===========================================================================
// QUEUE PRODUCERS — the canonical enqueue authority, not `queue.add`.
// ===========================================================================

const ENQUEUE_AUTHORITIES = new Set([
  "enqueueCanonicalWork",
  "enqueueCanonicalJob",
  "enqueueDerivedAssetsJob",
  "scheduleCanonicalWork",
]);

// ===========================================================================
// EXTERNAL SIDE EFFECTS — a call that leaves this process, which is the fact
// that makes ordering against the transaction boundary matter at all.
// ===========================================================================

const EXTERNAL_EFFECTS = Object.freeze([
  { id: "OBJECT_STORAGE", names: ["PutObjectCommand", "CopyObjectCommand", "DeleteObjectCommand", "DeleteObjectsCommand", "CreateMultipartUploadCommand", "CompleteMultipartUploadCommand", "AbortMultipartUploadCommand", "UploadPartCommand", "putObject", "copyObject", "deleteObject"] },
  { id: "EMAIL", names: ["deliverEmail", "sendEmail", "sendMail", "sendTransactionalEmail"] },
  { id: "SMS", names: ["sendSms", "sendSMS", "sendVerificationSms"] },
  { id: "WEBHOOK", names: ["dispatchWebhook", "deliverWebhook", "sendWebhook", "postWebhook", "deliverLifecycleWebhook", "dispatchAutomationWebhook"] },
  { id: "PAYMENT", names: ["createStripeCheckoutSession", "stripeRequest", "paypalPost", "paypalRequest", "createPayPalOrder", "capturePayPalOrder", "createPayPalSubscription", "cancelStripeSubscription"] },
  { id: "PROVISIONING", names: ["provisionScimUser", "deprovisionScimUser", "syncScimGroup", "pushScimGroupMembership"] },
  { id: "SECRET_ROTATION", names: ["rotateSigningKey", "rotateApiKey", "rotateSecret", "rotateScimToken"] },
  { id: "TIMESTAMP_AUTHORITY", names: ["requestTimestampToken", "upgradeTimestamp", "fetchOtsUpgrade"] },
  { id: "AI_PROVIDER", names: ["callOpenAi", "createEmbedding", "createEmbeddings", "runProviderExtraction"] },
]);
const EXTERNAL_BY_NAME = new Map();
for (const e of EXTERNAL_EFFECTS) for (const n of e.names) EXTERNAL_BY_NAME.set(n, e.id);

// ===========================================================================
// THE 14 PRIMARY FAMILIES
//
// Mapped from the TARGET, not from the file a writer happens to live in: a
// service module is moved and renamed, the table it writes is not.
// ===========================================================================

export const MUTATION_FAMILIES = Object.freeze([
  "ACCOUNT_SESSION_SECURITY",
  "ORGANIZATION",
  "ORGANIZATION_MEMBERSHIP",
  "WORKSPACE",
  "WORKSPACE_MEMBERSHIP_INVITATION",
  "CASE",
  "EVIDENCE_CUSTODY_FINALIZATION",
  "LEGAL_HOLD_RETENTION_DELETION",
  "EXTERNAL_REVIEW_INTAKE_SHARE",
  "BILLING_SUBSCRIPTION_SEAT",
  "SSO_OIDC_SCIM_PROVISIONING",
  "AUTOMATION_QUEUE_WEBHOOK",
  "REPORT_EXPORT_REDACTION",
  "API_KEY_SECRET_OPERATIONAL_ADMIN",
]);

/**
 * Ordered rules; FIRST match wins, so a more specific prefix precedes the
 * family it would otherwise fall into. Every rule is a statement about the
 * model name, which is the durable fact.
 */
const FAMILY_RULES = Object.freeze([
  [/^(organizationMembership|organizationInvite|organizationInvitation|departmentMembership|delegatedAdminGrant|memberDelegatedAdminScope)/i, "ORGANIZATION_MEMBERSHIP"],
  [/^(organization|department|orgHealth|organizationalHealth|orgNotification)/i, "ORGANIZATION"],
  [/^(teamMember|teamInvite|teamInvitation|memberCapabilityGrant|collaborationTeamMember|collaborationTeamInvite|collaborationTeamGuest|collaborationTeamNotification|collaborationTeamAccessReview|collaborationTeamAssignment|collaborationTeamComment|collaborationTeamActivity)/i, "WORKSPACE_MEMBERSHIP_INVITATION"],
  [/^(team|workspace|collaborationTeam|enterpriseContract|workspaceStorageAddon)/i, "WORKSPACE"],
  [/^(legalHold|evidenceLegalHold|retentionPolicy|evidenceRetentionPolicy|retentionPolicyConfig|destruction|archiveTier|immutableStorageCheck|evidenceLifecycleEvent|governanceReconciliationRun)/i, "LEGAL_HOLD_RETENTION_DELETION"],
  [/^(evidence|custodyEvent|captureSession|captureDevice|captureTrust|chainTransfer|verificationPackage|videoT|videoF|videoTrack|media|duplicateDecision|device|fileSecurityScan|uploadSession|guestIdentity|embeddings)/i, "EVIDENCE_CUSTODY_FINALIZATION"],
  [/^(case|discussion|investigationGraph|manualRelationship|qcSample|codingS|codingF|codingV|reviewerDisagreement|workflowReviewDecision)/i, "CASE"],
  [/^(externalReview|externalReviewer|reviewAssignment|reviewDecision|reviewEscalation|reviewer|workflowIntake|intakeSession|evidenceRequest|crossOrgReviewGrant|evidenceExchange|contactSalesRequest|demoRequest|enterpriseProvisioningRequest)/i, "EXTERNAL_REVIEW_INTAKE_SHARE"],
  [/^(subscription|payment|entitlement|storageAddon|providerBudget|providerUsage|semanticUsage|aiUsage|aiCopilotRun)/i, "BILLING_SUBSCRIPTION_SEAT"],
  [/^(ssoConnection|scim|externalIdentityMapping|ssoCallbackAttempt)/i, "SSO_OIDC_SCIM_PROVISIONING"],
  [/^(automation|webhook|integrationWebhook|lifecycleWebhook|queueTelemetry|operationalWorkflow|bulkOperationalAction|operationalGraph|operationalCausality|operationalTimeline)/i, "AUTOMATION_QUEUE_WEBHOOK"],
  [/^(report|export|redaction|governanceExport|evidenceIntegritySnapshot|reportGenerationRequest|searchAuditLog|savedSearchView|evidenceSavedView|evidenceSearchDocument|semantic)/i, "REPORT_EXPORT_REDACTION"],
  [/^(apiCredential|apiKey|adminAuditLog|securityEvent|securityClaimCheck|emergencyAccessGrant|supportAccessGrant|operationalIncident|operationalCorrelation|accessAnomaly|riskSignal|governancePolicy|governanceNotification|trustCenter|subprocessor|status|maintenanceWindow|accessReview|signingKey|signerControlState|intelligenceActivityEvent|operationsInboxSnapshot|inboxItemState)/i, "API_KEY_SECRET_OPERATIONAL_ADMIN"],
  [/^(user|authenticatedSession|revokedSession|mfa|stepUpChallenge|trustedDevice|verificationAttempt|emailVerificationToken|passwordReset|accountClosureRequest|accountDataExportRequest|identityLink|communication|notification|analyticsEvent|analyticsSession|cookieConsentRecord|workspaceNotificationPreference|notificationSchedule|workspaceAiPolicy|geoIntelligenceLookup)/i, "ACCOUNT_SESSION_SECURITY"],
  // ---------------------------------------------------------------------
  // Targets the first pass could not place from their prefix alone. Each is
  // named for what it IS, and each was read before it was mapped.
  // ---------------------------------------------------------------------
  /** The provider's own inbound event log, written by the signed webhook. */
  [/^(stripeWebhookEvent|paypalWebhookEvent)$/, "BILLING_SUBSCRIPTION_SEAT"],
  /** The public verification page's view record for a shared package. */
  [/^verificationView$/, "EXTERNAL_REVIEW_INTAKE_SHARE"],
  /** SCIM/SSO-driven membership provisioning grants. */
  [/^membershipGrant$/, "ORGANIZATION_MEMBERSHIP"],
  /** The AI copilot's human-review record over its own observations. */
  [/^aiCopilotObservationReview$/, "BILLING_SUBSCRIPTION_SEAT"],
  /** Worker queue telemetry — an operational snapshot, not product data. */
  [/^workerTelemetrySnapshot$/, "API_KEY_SECRET_OPERATIONAL_ADMIN"],
]);

const EXTERNAL_FAMILY = Object.freeze({
  OBJECT_STORAGE: "EVIDENCE_CUSTODY_FINALIZATION",
  EMAIL: "ACCOUNT_SESSION_SECURITY",
  SMS: "ACCOUNT_SESSION_SECURITY",
  WEBHOOK: "AUTOMATION_QUEUE_WEBHOOK",
  PAYMENT: "BILLING_SUBSCRIPTION_SEAT",
  PROVISIONING: "SSO_OIDC_SCIM_PROVISIONING",
  SECRET_ROTATION: "API_KEY_SECRET_OPERATIONAL_ADMIN",
  TIMESTAMP_AUTHORITY: "EVIDENCE_CUSTODY_FINALIZATION",
  AI_PROVIDER: "REPORT_EXPORT_REDACTION",
});

/**
 * Raw SQL names a TABLE, not a Prisma delegate. The table is snake_case; the
 * family rules speak camelCase, so the table is converted before matching —
 * which is why `evidence_legal_holds` lands in the retention family rather
 * than being reported as unclassifiable.
 */
const camel = (snake) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export function classifyMutationFamily(writer) {
  if (writer.kind === "QUEUE") return "AUTOMATION_QUEUE_WEBHOOK";
  if (writer.kind === "EXTERNAL") return EXTERNAL_FAMILY[writer.target] ?? null;
  const name = writer.kind === "RAW_SQL" ? camel(writer.target) : writer.target;
  for (const [re, fam] of FAMILY_RULES) if (re.test(name)) return fam;
  return null;
}

// ===========================================================================
// DISCOVERY
// ===========================================================================

/** The table a mutating SQL statement targets, or null. */
function rawSqlTarget(text) {
  const m =
    /\bINSERT\s+INTO\s+"?(\w+)"?/i.exec(text) ??
    /\bUPDATE\s+(?:ONLY\s+)?"?(\w+)"?/i.exec(text) ??
    /\bDELETE\s+FROM\s+"?(\w+)"?/i.exec(text) ??
    /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|MATERIALIZED\s+VIEW|VIEW)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?(\w+)"?/i.exec(text) ??
    /\bTRUNCATE\s+(?:TABLE\s+)?"?(\w+)"?/i.exec(text);
  return m ? m[1] : null;
}

/** The terminal writer at `node`, or null. */
export function terminalWriterAt(node, fileText) {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && EXTERNAL_BY_NAME.has(node.expression.text)) {
    return { kind: "EXTERNAL", target: EXTERNAL_BY_NAME.get(node.expression.text), op: node.expression.text };
  }
  if (!ts.isCallExpression(node)) return null;
  const exp = node.expression;

  // A canonical enqueue — the ONE producer authority in this tree.
  if (ts.isIdentifier(exp) && ENQUEUE_AUTHORITIES.has(exp.text)) {
    return { kind: "QUEUE", target: workNameArg(node, fileText) ?? "UNRESOLVED_WORK_NAME", op: exp.text };
  }
  if (ts.isIdentifier(exp) && EXTERNAL_BY_NAME.has(exp.text)) {
    return { kind: "EXTERNAL", target: EXTERNAL_BY_NAME.get(exp.text), op: exp.text };
  }

  if (!ts.isPropertyAccessExpression(exp)) return null;
  const op = exp.name.text;

  // `prisma.$executeRaw`… — mutation only when the SQL actually changes state.
  if (RAW_OPS.has(op)) {
    const sql = rawSqlText(node);
    if (!MUTATING_SQL.test(sql)) return null;
    return { kind: "RAW_SQL", target: rawSqlTarget(sql) ?? "UNRESOLVED_TABLE", op };
  }

  if (!WRITE_OPS.has(op)) {
    if (EXTERNAL_BY_NAME.has(op)) {
      return { kind: "EXTERNAL", target: EXTERNAL_BY_NAME.get(op), op };
    }
    return null;
  }

  const recv = exp.expression;
  // `<anything>.<model>.<writeOp>()` — keyed on the MODEL, so an aliased,
  // re-exported, factory-returned or transaction-delegate client is caught
  // without a receiver-name allowlist to keep in sync.
  if (ts.isPropertyAccessExpression(recv) && DELEGATES.has(recv.name.text)) {
    return { kind: "DATABASE", target: recv.name.text, op };
  }
  // `<model>.<writeOp>()` — a DESTRUCTURED delegate. Accepted only when the
  // file visibly binds that name from a client, so an unrelated object with an
  // `update` method is not counted as a database write.
  if (ts.isIdentifier(recv) && DELEGATES.has(recv.text)) {
    const bound = new RegExp(`(?:const|let)\\s*\\{[^}]*\\b${recv.text}\\b[^}]*\\}\\s*=\\s*(?:await\\s+)?\\w*(?:prisma|tx|db|client)`, "i");
    if (bound.test(fileText)) return { kind: "DATABASE", target: recv.text, op };
  }
  return null;
}

/**
 * The work name passed to a canonical enqueue.
 *
 * `workName` and `jobName` name it directly. `entry` carries a whole registry
 * entry, usually as a module-level constant — reading the CONSTANT'S NAME
 * produced a producer called `REGISTRY_ENTRY`, which then reported itself as an
 * orphan because no such work exists. When `entry` is an identifier the name is
 * recovered from the enclosing file: the `getWorkEntryOrThrow(JOB_NAMES.X)`
 * that built it.
 */
function workNameArg(call, fileText) {
  const arg = call.arguments?.[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  let entryIdent = null;
  for (const prop of arg.properties) {
    const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null;
    if (key !== "workName" && key !== "entry" && key !== "jobName") continue;
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (key === "entry") entryIdent = prop.name.text;
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    const v = prop.initializer;
    if (ts.isStringLiteralLike(v)) return v.text;
    if (ts.isPropertyAccessExpression(v)) return v.name.text; // JOB_NAMES.GENERATE_REPORT
    if (ts.isIdentifier(v)) {
      if (key === "entry") entryIdent = v.text;
      else return v.text;
    }
  }
  if (entryIdent) {
    const m = new RegExp(
      `${entryIdent}\\s*(?::[^=]*)?=\\s*(?:await\\s+)?getWorkEntry(?:OrThrow)?\\(\\s*(?:JOB_NAMES\\.)?([A-Z_]+)`,
    ).exec(fileText);
    if (m) return m[1];
  }
  return null;
}

/** True when `node` sits inside a `$transaction(...)` callback. */
function insideTransaction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      cur.expression.name.text === "$transaction"
    ) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Every terminal writer in the followable trees.
 *
 * The id is `file#target.op@line` rather than a counter, so a writer keeps its
 * identity across runs and a diff of two inventories is readable.
 */
export function discoverMutationTerminals(cg) {
  const writers = new Map();
  const fileTextCache = new Map();
  for (const [file, entry] of cg.graph) {
    const sf = entry.sf;
    const text = sf.getFullText();
    fileTextCache.set(file, text);
    /**
     * The declaration a writer sits inside — the unit that is reached, wired,
     * preserved or removed.
     *
     * A line number names a statement; a disposition is only ever decided
     * about a FUNCTION. Without this on the row, every question about an
     * unreached writer ("what would we delete", "what does the preservation
     * manifest key on") needed a separate probe over the same graph, and a
     * throwaway probe is exactly the second authority this programme refuses.
     */
    const declRanges = [...entry.decls].map(([name, node]) => ({
      name,
      start: node.getStart(sf),
      end: node.getEnd(),
    }));
    const enclosingDeclOf = (pos) => {
      let best = null;
      for (const d of declRanges) {
        if (pos >= d.start && pos <= d.end && (!best || d.end - d.start < best.end - best.start)) {
          best = d;
        }
      }
      return best?.name ?? null;
    };
    const visit = (n) => {
      const w = terminalWriterAt(n, text);
      if (w !== null) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        const id = `${file}#${w.target}.${w.op}@${line + 1}`;
        if (!writers.has(id)) {
          writers.set(id, {
            writerId: id,
            terminalLocation: `${file}:${line + 1}`,
            file,
            enclosingDeclaration: enclosingDeclOf(n.getStart(sf)),
            kind: w.kind,
            target: w.target,
            mutationKind: w.op,
            primaryFamily: classifyMutationFamily(w),
            insideTransaction: insideTransaction(n),
            entryRoutes: [],
            entryJobs: [],
            entryModules: [],
        entrySchedules: [],
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return writers;
}

// ===========================================================================
// REACHABILITY
// ===========================================================================

/**
 * Direct facts for ONE function body: the writers it performs itself, the
 * declarations it calls, and the calls that could not be resolved.
 *
 * "Itself" means not descending into nested function DECLARATIONS that are
 * separately indexed — an inline arrow passed as a callback IS part of this
 * body and is walked, which is how a `$transaction(async (tx) => …)` block's
 * writes stay attributed to the function that opened it.
 */
/** Names destructured from `const { a, b } = await import("…")`, if readable. */
function dynamicImportBindings(callNode) {
  let cur = callNode.parent;
  if (cur && ts.isAwaitExpression(cur)) cur = cur.parent;

  // `const { x, y } = await import("…")` — a declaration.
  if (cur && ts.isVariableDeclaration(cur) && ts.isObjectBindingPattern(cur.name)) {
    return cur.name.elements
      .map((el) => (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null))
      .filter(Boolean);
  }

  /**
   * `({ x, y } = await import("…"))` — an ASSIGNMENT to names declared above.
   *
   * The media-intelligence processor hoists `let markRunProcessing: typeof
   * import(…)["markRunProcessing"]` so the binding is typed and reusable across
   * two code paths, then fills it in this form. Only the declaration form was
   * recognised, so the destructured names came back empty, the whole module was
   * followed instead of the members taken, and the run-tracker's own writers —
   * every PROCESSING claim, COMPLETED and FAILED transition on a media
   * intelligence run — were reported DEAD_UNREACHABLE.
   */
  if (cur && ts.isParenthesizedExpression(cur)) cur = cur.parent;
  if (
    cur &&
    ts.isBinaryExpression(cur) &&
    cur.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isObjectLiteralExpression(cur.left)
  ) {
    const names = [];
    for (const p of cur.left.properties) {
      if (ts.isShorthandPropertyAssignment(p)) names.push(p.name.text);
      else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) names.push(p.name.text);
    }
    return names;
  }
  return [];
}

function directFacts(node, file, cg, writers, sf, text) {
  const direct = new Set();
  const callees = new Set();
  const unresolved = [];
  const visit = (n) => {
    const w = terminalWriterAt(n, text);
    if (w !== null) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      const id = `${file}#${w.target}.${w.op}@${line + 1}`;
      if (writers.has(id)) direct.add(id);
    }
    if (ts.isCallExpression(n)) {
      const r = resolveCall(n, file, cg);
      if (r.module === true) {
        // `const { assignWorkflow } = await import("…")`. The module resolved;
        // the members TAKEN are read from the destructuring, so only what the
        // caller actually binds is followed. Without a readable pattern the
        // whole module is followed, which over-approximates rather than
        // silently dropping the edge.
        const names = dynamicImportBindings(n);
        const target = cg.graph.get(r.file);
        if (target) {
          if (names.length > 0) {
            for (const nm of names) {
              // The imported module is usually a BARREL: the name is
              // re-exported, not declared there. Resolve it to the module that
              // actually implements it, exactly as a static import would.
              const impl = resolveModuleExport(cg, r.file, nm);
              callees.add(impl ? `${impl.file}#${impl.name}` : `${r.file}#${nm}`);
            }
          } else {
            for (const nm of target.decls.keys()) callees.add(`${r.file}#${nm}`);
          }
        }
      } else if (r.ok) {
        callees.add(`${r.file}#${r.name}`);
        // A descriptor-table row that names an IMPORTED function resolves to a
        // declaration in another file, so it cannot be expressed as an `@alt`
        // key in this one. Every resolved row is followed.
        if (Array.isArray(r.targets)) {
          for (const t of r.targets) callees.add(`${t.file}#${t.name}`);
        }
        // A descriptor-table binding may name SEVERAL functions — one per row.
        // Following only the first would attribute the writers of one leg to
        // every route in the table and miss the others entirely.
        if (Array.isArray(r.alternates)) {
          for (let i = 0; i < r.alternates.length; i += 1) {
            callees.add(`${r.file}#${r.name}@alt${i}`);
          }
        }
      } else if (r.name) unresolved.push({ file, name: r.name, reason: r.reason });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { direct, callees, unresolved };
}

/**
 * Reachability as a FIXPOINT over the declaration graph, computed ONCE.
 *
 * The first revision ran a depth-bounded DFS per entrypoint — roughly 800
 * traversals, each capped at depth 8 and 600 functions. The caps were reached
 * constantly, and the visible consequence was 103 writers reported
 * DEAD_UNREACHABLE while sitting in `org-lifecycle.service.ts` and
 * `workflow.service.ts`, which organization routes plainly reach. A budget
 * exhaustion reported as "nothing calls this" is precisely the reassuring lie
 * this module exists to prevent.
 *
 * Every declaration's direct facts are computed once; the transitive closure is
 * then propagated to a fixpoint with no depth bound at all, and entrypoints are
 * mapped through it. Cycles terminate because the sets only grow.
 */
export function buildReachability(cg, writers) {
  /** @type {Map<string, {direct:Set<string>, callees:Set<string>}>} */
  const decls = new Map();
  const unresolvedByReason = new Map();
  const noteUnresolved = (u) => {
    const key = u.reason;
    if (!unresolvedByReason.has(key)) unresolvedByReason.set(key, new Set());
    unresolvedByReason.get(key).add(`${u.file}: ${u.name}`);
  };

  for (const [file, entry] of cg.graph) {
    const sf = entry.sf;
    const text = sf.getFullText();
    for (const [name, node] of entry.decls) {
      const f = directFacts(node, file, cg, writers, sf, text);
      decls.set(`${file}#${name}`, { direct: f.direct, callees: f.callees });
      for (const u of f.unresolved) noteUnresolved(u);
    }
  }

  // Fixpoint: a declaration reaches whatever it writes plus whatever its
  // callees reach. Iterate until nothing grows.
  const reach = new Map();
  for (const [k, v] of decls) reach.set(k, new Set(v.direct));
  let changed = true;
  let rounds = 0;
  while (changed) {
    changed = false;
    rounds += 1;
    for (const [k, v] of decls) {
      const mine = reach.get(k);
      for (const callee of v.callees) {
        const theirs = reach.get(callee);
        if (!theirs) continue;
        for (const id of theirs) {
          if (!mine.has(id)) {
            mine.add(id);
            changed = true;
          }
        }
      }
    }
    // A safety bound far above any real call depth; reported if it ever binds
    // rather than silently truncating the answer.
    if (rounds > 60) break;
  }

  return { decls, reach, rounds, unresolvedByReason };
}

/**
 * Attach entry routes and entry jobs to every writer, through the fixpoint.
 *
 * @param entrypoints Array<{ kind: "ROUTE"|"JOB", id, node, file }>
 */
export function resolveMutationEntrypoints(cg, writers, entrypoints) {
  const { reach, rounds, unresolvedByReason } = buildReachability(cg, writers);

  for (const ep of entrypoints) {
    if (!ep.node) continue;
    const entry = cg.graph.get(ep.file);
    if (!entry) continue;
    const sf = entry.sf;
    const f = directFacts(ep.node, ep.file, cg, writers, sf, sf.getFullText());
    const reached = new Set(f.direct);
    for (const callee of f.callees) {
      const theirs = reach.get(callee);
      if (theirs) for (const id of theirs) reached.add(id);
    }
    for (const id of reached) {
      const w = writers.get(id);
      if (!w) continue;
      if (ep.kind === "ROUTE") w.entryRoutes.push(ep.id);
      else if (ep.kind === "MODULE") w.entryModules.push(ep.id);
      else if (ep.kind === "SCHEDULE") w.entrySchedules.push(ep.id);
      else w.entryJobs.push(ep.id);
    }
  }

  for (const w of writers.values()) {
    w.entryRoutes = [...new Set(w.entryRoutes)].sort();
    w.entryJobs = [...new Set(w.entryJobs)].sort();
    w.entryModules = [...new Set(w.entryModules ?? [])].sort();
    w.entrySchedules = [...new Set(w.entrySchedules ?? [])].sort();
  }

  /**
   * UNRESOLVED CALLS, SPLIT BY REASON — because they are not one fact.
   *
   * `METHOD_ON_VALUE` is `x.y()` on a local value: overwhelmingly a library or
   * builtin method, and following it by global name is exactly the defect
   * `call-graph.mjs` was written to avoid. `IMPORTED_BUT_NOT_FOUND` is the real
   * gap — an import this repository owns whose export could not be located —
   * and that is the number a closure gate may key on. Reporting the sum as one
   * count (6,789 on the first run) told nobody anything.
   */
  const byReason = {};
  for (const [reason, set] of unresolvedByReason) byReason[reason] = set.size;
  const projectGaps = [...(unresolvedByReason.get("IMPORTED_BUT_NOT_FOUND") ?? [])];

  return {
    fixpointRounds: rounds,
    unresolvedByReason: byReason,
    projectGaps,
  };
}

// ===========================================================================
// NON-REQUEST DISPOSITIONS
//
// A writer with no route and no job is not automatically a defect. Some are
// operator entrypoints, some run at boot, some exist only for migrations or
// tests. Each is named from the FILE's role, and anything left over is
// DEAD_UNREACHABLE_WRITER — reported, never silently excluded.
// ===========================================================================

export const NON_REQUEST_DISPOSITIONS = Object.freeze([
  "REGISTERED_CLI", "MIGRATION_ONLY", "TEST_ONLY", "BUILD_ONLY",
  "STARTUP_TASK", "RECONCILER_OR_SWEEP", "SEED",
  // A writer reached ONLY through a port the host injects into a shared
  // executor. See PORT_ATTRIBUTED_REACHABLE below for why this is a real
  // attribution and not an exemption.
  "INJECTED_PORT_IMPLEMENTATION",
  "PRESERVED_PLANNED_WRITER", "DEAD_UNREACHABLE_WRITER",
]);

export function dispositionUnreached(file) {
  if (/(^|\/)(scripts|commands)\//.test(file)) return "REGISTERED_CLI";
  if (/(^|\/)prisma\//.test(file)) return "MIGRATION_ONLY";
  if (/\.(test|spec)\.tsx?$/.test(file) || /(^|\/)(test|tests|__tests__)\//.test(file)) return "TEST_ONLY";
  if (/seed/i.test(file)) return "SEED";
  if (/(reconcil|sweep|cleanup|expiry|retention-engine)/i.test(file)) return "RECONCILER_OR_SWEEP";
  if (/(^|\/)(bootstrap|startup|index)\.ts$/.test(file)) return "STARTUP_TASK";
  return "DEAD_UNREACHABLE_WRITER";
}

// ===========================================================================
// INVARIANTS
// ===========================================================================

/**
 * Per-writer invariants, derived from facts the engine already holds.
 *
 * `routeFacts` is the capability map's per-route projection, so authorization
 * and tenant binding are READ from the pass that measured them rather than
 * re-decided here. A writer inherits the WEAKEST of its entry routes: a
 * mutation governed on one path and ungoverned on another is ungoverned.
 */
export function deriveMutationInvariants(writer, routeFactsById, workRegistryByProducerFile) {
  const routes = writer.entryRoutes.map((id) => routeFactsById.get(id)).filter(Boolean);

  const authorityOf = (r) => r.tenantIdSource ?? "UNRESOLVED";

  /**
   * WHAT MAY AUTHORIZE A MUTATION, AND FOR WHICH SCOPE.
   *
   * `AUTHENTICATED_SUBJECT` is the verdict "every access this route makes
   * carried a SELF predicate". That is a complete authorization decision for
   * account-owned data and nothing else. It must never be accepted as the
   * authority for a mutation of workspace- or organization-owned rows: "I am
   * signed in" answers who is asking, not which tenant they may write to.
   *
   * So the check is now scope-aware. A self-bound authority satisfies only a
   * `GLOBAL_USER_SELF` / `PUBLIC_DATA` / `NO_DATA_ACCESS` route; a
   * tenant-scoped route needs a terminal tenant authority — the canonical
   * evaluator, a membership lookup, a resource-owner column, the organization
   * evaluator, platform-admin scope, or a credential that carries the tenant
   * (bearer token / machine secret).
   *
   * `UNRESOLVED` remains ungoverned in every scope.
   */
  const SELF_ONLY_AUTHORITIES = new Set(["AUTHENTICATED_SUBJECT", "NONE"]);
  const TENANT_SCOPES = new Set([
    "WORKSPACE_SCOPED",
    "ORGANIZATION_SCOPED",
    "WORKSPACE_AND_ORGANIZATION",
    "MULTI_TENANT_PLATFORM_ADMIN",
  ]);

  const ungovernedRoutes = routes
    .filter((r) => {
      const a = authorityOf(r);
      if (a === "UNRESOLVED") return true;
      // A self-only authority on a TENANT-scoped route is the defect this
      // clause exists for.
      return SELF_ONLY_AUTHORITIES.has(a) && TENANT_SCOPES.has(r.dataScope);
    })
    .map((r) => r.routeId);

  /** Reported, never counted as a defect: the authority mix behind this writer. */
  const authorityMix = [...new Set(routes.map(authorityOf))].sort();

  const tenantUnboundRoutes = routes
    .filter((r) => r.tenantBindingResolved !== true)
    .map((r) => r.routeId);

  const orgLifecycleRoutes = routes
    .filter((r) => r.organizationLifecycleRequirement === "NOT_REACHED")
    .map((r) => r.routeId);

  const reg = workRegistryByProducerFile.get(writer.file) ?? null;

  return {
    authorizationAuthority: routes.length === 0 ? "NON_REQUEST" : authorityMix.join("+"),
    authorizationBeforeMutation: routes.length === 0 ? "NOT_APPLICABLE" : ungovernedRoutes.length === 0,
    ungovernedEntryRoutes: ungovernedRoutes,
    tenantBinding: routes.length === 0 ? "NON_REQUEST" : tenantUnboundRoutes.length === 0 ? "BOUND" : "UNBOUND",
    tenantUnboundEntryRoutes: tenantUnboundRoutes,
    organizationLifecycleRequirement:
      routes.length === 0 ? "NOT_APPLICABLE" : orgLifecycleRoutes.length === 0 ? "ENFORCED" : "NOT_REACHED",
    transactionAuthority: writer.insideTransaction ? "INSIDE_TRANSACTION" : "AUTOCOMMIT",
    // An external effect INSIDE a transaction cannot be rolled back with it:
    // the email is sent, the object is written, the charge is made, and then
    // the transaction aborts. That is the one ordering this system cannot undo.
    externalSideEffectBoundary:
      writer.kind === "EXTERNAL"
        ? writer.insideTransaction
          ? "INSIDE_TRANSACTION_UNSAFE"
          : "AFTER_COMMIT_OR_OUTBOX"
        : "NOT_APPLICABLE",
    idempotencyAuthority: reg ? reg.idempotency.join("+") : writer.kind === "QUEUE" ? "CANONICAL_JOB_ID" : "NOT_DECLARED",
    retrySemantics: reg ? reg.retry : writer.kind === "QUEUE" ? "REGISTRY" : "NOT_APPLICABLE",
    payloadVersionAuthority: reg ? `schemaVersion=${reg.schemaVersion}` : "NOT_APPLICABLE",
    canonicalOrLegacy: reg ? "CANONICAL" : "UNREGISTERED",
  };
}

// ===========================================================================
// CLOSURE
// ===========================================================================

/**
 * THE DISJOINT REACHABILITY BUCKETS.
 *
 * Every terminal writer lands in exactly ONE, by a fixed precedence, so the
 * total is an identity rather than a subtraction. The previous revision
 * reported `TerminalWriters 1222`, `Reachable 1143` and `DeadUnreachable 73`
 * and left the reader to work out what the other six were — which is precisely
 * the shape of arithmetic this programme has already been corrected for once.
 */
export const WRITER_BUCKETS = Object.freeze([
  "ROUTE_ATTRIBUTED_REACHABLE",
  "JOB_ATTRIBUTED_REACHABLE",
  "MODULE_SCOPED_REACHABLE",
  "REGISTERED_CLI",
  "STARTUP_OR_SCHEDULED",
  "MIGRATION_ONLY",
  "TEST_OR_BUILD_ONLY",
  // A writer that no entrypoint reaches and that is kept ON PURPOSE, each one
  // answered once in `manifests/writer-preservations.json` with the exact
  // evidence for keeping it. It is a bucket rather than an exemption so the
  // count is visible: preserved code that nothing calls is a wiring backlog,
  // and a backlog that cannot be counted is a backlog nobody works off.
  "PRESERVED_PLANNED_WRITER",
  // A writer whose ONLY caller is a shared executor that receives it as an
  // injected port. The call edge is real and the writer runs in production; it
  // is invisible to THIS analyzer because the call site is `port.method(...)`
  // on a parameter, which no static resolution can follow.
  //
  // This is the writer-side twin of `PROP_CALLBACK` in dynamic-resolutions:
  // an indirection a human reads ONCE, records with its evidence, and which the
  // generator re-verifies on every run — the adapter must still call the
  // writer, the executor must still call the port, and an entrypoint must still
  // reach the executor. A stale entry fails rather than lingering.
  //
  // It is deliberately NOT folded into a reachable bucket: the count stays
  // visible, because "reached only through injection" is a weaker claim than
  // "reached by a route" and should read as one.
  "PORT_ATTRIBUTED_REACHABLE",
  "DEAD_UNREACHABLE",
  "UNRESOLVED",
]);

/** Non-request disposition → its bucket. */
const DISPOSITION_BUCKET = Object.freeze({
  REGISTERED_CLI: "REGISTERED_CLI",
  MIGRATION_ONLY: "MIGRATION_ONLY",
  TEST_ONLY: "TEST_OR_BUILD_ONLY",
  BUILD_ONLY: "TEST_OR_BUILD_ONLY",
  SEED: "STARTUP_OR_SCHEDULED",
  RECONCILER_OR_SWEEP: "STARTUP_OR_SCHEDULED",
  STARTUP_TASK: "STARTUP_OR_SCHEDULED",
  INJECTED_PORT_IMPLEMENTATION: "PORT_ATTRIBUTED_REACHABLE",
  PRESERVED_PLANNED_WRITER: "PRESERVED_PLANNED_WRITER",
  DEAD_UNREACHABLE_WRITER: "DEAD_UNREACHABLE",
});

export function writerBucket(w) {
  if (w.entryRoutes.length > 0) return "ROUTE_ATTRIBUTED_REACHABLE";
  if (w.entryJobs.length > 0) return "JOB_ATTRIBUTED_REACHABLE";
  // A timer callback is a REAL entrypoint and a weaker claim than a request:
  // the sweep runs on the process's own schedule with no caller and no tenant
  // in scope. It is therefore ranked below a route and a queue job, and above
  // module-scope, rather than being folded into JOB_ATTRIBUTED_REACHABLE — a
  // `setInterval` is not a queue, and calling it one would hide that these
  // mutations have no idempotency key and no retry policy behind them.
  if ((w.entrySchedules ?? []).length > 0) return "STARTUP_OR_SCHEDULED";
  if ((w.entryModules ?? []).length > 0) return "MODULE_SCOPED_REACHABLE";
  const d = w.nonRequestDisposition;
  if (d === undefined || d === null) return "UNRESOLVED";
  return DISPOSITION_BUCKET[d] ?? "UNRESOLVED";
}

export function evaluateMutationClosure(writers) {
  const rows = [...writers.values()];
  const isReachable = (w) =>
    w.entryRoutes.length > 0 ||
    w.entryJobs.length > 0 ||
    (w.entrySchedules ?? []).length > 0 ||
    (w.entryModules ?? []).length > 0;
  const reachable = rows.filter(isReachable);
  const classified = reachable.filter((w) => w.primaryFamily !== null);
  const unreachable = rows.filter((w) => !isReachable(w));

  const byFamily = {};
  for (const f of MUTATION_FAMILIES) byFamily[f] = 0;
  let unclassifiedTotal = 0;
  for (const w of rows) {
    if (w.primaryFamily === null) unclassifiedTotal += 1;
    else byFamily[w.primaryFamily] += 1;
  }

  const byDisposition = {};
  for (const d of NON_REQUEST_DISPOSITIONS) byDisposition[d] = 0;
  for (const w of unreachable) byDisposition[w.nonRequestDisposition ?? "DEAD_UNREACHABLE_WRITER"] += 1;

  const counters = {
    TerminalWriters: rows.length,
    ReachableSensitiveMutations: reachable.length,
    ClassifiedSensitiveMutations: classified.length,
    UnclassifiedMutationWriters: reachable.length - classified.length,
    UnclassifiedWritersTotal: unclassifiedTotal,
    NonRequestWriters: unreachable.length,
    // Writers whose ONLY attribution is "some registering module reaches this".
    // That is the weakest claim the closure accepts and the gate holds it at
    // zero. A SCHEDULE attribution is not one of these: a timer callback names
    // the exact arming site and `STARTUP_OR_SCHEDULED` is a final state in its
    // own right, so counting it here would have re-opened a closed gate to
    // report a stronger fact than the one it was written to catch.
    ModuleScopedAttributionWriters: reachable.filter(
      (w) =>
        w.entryRoutes.length === 0 &&
        w.entryJobs.length === 0 &&
        (w.entrySchedules ?? []).length === 0,
    ).length,
    DeadUnreachableWriters: byDisposition.DEAD_UNREACHABLE_WRITER,
    // The mandate's own name for the same number: a writer no entrypoint
    // reaches and no reviewed preservation entry accounts for. It is the one
    // that must reach zero, and it reaches zero only by wiring, by an answered
    // preservation, or by removal — never by reclassification.
    DeadUnreachableWritersPending: byDisposition.DEAD_UNREACHABLE_WRITER,
    PreservedPlannedWriters: byDisposition.PRESERVED_PLANNED_WRITER,
    // Reported so the injection count can never grow unnoticed. Every one of
    // these carries a verified manifest entry; the number existing at all is
    // the thing to keep an eye on.
    PortAttributedWriters: byDisposition.INJECTED_PORT_IMPLEMENTATION,
    AuthorizationAfterMutation: reachable.filter((w) => w.invariants?.authorizationBeforeMutation === false).length,
    TenantUnboundMutations: reachable.filter((w) => w.invariants?.tenantBinding === "UNBOUND").length,
    UnsafeEffectsInsideTransactions: rows.filter(
      (w) => w.invariants?.externalSideEffectBoundary === "INSIDE_TRANSACTION_UNSAFE",
    ).length,
    byFamily,
    byNonRequestDisposition: byDisposition,
  };

  // Conservation: every writer is reachable or not, classified or not, and the
  // sums are asserted here rather than by arithmetic in a report.
  counters.MutationConservationHolds =
    counters.ReachableSensitiveMutations + counters.NonRequestWriters === counters.TerminalWriters &&
    counters.ClassifiedSensitiveMutations + counters.UnclassifiedMutationWriters ===
      counters.ReachableSensitiveMutations;

  // --- the disjoint bucket identity ---------------------------------------
  const byBucket = {};
  for (const b of WRITER_BUCKETS) byBucket[b] = 0;
  let overlaps = 0;
  let missing = 0;
  for (const w of rows) {
    const b = writerBucket(w);
    if (!WRITER_BUCKETS.includes(b)) {
      missing += 1;
      continue;
    }
    byBucket[b] += 1;
    // A writer that would qualify for more than one PRIMARY bucket is an
    // overlap, and the precedence hiding it would be a silent double-count.
    const qualifies =
      (w.entryRoutes.length > 0 ? 1 : 0) +
      (w.entryJobs.length > 0 ? 1 : 0) +
      ((w.entryModules ?? []).length > 0 ? 1 : 0) +
      (w.nonRequestDisposition ? 1 : 0);
    if (qualifies > 1 && w.nonRequestDisposition) overlaps += 1;
  }
  counters.byWriterBucket = byBucket;
  counters.WriterBucketOverlaps = overlaps;
  counters.WriterBucketMissing = missing;
  counters.UnresolvedWriters = byBucket.UNRESOLVED;
  counters.MutationWriterConservationHolds =
    WRITER_BUCKETS.reduce((s, b) => s + byBucket[b], 0) === counters.TerminalWriters &&
    overlaps === 0 &&
    missing === 0 &&
    byBucket.UNRESOLVED === 0 &&
    counters.MutationConservationHolds;

  return counters;
}

// ===========================================================================
// QUEUE TOPOLOGY — checked AGAINST the canonical registry, not re-derived.
// ===========================================================================

/**
 * Read the canonical work registry's declared facts out of its source.
 *
 * Parsing the registry rather than importing it keeps this generator free of a
 * TypeScript build step, and the fields read are exactly the ones the registry
 * exists to pin: producer, processor, worker registration, idempotency, retry,
 * schema version and external boundary.
 */
export function readWorkRegistry() {
  const p = path.join(REPO, "packages/shared/src/queue-integrity/registry.ts");
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf8");
  const sf = ts.createSourceFile("registry.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // The registry names its shared module paths ONCE — `const SHARED_ENQUEUE =
  // "packages/…"` — and then refers to the constant. Reading the identifier
  // instead of the string made every BullMQ entry look like it declared a
  // producer module named `SHARED_ENQUEUE`, which naturally does not exist:
  // 36 fabricated "registry problems" that were entirely this parser's.
  const stringConsts = new Map();
  const collect = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isStringLiteralLike(n.initializer)
    ) {
      stringConsts.set(n.name.text, n.initializer.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const entries = [];
  const readObject = (obj) => {
    const out = {};
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
      if (key === null) continue;
      const v = prop.initializer;
      if (ts.isStringLiteralLike(v)) out[key] = v.text;
      else if (ts.isNumericLiteral(v)) out[key] = Number(v.text);
      else if (ts.isIdentifier(v)) out[key] = stringConsts.get(v.text) ?? v.text;
      else if (ts.isPropertyAccessExpression(v)) out[key] = v.name.text;
      else if (ts.isArrayLiteralExpression(v)) {
        out[key] = v.elements.map((e) => (ts.isStringLiteralLike(e) ? e.text : e.getText()));
      } else if (ts.isObjectLiteralExpression(v)) out[key] = readObject(v);
      else out[key] = v.getText().slice(0, 80);
    }
    return out;
  };
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      const hasWorkName = n.properties.some(
        (p2) => p2.name && ts.isIdentifier(p2.name) && p2.name.text === "workName",
      );
      const hasProducer = n.properties.some(
        (p2) => p2.name && ts.isIdentifier(p2.name) && p2.name.text === "canonicalProducer",
      );
      if (hasWorkName && hasProducer) {
        entries.push(readObject(n));
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return entries;
}

/**
 * Queue topology: producers found in the tree, processors registered in the
 * worker, and the registry's declaration of both — so a producer with no
 * processor is a MEASURED fact rather than an assumption.
 */
export function queueTopology(cg, writers, registry) {
  const producedWork = new Map();
  for (const w of writers.values()) {
    if (w.kind !== "QUEUE") continue;
    if (!producedWork.has(w.target)) producedWork.set(w.target, []);
    producedWork.get(w.target).push(w.terminalLocation);
  }

  // `const exifQueueName = QUEUE_NAMES.MI_EXIF` — the local binding's NAME does
  // not always contain the registry key (`exifQueueName` vs `MI_EXIF`), so the
  // binding is resolved to the key it was assigned rather than compared by
  // spelling. One family, `EXTRACT_EXIF`, differed exactly this way and was
  // reported as having no processor while `services/worker/src/index.ts:1936`
  // binds it.
  const queueConstToKey = new Map();
  for (const [, entry] of cg.graph) {
    const visitConst = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isPropertyAccessExpression(n.initializer) &&
        ts.isIdentifier(n.initializer.expression) &&
        n.initializer.expression.text === "QUEUE_NAMES"
      ) {
        queueConstToKey.set(n.name.text, n.initializer.name.text);
      }
      ts.forEachChild(n, visitConst);
    };
    visitConst(entry.sf);
  }

  const registeredQueues = new Map();
  for (const [file, entry] of cg.graph) {
    if (!file.startsWith("services/worker/")) continue;
    const visit = (n) => {
      const isWorkerCtor =
        (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Worker") ||
        (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(createWorker|registerWorker|startWorker)$/.test(n.expression.text));
      if (isWorkerCtor) {
        const arg = n.arguments?.[0];
        const name = arg
          ? ts.isStringLiteralLike(arg)
            ? arg.text
            : ts.isIdentifier(arg)
              ? arg.text
              : ts.isPropertyAccessExpression(arg)
                ? arg.name.text
                : null
          : null;
        const { line } = entry.sf.getLineAndCharacterOfPosition(n.getStart(entry.sf));
        const key = name ?? "UNRESOLVED_QUEUE_NAME";
        if (!registeredQueues.has(key)) registeredQueues.set(key, []);
        registeredQueues.get(key).push(`${file}:${line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(entry.sf);
  }

  // A registry entry whose declared producer module does not exist, or whose
  // declared worker registration file registers no worker at all, is a
  // declaration the tree contradicts.
  const problems = [];
  for (const e of registry) {
    if (e.transport !== "bullmq" && e.transport !== "BULLMQ") continue;
    if (!existsSync(path.join(REPO, String(e.canonicalProducer)))) {
      problems.push({ kind: "REGISTRY_PRODUCER_MISSING", workName: e.workName, module: e.canonicalProducer });
    }
    if (!existsSync(path.join(REPO, String(e.canonicalProcessor)))) {
      problems.push({ kind: "REGISTRY_PROCESSOR_MISSING", workName: e.workName, module: e.canonicalProcessor });
    }
    const regFile = String(e.workerRegistration ?? "").split(":")[0];
    if (regFile && !existsSync(path.join(REPO, regFile))) {
      problems.push({ kind: "REGISTRY_REGISTRATION_MISSING", workName: e.workName, module: e.workerRegistration });
    }
  }

  // ONE canonical producer per work name is the registry's central claim.
  // A second producer module for the same work is a parallel authority, which
  // is the failure the registry exists to prevent — so it is measured, not
  // assumed.
  const parallelAuthorities = [];
  for (const [work, sites] of producedWork) {
    if (work === "UNRESOLVED_WORK_NAME") continue;
    const modules = new Set(sites.map((s) => s.split(":")[0]));
    if (modules.size > 1) parallelAuthorities.push({ workName: work, modules: [...modules] });
  }

  // A LEGACY producer is one that bypasses the canonical enqueue entirely —
  // a bare `<queue>.add(...)`. The registry replaced exactly that idiom, and
  // its reappearance is what "legacy writer" means here.
  const legacyProducers = [];
  for (const [file, entry] of cg.graph) {
    // The canonical enqueue IS a `queue.add` — it is the authority every other
    // producer must go through, not a bypass of it.
    if (file.startsWith("packages/shared/src/queue-integrity/")) continue;
    const sf = entry.sf;
    const visit = (n) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        (n.expression.name.text === "add" || n.expression.name.text === "addBulk")
      ) {
        const recv = n.expression.expression;
        const name = ts.isIdentifier(recv)
          ? recv.text
          : ts.isPropertyAccessExpression(recv)
            ? recv.name.text
            : null;
        // A DEAD-LETTER sink is a terminal disposition, not a work producer:
        // `reportDlqQueue.add("ReportDLQ", …)` is where a job goes when it is
        // being given up on, and routing it through the canonical enqueue
        // would make the give-up path retryable.
        if (name && /queue/i.test(name) && !/dlq|deadletter|dead_letter/i.test(name)) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          legacyProducers.push(`${file}:${line + 1}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // A retryable job with no declared idempotency strategy can duplicate its
  // effect on the second attempt. Read straight from the registry's own
  // declarations rather than guessed from source.
  const nonIdempotentRetryable = registry
    .filter((e) => {
      const attempts = Number(e.retry?.attempts ?? e.retry?.maxAttempts ?? 0);
      const idem = Array.isArray(e.idempotency) ? e.idempotency : [];
      return attempts > 1 && idem.length === 0;
    })
    .map((e) => String(e.workName));

  // A declared BullMQ queue with no `new Worker(...)` bound to it anywhere in
  // the worker is a family that produces and never processes.
  // `registeredQueues` is a Map; `Object.keys` on it is the empty array, which
  // made every declared family look unprocessed.
  const registeredQueueNames = new Set(registeredQueues.keys());
  const unprocessedFamilies = registry
    .filter((e) => String(e.transport).toLowerCase() === "bullmq")
    .filter((e) => {
      const q = String(e.queueName ?? "");
      if (!q) return false;
      // The registry names a queue by its CONSTANT (`REDACTION_DERIVATIVE`);
      // the worker binds it through a local (`redactionDerivativeQueueName`).
      // Both are normalised to letters-only lowercase with the `queuename`
      // suffix removed, which is the only difference between the spellings.
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/queuename$/, "");
      const want = norm(q);
      for (const reg of registeredQueueNames) {
        // Exact, via the constant's assigned registry key…
        if (queueConstToKey.get(reg) === q) return false;
        // …or by spelling, for a queue bound to a literal.
        if (norm(reg) === want) return false;
      }
      return true;
    })
    .map((e) => ({ workName: String(e.workName), queueName: String(e.queueName) }));

  const declaredWork = new Set(registry.map((e) => String(e.workName)));
  const orphanProducers = [...producedWork.keys()].filter(
    (w) => w !== "UNRESOLVED_WORK_NAME" && !declaredWork.has(w) && !declaredWork.has(camelToConst(w)),
  );

  return {
    producedWork: Object.fromEntries(producedWork),
    registeredQueues: Object.fromEntries(registeredQueues),
    registryEntries: registry.length,
    bullmqEntries: registry.filter((e) => String(e.transport).toLowerCase() === "bullmq").length,
    orphanProducers,
    parallelAuthorities,
    legacyProducers,
    nonIdempotentRetryable,
    unprocessedFamilies,
    problems,
  };
}

/** `generateReport` → `GENERATE_REPORT`, so a JOB_NAMES constant matches. */
const camelToConst = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

export { DELEGATES };
