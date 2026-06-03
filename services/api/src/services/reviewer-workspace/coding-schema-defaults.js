/**
 * PROOVRA Phase 2A — Default coding schema catalog.
 *
 * Six pre-built schemas seeded into every workspace via
 * `seedDefaultSchemas()`. Each schema mirrors a real reviewer use
 * case — Insurance Review (SIU), Legal Matter, Incident
 * Investigation, Compliance Audit, Journalism Review, and a
 * General Evidence schema.
 *
 * Schemas use the bounded field-type vocabulary from
 * `@proovra/shared/reviewer-workspace.ts`. Every schema includes a
 * REVIEWER_VERDICT field so a final decision can always be recorded.
 *
 * Hard rules:
 *   * Slugs are bounded `^[a-z0-9][a-z0-9-_]{0,78}[a-z0-9]$`.
 *   * orderIndex values are 0-based and contiguous within each schema.
 *   * Required fields drive the gate that prevents a non-PENDING
 *     verdict before all required fields are written.
 */
const VERDICT_FIELD = {
    slug: "verdict",
    label: "Verdict",
    fieldType: "REVIEWER_VERDICT",
    required: true,
    orderIndex: 0,
    helpText: "Bounded reviewer decision; recorded on closure.",
};
const RISK_FIELD = {
    slug: "risk",
    label: "Risk level",
    fieldType: "RISK_LEVEL",
    required: true,
    orderIndex: 1,
};
const CONFIDENCE_FIELD = {
    slug: "confidence",
    label: "Confidence",
    fieldType: "CONFIDENCE_SCORE",
    required: false,
    orderIndex: 2,
    helpText: "0–100 confidence in the verdict.",
};
const NOTES_FIELD = {
    slug: "notes",
    label: "Reviewer notes",
    fieldType: "TEXT",
    required: false,
    orderIndex: 99,
    helpText: "Bounded operator notes (≤ 2 000 chars).",
    options: { maxLength: 2000 },
};
export const DEFAULT_SCHEMAS = [
    {
        slug: "general-evidence",
        label: "General Evidence Review",
        category: "GENERAL_EVIDENCE",
        description: "Universal review schema: verdict, risk, confidence, free-form notes.",
        fields: [VERDICT_FIELD, RISK_FIELD, CONFIDENCE_FIELD, NOTES_FIELD],
    },
    {
        slug: "insurance-review",
        label: "Insurance Review (SIU)",
        category: "INSURANCE_REVIEW",
        description: "Insurance Special Investigations Unit review — claim type, indicators, fraud signal.",
        fields: [
            VERDICT_FIELD,
            RISK_FIELD,
            {
                slug: "claim-type",
                label: "Claim type",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 3,
                options: {
                    options: [
                        { value: "auto", label: "Auto" },
                        { value: "property", label: "Property" },
                        { value: "health", label: "Health" },
                        { value: "life", label: "Life" },
                        { value: "commercial", label: "Commercial" },
                        { value: "other", label: "Other" },
                    ],
                },
            },
            {
                slug: "fraud-indicators",
                label: "Fraud indicators present",
                fieldType: "MULTI_SELECT",
                required: false,
                orderIndex: 4,
                options: {
                    options: [
                        { value: "staged_loss", label: "Staged loss" },
                        { value: "inflated_claim", label: "Inflated claim" },
                        { value: "false_documentation", label: "False documentation" },
                        { value: "prior_claims_pattern", label: "Prior claims pattern" },
                        { value: "third_party_collusion", label: "Third-party collusion" },
                    ],
                },
            },
            {
                slug: "siu-referral",
                label: "Refer to SIU?",
                fieldType: "BOOLEAN",
                required: true,
                orderIndex: 5,
            },
            CONFIDENCE_FIELD,
            NOTES_FIELD,
        ],
    },
    {
        slug: "legal-matter",
        label: "Legal Matter Review",
        category: "LEGAL_MATTER",
        description: "Legal review schema: relevance, privilege, responsiveness, redaction.",
        fields: [
            VERDICT_FIELD,
            RISK_FIELD,
            {
                slug: "relevance",
                label: "Relevance",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 3,
                options: {
                    options: [
                        { value: "responsive", label: "Responsive" },
                        { value: "non_responsive", label: "Non-responsive" },
                        { value: "needs_qc", label: "Needs QC" },
                    ],
                },
            },
            {
                slug: "privilege",
                label: "Privilege",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 4,
                options: {
                    options: [
                        { value: "not_privileged", label: "Not privileged" },
                        { value: "attorney_client", label: "Attorney-client" },
                        { value: "work_product", label: "Work product" },
                        { value: "common_interest", label: "Common interest" },
                    ],
                },
            },
            {
                slug: "redaction-needed",
                label: "Redaction needed",
                fieldType: "BOOLEAN",
                required: true,
                orderIndex: 5,
            },
            {
                slug: "issue-tags",
                label: "Issue tags",
                fieldType: "MULTI_SELECT",
                required: false,
                orderIndex: 6,
                options: {
                    options: [
                        { value: "contract", label: "Contract" },
                        { value: "financial", label: "Financial" },
                        { value: "communication", label: "Communication" },
                        { value: "policy", label: "Policy" },
                        { value: "personnel", label: "Personnel" },
                    ],
                },
            },
            CONFIDENCE_FIELD,
            NOTES_FIELD,
        ],
    },
    {
        slug: "incident-investigation",
        label: "Incident Investigation",
        category: "INCIDENT_INVESTIGATION",
        description: "Internal investigation review: severity, scope, evidence integrity, escalation.",
        fields: [
            VERDICT_FIELD,
            RISK_FIELD,
            {
                slug: "severity",
                label: "Severity",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 3,
                options: {
                    options: [
                        { value: "minor", label: "Minor" },
                        { value: "moderate", label: "Moderate" },
                        { value: "major", label: "Major" },
                        { value: "critical", label: "Critical" },
                    ],
                },
            },
            {
                slug: "scope",
                label: "Scope",
                fieldType: "MULTI_SELECT",
                required: false,
                orderIndex: 4,
                options: {
                    options: [
                        { value: "single_individual", label: "Single individual" },
                        { value: "team", label: "Team" },
                        { value: "department", label: "Department" },
                        { value: "external_party", label: "External party" },
                    ],
                },
            },
            {
                slug: "escalation",
                label: "Escalation level",
                fieldType: "ESCALATION_LEVEL",
                required: true,
                orderIndex: 5,
            },
            CONFIDENCE_FIELD,
            NOTES_FIELD,
        ],
    },
    {
        slug: "compliance-audit",
        label: "Compliance Audit",
        category: "COMPLIANCE_AUDIT",
        description: "Audit + retention review: control, finding, remediation owner.",
        fields: [
            VERDICT_FIELD,
            RISK_FIELD,
            {
                slug: "control",
                label: "Control",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 3,
                options: {
                    options: [
                        { value: "access", label: "Access" },
                        { value: "data_handling", label: "Data handling" },
                        { value: "retention", label: "Retention" },
                        { value: "audit_trail", label: "Audit trail" },
                        { value: "training", label: "Training" },
                    ],
                },
            },
            {
                slug: "finding",
                label: "Finding",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 4,
                options: {
                    options: [
                        { value: "no_finding", label: "No finding" },
                        { value: "minor", label: "Minor finding" },
                        { value: "major", label: "Major finding" },
                        { value: "critical", label: "Critical finding" },
                    ],
                },
            },
            {
                slug: "remediation-needed",
                label: "Remediation needed",
                fieldType: "BOOLEAN",
                required: true,
                orderIndex: 5,
            },
            CONFIDENCE_FIELD,
            NOTES_FIELD,
        ],
    },
    {
        slug: "journalism-review",
        label: "Journalism Source Review",
        category: "JOURNALISM_REVIEW",
        description: "Source-protection-aware review: source class, on/off record, publication recommendation.",
        fields: [
            VERDICT_FIELD,
            RISK_FIELD,
            {
                slug: "source-class",
                label: "Source class",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 3,
                options: {
                    options: [
                        { value: "named", label: "Named" },
                        { value: "background", label: "On background" },
                        { value: "deep_background", label: "Deep background" },
                        { value: "off_record", label: "Off the record" },
                    ],
                },
            },
            {
                slug: "corroboration",
                label: "Corroboration",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 4,
                options: {
                    options: [
                        { value: "primary_only", label: "Primary only" },
                        { value: "secondary", label: "Secondary" },
                        { value: "multiple_secondary", label: "Multiple secondary" },
                        { value: "documentary", label: "Documentary" },
                    ],
                },
            },
            {
                slug: "publish-recommendation",
                label: "Publish recommendation",
                fieldType: "SINGLE_SELECT",
                required: true,
                orderIndex: 5,
                options: {
                    options: [
                        { value: "publish", label: "Publish" },
                        { value: "publish_with_changes", label: "Publish with changes" },
                        { value: "delay", label: "Delay" },
                        { value: "do_not_publish", label: "Do not publish" },
                    ],
                },
            },
            CONFIDENCE_FIELD,
            NOTES_FIELD,
        ],
    },
];
