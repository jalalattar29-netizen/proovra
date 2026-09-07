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
/* No case sets a query string yet; the mock returns an empty
   URLSearchParams so the breadcrumb's `searchParams?.toString()` has
   something real to read. */
const CURRENT_SEARCH = "";
/*
 * EVERY next/navigation HOOK THE COMPONENTS ACTUALLY CALL.
 *
 * The mock carried only usePathname. `AdminBreadcrumb` reads
 * `useSearchParams()` too — that is how the return crumb puts back the list
 * filters an operator arrived with — so vitest threw
 * "No useSearchParams export is defined on the next/navigation mock" inside
 * the component and three breadcrumb cases failed on the harness rather than
 * on the product.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => CURRENT_PATH,
  useSearchParams: () => new URLSearchParams(CURRENT_SEARCH),
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

/* The ONE authority for what the console offers. Derived from, never
   re-typed: see the note in the first describe below. */
const { ADMIN_NAV_SECTIONS } = await import(
  "../../components/admin/adminNavigation"
);

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
  /*
   * ===========================================================================
   * THE SECTION SET IS READ FROM THE REGISTRY, NOT RE-TYPED HERE
   * ===========================================================================
   * These cases used to hard-code the Phase-11 shape: nine sections, a
   * `workspaces` section with one child, an `operations` section with several.
   * Phase 6 folded Workspaces into Customers and Operations into Platform, so
   * all three assertions were describing a navigation that no longer exists —
   * and a render test that disagrees with the registry proves nothing about
   * either, it just has to be updated by hand every time the IA moves.
   *
   * `ADMIN_NAV_SECTIONS` is the one authority for what the console offers, and
   * `admin-console-nav.test.ts` already proves that data is coherent. What is
   * left for a RENDER test is that the component renders exactly that set —
   * so the expectation is derived from it, and the ceiling that motivated the
   * original number is asserted as the ceiling it is.
   */
  const SINGLE_CHILD = ADMIN_NAV_SECTIONS.find((s) => s.children.length === 1);
  const MULTI_CHILD = ADMIN_NAV_SECTIONS.find((s) => s.children.length > 1);

  it("renders exactly the registry's sections, and never more than nine", () => {
    at("/admin");
    render(<AdminConsoleNav />);
    const rendered = [...document.querySelectorAll<HTMLElement>("[data-adminnav-section]")].map(
      (el) => el.dataset.adminnavSection,
    );
    expect(rendered).toEqual(ADMIN_NAV_SECTIONS.map((s) => s.id));
    // Nine is the ceiling. A primary navigation a reader has to scan rather
    // than recognise is the flat list of twenty again, one indirection later.
    expect(rendered.length).toBeLessThanOrEqual(9);
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
    expect(SINGLE_CHILD, "the registry has no single-child section").toBeTruthy();
    at(SINGLE_CHILD!.href);
    render(<AdminConsoleNav />);
    expect(activeSection()).toBe(SINGLE_CHILD!.id);
    expect(document.querySelector("[data-adminnav-secondary]")).toBeNull();
    cleanup();
  });

  it("renders the open section's children as a second row", () => {
    expect(MULTI_CHILD, "the registry has no multi-child section").toBeTruthy();
    at(MULTI_CHILD!.href);
    render(<AdminConsoleNav />);
    const secondary = document.querySelector("[data-adminnav-secondary]");
    expect(secondary).not.toBeNull();
    expect(secondary!.getAttribute("data-adminnav-secondary")).toBe(MULTI_CHILD!.id);
    // And ONLY that section's children — not all thirty-seven surfaces.
    const links = secondary!.querySelectorAll("a");
    expect(links.length).toBe(MULTI_CHILD!.children.length);
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
    /*
     * NOT "Customers".
     *
     * The section crumb used to sit between the root and the list. Phase 6 §6
     * pops it when the section's landing page IS the list — "Customers &
     * organizations › Customer directory" is one destination named twice — so
     * the chain here is "Platform admin › Customer directory › <record>", and
     * the old expectation was pinning the duplication that was removed.
     *
     * What the crumb has to do is what this case is named for: give a way
     * back to the list, and name each destination once.
     */
    expect(crumbs.textContent).toContain("Customer directory");
    const back = crumbs.querySelector<HTMLAnchorElement>(
      'a[href="/admin/customers"]',
    );
    expect(back, "the crumb back to the customer list is the return path").not.toBeNull();
    const hrefs = [...crumbs.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(new Set(hrefs).size, "a destination is named twice").toBe(hrefs.length);
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
    /*
     * THE SECTION AND THE CHILDREN ARE FOUND, NOT NAMED.
     *
     * This case used to open `/admin/operations` and read Recovery and
     * Signers out of that section's second row. Phase 6 has since retired the
     * Operations section and moved both surfaces under Evidence operations,
     * so the two `querySelector` calls returned null and the case failed on
     * the IA rather than on the chip mechanism it exists to test.
     *
     * What it needs is any section that renders BOTH a WORKSPACE child and a
     * PLATFORM_AUDIT one — the two verdicts whose chips must differ. That is a
     * property of the registry, so it is looked up there; the case then holds
     * the mechanism, which is what its name promises, and survives the next
     * time a surface moves.
     */
    const section = ADMIN_NAV_SECTIONS.find(
      (s) =>
        s.children.some((c) => c.scope === "WORKSPACE") &&
        s.children.some((c) => c.scope === "PLATFORM_AUDIT"),
    );
    expect(
      section,
      "no section renders both a WORKSPACE and a PLATFORM_AUDIT child",
    ).toBeTruthy();
    const workspaceChild = section!.children.find((c) => c.scope === "WORKSPACE")!;
    const auditChild = section!.children.find((c) => c.scope === "PLATFORM_AUDIT")!;

    at(section!.href);
    render(<AdminConsoleNav />);

    const workspaceLink = document.querySelector<HTMLAnchorElement>(
      `a[href="${workspaceChild.href}"]`,
    );
    expect(workspaceLink, `${workspaceChild.href} is not rendered`).not.toBeNull();
    expect(workspaceLink!.getAttribute("data-scope")).toBe("WORKSPACE");
    expect(workspaceLink!.textContent).toContain("Workspace");

    // And a child reclassified to PLATFORM_AUDIT says what it now is, not
    // what it was.
    const auditLink = document.querySelector<HTMLAnchorElement>(
      `a[href="${auditChild.href}"]`,
    );
    expect(auditLink, `${auditChild.href} is not rendered`).not.toBeNull();
    expect(auditLink!.getAttribute("data-scope")).toBe("PLATFORM_AUDIT");
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
