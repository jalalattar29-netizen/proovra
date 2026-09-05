/**
 * THE ADDRESS BAR FOLLOWS THE FILTERS, AND ISSUES NOTHING WHEN IT ALREADY AGREES.
 *
 * ===========================================================================
 * WHAT THIS PINS
 * ===========================================================================
 * `/admin/operations`, `/admin/users`, `/admin/workspaces` and
 * `/admin/evidence-ops/records` each wrote the shareable URL from inside the
 * fetch callback, so the `router.replace` landed AFTER the response. A reader
 * who clicked a link during the load was navigated back to the list they had
 * just left, with no error and nothing to retry — measured on
 * `/admin/operations`: the same click on the same record link landed on
 * `/admin/operations?status=OPEN` at 3s after arrival and on the record at 9s.
 *
 * Three properties keep that closed, and all three are load-bearing:
 *
 *   1. NO REPLACE WHEN THE URL ALREADY AGREES. This is the arrival case, and
 *      it is the one where a replace can only do harm.
 *   2. A REPLACE WHEN A FILTER CHANGES, so a filtered view stays shareable —
 *      the behaviour the original code existed to provide.
 *   3. UNDECLARED PARAMETERS SURVIVE. A page manages the keys it reads and
 *      leaves the rest alone, which is what lets `/admin/evidence-ops/records`
 *      hand its URL entirely to a `?evidenceId=` deep link by managing
 *      nothing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

const replace = vi.fn();
let search = "";
let pathname = "/admin/operations";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace, back: () => {} }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => pathname,
  useParams: () => ({}),
}));

import { useUrlFilterSync } from "../../lib/use-url-filter-sync";

function Probe({
  path = "/admin/operations",
  values,
}: {
  path?: string;
  values: Record<string, string | number | boolean | null | undefined>;
}) {
  useUrlFilterSync(path, values);
  return null;
}

describe("useUrlFilterSync", () => {
  beforeEach(() => {
    replace.mockClear();
    search = "";
    pathname = "/admin/operations";
  });

  it("issues nothing when the URL already says what the filters say", () => {
    search = "status=OPEN";
    render(<Probe values={{ status: "OPEN", severity: "", teamId: "" }} />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("writes the filters into the URL when they differ from it", () => {
    search = "";
    render(<Probe values={{ status: "OPEN", severity: "", teamId: "" }} />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe("/admin/operations?status=OPEN");
    expect(replace.mock.calls[0][1]).toEqual({ scroll: false });
  });

  it("drops a filter that has been cleared", () => {
    search = "status=OPEN&severity=HIGH";
    render(<Probe values={{ status: "OPEN", severity: "" }} />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe("/admin/operations?status=OPEN");
  });

  it("goes to the bare path when every managed filter is empty", () => {
    search = "status=OPEN";
    render(<Probe values={{ status: "" }} />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe("/admin/operations");
  });

  it("leaves a parameter the page does not declare alone", () => {
    // `?evidenceId=` is not a managed key here: it must survive verbatim.
    search = "evidenceId=abc";
    render(<Probe values={{ status: "OPEN" }} />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe(
      "/admin/operations?evidenceId=abc&status=OPEN",
    );
  });

  it("manages nothing, and so issues nothing, when given no keys", () => {
    // How `/admin/evidence-ops/records` hands its URL to a record deep link.
    search = "evidenceId=abc&signal=TSA_FAILED";
    render(<Probe values={{}} />);
    expect(replace).not.toHaveBeenCalled();
  });

  it("treats false as absent so a boolean filter clears itself", () => {
    search = "customersOnly=true";
    render(<Probe values={{ customersOnly: false }} />);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe("/admin/operations");
  });

  it("writes a true boolean as the string the page reads back", () => {
    search = "";
    render(<Probe values={{ customersOnly: true }} />);
    expect(replace.mock.calls[0][0]).toBe("/admin/operations?customersOnly=true");
  });

  it("stays silent while another route is rendering", () => {
    // Next keeps the outgoing tree mounted during a transition. A replace
    // issued from a page that is no longer the current route fights the
    // navigation the reader just started — which is the whole defect.
    pathname = "/admin/evidence-ops/records";
    search = "";
    render(<Probe path="/admin/operations" values={{ status: "OPEN" }} />);
    expect(replace).not.toHaveBeenCalled();
  });
});
