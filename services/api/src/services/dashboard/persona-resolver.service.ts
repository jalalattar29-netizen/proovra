/**
 * Phase 32.8C FINAL-3 — Persona Resolver + Workspace Capability Matrix.
 *
 * Resolves a stable persona for the current viewer and computes the
 * capability matrix the frontend uses to:
 *   1. order dashboard sections by relevance
 *   2. label/disable team-only actions in personal workspaces
 *   3. hide mutation CTAs for read-only viewers
 *
 * This is deterministic — there is no AI / role-inference. The
 * persona is derived from the role + scope only.
 *
 * Hard rules:
 *   - The capability matrix NEVER weakens auth. It is an advisory
 *     UI hint; the canonical permission gates remain at the route layer.
 *   - Bounded enum values only.
 */

export type WorkspaceScope = "PERSONAL" | "TEAM";

export type Persona =
  | "OWNER_ADMIN"
  | "REVIEWER"
  | "GOVERNANCE_OFFICER"
  | "OPERATOR"
  | "INVESTIGATOR"
  | "VIEWER";

export type CapabilityMatrix = {
  workspaceType: WorkspaceScope;
  role: string;
  persona: Persona;
  capabilities: {
    reviewerOpsRead: boolean;
    reviewerOpsAct: boolean;
    governanceRead: boolean;
    governanceAct: boolean;
    bulkActions: boolean;
    workflowActions: boolean;
    incidentActions: boolean;
    orgIntelligence: boolean;
    personaSwitching: boolean;
  };
  /**
   * Ordered list of dashboard section ids the operator should see first.
   * The frontend uses this to reorder sections by persona. Keys match
   * existing dashboard section ids — adding a key here never creates a
   * new section, only re-prioritizes existing ones.
   */
  sectionOrder: string[];
};

function resolvePersona(role: string): Persona {
  switch (role) {
    case "OWNER":
    case "ADMIN":
      return "OWNER_ADMIN";
    case "REVIEWER":
      return "REVIEWER";
    case "GOVERNANCE_OFFICER":
    case "GOVERNANCE":
      return "GOVERNANCE_OFFICER";
    case "OPERATOR":
      return "OPERATOR";
    case "INVESTIGATOR":
      return "INVESTIGATOR";
    case "AUDITOR":
    case "VIEWER":
      return "VIEWER";
    default:
      return "VIEWER";
  }
}

function sectionOrderForPersona(persona: Persona): string[] {
  switch (persona) {
    case "REVIEWER":
      return [
        "operationalPressure",
        "routingQueue",
        "reviewerOrchestration",
        "workloadEngine",
        "reviewerCapacity",
        "coordinationSignals",
        "incidents",
        "investigationIntelligence",
        "deepIntegrityWatch",
      ];
    case "GOVERNANCE_OFFICER":
      return [
        "operationalPressure",
        "governancePosture",
        "auditReadiness",
        "deepIntegrityWatch",
        "custodyIntegrityAnomalies",
        "incidents",
        "investigationIntelligence",
        "coordinationSignals",
      ];
    case "OPERATOR":
      return [
        "incidents",
        "operationalPressure",
        "queueWorkerTelemetry",
        "queueCongestion",
        "deepIntegrityWatch",
        "accessSecurityClassifier",
        "investigationIntelligence",
      ];
    case "INVESTIGATOR":
      return [
        "investigationIntelligence",
        "crossCaseIntelligenceV2",
        "evidenceRelationshipIntelligence",
        "reconstructedTimeline",
        "operationalPressure",
        "incidents",
      ];
    case "VIEWER":
      return [
        "operationalPressure",
        "incidents",
        "deepIntegrityWatch",
        "auditReadiness",
        "investigationIntelligence",
      ];
    case "OWNER_ADMIN":
    default:
      return [
        "incidents",
        "operationalPressure",
        "routingQueue",
        "investigationIntelligence",
        "evidenceRelationshipIntelligence",
        "crossCaseIntelligenceV2",
        "reviewerOrchestration",
        "workloadEngine",
        "reviewerCapacity",
        "queueWorkerTelemetry",
        "queueCongestion",
        "deepIntegrityWatch",
        "custodyIntegrityAnomalies",
        "accessSecurityClassifier",
        "coordinationSignals",
        "reconstructedTimeline",
        "governancePosture",
        "organizationalIntelligence",
        "organizationalIntelligenceV2",
        "auditReadiness",
        "predictiveRisk",
      ];
  }
}

export function resolveCapabilityMatrix(input: {
  role: string;
  scope: WorkspaceScope;
}): CapabilityMatrix {
  const persona = resolvePersona(input.role);
  const isAdmin = persona === "OWNER_ADMIN";
  const isTeam = input.scope === "TEAM";
  // Read access is universal except for raw mutations.
  const reviewerOpsRead = true;
  const governanceRead = true;
  // Mutation gates: team workspace + non-viewer persona.
  const canMutate = isTeam && persona !== "VIEWER";
  return {
    workspaceType: input.scope,
    role: input.role,
    persona,
    capabilities: {
      reviewerOpsRead,
      reviewerOpsAct:
        canMutate && (isAdmin || persona === "REVIEWER" || persona === "OPERATOR"),
      governanceRead,
      governanceAct:
        canMutate && (isAdmin || persona === "GOVERNANCE_OFFICER"),
      bulkActions: canMutate && isAdmin,
      workflowActions:
        canMutate &&
        (isAdmin || persona === "OPERATOR" || persona === "GOVERNANCE_OFFICER"),
      incidentActions: canMutate && (isAdmin || persona === "OPERATOR"),
      orgIntelligence: true,
      personaSwitching: isAdmin,
    },
    sectionOrder: sectionOrderForPersona(persona),
  };
}
