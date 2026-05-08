"use client";

const SECTION_LINKS = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "source-context", label: "Source Context" },
  { id: "preservation", label: "Preservation" },
  { id: "verification", label: "Verification" },
  { id: "custody", label: "Custody" },
  { id: "relationships", label: "Relationships" },
  { id: "notes", label: "Notes" },
  { id: "workflow", label: "Workflow" },
  { id: "artifacts", label: "Artifacts" },
  { id: "access", label: "Access" },
  { id: "technical-appendix", label: "Technical Appendix" },
] as const;

export function SectionRail() {
  return (
    <nav className="evidence-detail-rail" aria-label="Evidence review sections">
      {SECTION_LINKS.map((link) => (
        <a key={link.id} href={`#${link.id}`} className="evidence-detail-rail__link">
          {link.label}
        </a>
      ))}
    </nav>
  );
}
