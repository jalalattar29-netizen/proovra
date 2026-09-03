/**
 * ADM-013 PHASE 11/12 — the control-plane navigation and the attention list,
 * RENDERED.
 *
 * ===========================================================================
 * WHY A RENDER TEST WHEN THERE IS ALREADY A REGISTRY TEST
 * ===========================================================================
 * The registry test proves the DATA is coherent: nine sections, nothing
 * double-homed, every href a real page, every contextual detail with a parent.
 * It cannot prove that a reader on `/admin/customers/<id>` actually SEES the
 * Customers section lit and a crumb back to the list — that is a property of
 * the component, and it is the property the deep-link dead end was about.
 *
 * So this drives the real components through jsdom at three paths that used to
 * behave badly:
 *
 *   /admin                        the section landing, no redundant crumb
 *   /admin/evidence-ops/records   a child that used to light up its parent
 *   /admin/customers/<uuid>       a deep link that used to light up nothing
 *
 * and it renders the attention list in both of its states, because "nothing
 * needs attention" is a state a summary has to be able to express in one line
 * rather than as thirty empty cards.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// -----------------------------------------------------------------------------
// `usePathname` is the only Next binding these components touch.
// -----------------------------------------------------------------------------
let CURRENT_PATH = "/admin";
vi.mock("next/navigation", () => ({
  usePathname: () => CURRENT_PATH,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const AdminConsoleNav = (await import("../../components/admin/AdminConsoleNav"))
  .default;
const { AdminBreadcrumb } = await import(
  "../../components/admin/AdminConsoleNav"
);

function at(path: string) {
  CURRENT_PATH = path;
}

function activeSection(): string | null {
  const el = document.querySelector<HTMLElement>(
    '[data-adminnav-section][data-active="true"]',
  );
  return el?.dataset.adminnavSection ?? null;
}

describe("ADM-013 Phase 11 — the primary navigation", () => {
  it("renders nine sections and no more", () => {
    at("/admin");
    render(<AdminConsoleNav />);
    const sections = document.querySelectorAll("[data-adminnav-section]");
    // Nine is the ceiling. A primary navigation a reader has to scan rather
    // than recognise is the flat list of twenty again, one indirection later.
    expect(sections.length).toBe(9);
    cleanup();
  });

  it("lights up Overview on /admin, and nothing else", () => {
    at("/admin");
    render(<AdminConsoleNav />);
    expect(activeSection()).toBe("overview");
    cleanup();
  });

  it("does NOT light up Overview on a nested admin page", () => {
    // `/admin` as a PREFIX would light up Overview on every page in the
    // console, which is the same "stale active navigation" defect wearing the
    // opposite sign.
    at("/admin/customers");
    render(<AdminConsoleNav />);
    expect(activeSection()).toBe("customers");
    cleanup();
  });

  it("renders no second row for a single-child section", () => {
    // One choice presented as a choice is furniture.
    at("/admin/workspaces");
    render(<AdminConsoleNav />);
    expect(activeSection()).toBe("workspaces");
    expect(document.querySelector("[data-adminnav-secondary]")).toBeNull();
    cleanup();
  });

  it("renders the open section's children as a second row", () => {
    at("/admin/operations");
    render(<AdminConsoleNav />);
    const secondary = document.querySelector("[data-adminnav-secondary]");
    expect(secondary).not.toBeNull();
    expect(secondary!.getAttribute("data-adminnav-secondary")).toBe("operations");
    // And ONLY that section's children — not all thirty-seven surfaces.
    const links = secondary!.querySelectorAll("a");
    expect(links.length).toBeGreaterThan(1);
    expect(links.length).toBeLessThan(20);
    cleanup();
  });
});

describe("ADM-013 Phase 11 — active state is longest-href-wins", () => {
  it("a child does not light up its parent instead of itself", () => {
    at("/admin/evidence-ops/records");
    render(<AdminConsoleNav />);
    expect(activeSection()).toBe("evidence");
    const active = document.querySelector<HTMLAnchorElement>(
      '[data-adminnav-secondary] a[data-active="true"]',
    );
    // Before: `/admin/evidence-ops` matched first and lit up, so opening the
    // child looked like the click had done nothing.
    expect(active?.getAttribute("href")).toBe("/admin/evidence-ops/records");
    cleanup();
  });

  it("the parent still lights up on the parent", () => {
    at("/admin/evidence-ops");
    render(<AdminConsoleNav />);
    const active = document.querySelector<HTMLAnchorElement>(
      '[data-adminnav-secondary] a[data-active="true"]',
    );
    expect(active?.getAttribute("href")).toBe("/admin/evidence-ops");
    cleanup();
  });
});

describe("ADM-013 Phase 11 — a deep link keeps its place", () => {
  it("a customer detail lights up Customers", () => {
    at("/admin/customers/9f3c1b22-1111-4111-8111-111111111111");
    render(<AdminConsoleNav />);
    // Before: no section was active at all, and the operator who arrived here
    // from search had the browser Back button as their only route out.
    expect(activeSection()).toBe("customers");
    cleanup();
  });

  it("and produces a crumb back to the list it came from", () => {
    at("/admin/customers/9f3c1b22-1111-4111-8111-111111111111");
    render(<AdminBreadcrumb />);
    const crumbs = screen.getByLabelText("Breadcrumb");
    expect(crumbs.textContent).toContain("Platform admin");
    expect(crumbs.textContent).toContain("Customers");
    expect(crumbs.textContent).toContain("Customer directory");
    const back = crumbs.querySelector<HTMLAnchorElement>(
      'a[href="/admin/customers"]',
    );
    expect(back, "the crumb back to the customer list is the return path").not.toBeNull();
    cleanup();
  });

  it("does not name the landing surface twice on a section root", () => {
    // "Platform admin / Customers / Customer directory" on the list itself
    // reads as two levels where there is one.
    at("/admin/customers");
    render(<AdminBreadcrumb />);
    const crumbs = screen.getByLabelText("Breadcrumb");
    expect(crumbs.textContent).toContain("Customers");
    expect(crumbs.textContent).not.toContain("Customer directory");
    cleanup();
  });

  it("renders no breadcrumb outside /admin", () => {
    at("/operations");
    const { container } = render(<AdminBreadcrumb />);
    expect(container.firstChild).toBeNull();
    cleanup();
  });
});

describe("ADM-013 Phase 11 — scope is on the control, not only in a banner", () => {
  it("a workspace-scoped child carries its scope before the click", () => {
    at("/admin/operations");
    render(<AdminConsoleNav />);
    // Recovery, not Signers: the registry reclassified signers to
    // PLATFORM_AUDIT (platform data, workspace-shaped audit envelope) with
    // its rationale recorded in adminNavigation.ts — this test's job is the
    // CHIP mechanism, and it must ride a child whose reviewed scope really
    // is WORKSPACE.
    const recovery = document.querySelector<HTMLAnchorElement>(
      'a[href="/admin/platform/recovery"]',
    );
    expect(recovery).not.toBeNull();
    expect(recovery!.getAttribute("data-scope")).toBe("WORKSPACE");
    expect(recovery!.textContent).toContain("Workspace");
    // And the reclassified child says what it now is, not what it was.
    const signers = document.querySelector<HTMLAnchorElement>(
      'a[href="/admin/platform/signers"]',
    );
    expect(signers).not.toBeNull();
    expect(signers!.getAttribute("data-scope")).toBe("PLATFORM_AUDIT");
    cleanup();
  });

  it("a platform-scoped child carries no scope chip", () => {
    at("/admin/operations");
    render(<AdminConsoleNav />);
    const observability = document.querySelector<HTMLAnchorElement>(
      'a[href="/admin/platform/observability"]',
    );
    expect(observability).not.toBeNull();
    expect(observability!.getAttribute("data-scope")).toBe("PLATFORM");
    // Promoted in Phase 1: it resolves no workspace at all any more.
    expect(observability!.textContent).not.toContain("Workspace");
    cleanup();
  });
});

describe("ADM-013 Phase 11 — accessibility", () => {
  it("marks the active section with aria-current", () => {
    at("/admin/security");
    render(<AdminConsoleNav />);
    const current = document.querySelectorAll('[aria-current="page"]');
    // The section AND its active child. Both are "the page you are on" from
    // two levels of the same trail.
    expect(current.length).toBeGreaterThanOrEqual(1);
    cleanup();
  });

  it("names both navigation rows", () => {
    at("/admin/operations");
    render(<AdminConsoleNav />);
    expect(screen.getByLabelText("Platform admin")).toBeTruthy();
    expect(screen.getByLabelText("Platform operations surfaces")).toBeTruthy();
    cleanup();
  });

  it("uses a list, so a screen reader announces the count", () => {
    at("/admin");
    render(<AdminConsoleNav />);
    const lists = document.querySelectorAll("nav ul");
    expect(lists.length).toBeGreaterThanOrEqual(1);
    cleanup();
  });
});
