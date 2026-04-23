import { ReportViewModel, TimelineRow } from "../types.js";
import { escapeHtml } from "../formatters.js";
import { renderCallout, renderPageSection } from "../ui.js";
import { renderLegalLimitationsBlock } from "./legal-limitations.js";

function renderCustodySubsection(title: string, body: string): string {
  return `
    <section class="appendix-section">
      <h3 class="appendix-section-title">${escapeHtml(title)}</h3>
      ${body}
    </section>
  `;
}

function renderTimeline(rows: TimelineRow[]): string {
  if (rows.length === 0) return "";

  return `
    <div class="timeline">
      ${rows
        .map(
          (row) => `
            <article class="timeline-item">
              <div class="timeline-index">${escapeHtml(row.sequence)}</div>
              <div class="timeline-card">
                <div class="timeline-top">
                  <div class="timeline-event">${escapeHtml(row.eventLabel)}</div>
                  <div class="timeline-time">${escapeHtml(row.atUtc)}</div>
                </div>
                <div class="timeline-summary">${escapeHtml(row.summary)}</div>
              </div>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderCustodySection(vm: ReportViewModel): string {
  const forensicBlock =
    vm.forensicRows.length === 0
      ? renderCallout({
          title: "No forensic custody events returned",
          body:
            "This report did not receive internal forensic custody-event entries for this evidence record. That means no system-recorded forensic chain was available in this output; it should not be treated as proof that no handling occurred outside the recorded workflow.",
          tone: "warning",
        })
      : renderTimeline(vm.forensicRows);

  const accessBlock =
    vm.accessRows.length === 0
      ? ""
      : renderCustodySubsection(
          "Access Activity",
          `
            ${renderCallout({
              title: "Access activity is informational",
              body:
                "Later viewing, download, and verification actions are separated from forensic lifecycle events so they do not get confused with integrity-relevant custody events.",
              tone: "neutral",
            })}
            ${renderTimeline(vm.accessRows)}
          `
        );

  const hashNotice =
    vm.custodyHashRows.length === 0
      ? ""
      : renderCallout({
          title: "Hash-chain detail moved to appendix",
          body:
            "The full previous-event hash and event-hash chain is preserved in the Technical Appendix. This keeps the custody narrative readable while retaining audit-grade technical detail.",
          tone: "neutral",
        });

  return renderPageSection(
    "Chain of Custody",
    `
      ${renderCallout({
        title: "Custody reading note",
        body:
          "This section presents reviewer-facing forensic lifecycle events in chronological order. It is designed for legal and operational review, while the technical hash-chain values are preserved in the appendix.",
        tone: "neutral",
      })}

      ${forensicBlock}

      ${hashNotice}

      ${accessBlock}

      ${renderCustodySubsection(
        "Legal Interpretation & Review Use",
        renderLegalLimitationsBlock(vm)
      )}
    `,
    { pageBreakBefore: true }
  );
}