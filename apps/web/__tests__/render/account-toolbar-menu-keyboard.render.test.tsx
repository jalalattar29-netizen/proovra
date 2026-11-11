/**
 * AUD-0064 — the header's workspace switcher declared aria-haspopup="menu"
 * but did not behave as one: Enter opened it with focus left on the button,
 * arrow keys did nothing, and after Tab into the items Escape did not close
 * it. The account menu beside it had the same gaps.
 *
 * Expected (the menu-button contract AppRowMenu already keeps): Enter /
 * Space / ArrowDown open and focus the first item, ArrowUp/ArrowDown/Home/End
 * move between items, Escape from any item closes and returns focus to the
 * button, and focus leaving the menu closes it.
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

// Header neighbours that fetch on mount; not under test here.
vi.mock("../../components/app-shell-v2/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("../../components/language-switcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("../../components/operational", () => ({ GlobalRuntimeIndicator: () => null }));

const switchWorkspace = vi.hoisted(() => vi.fn(async () => undefined));
const envelope = vi.hoisted(() => ({
  user: { firstName: "Jane", lastName: "Doe", email: "jane@example.com", avatarUrl: null },
  platform: { isPlatformAdmin: false },
  activeSpace: { type: "PERSONAL", id: "personal-1", displayName: "Personal Space" },
  personalSpace: { id: "personal-1", status: "active" },
  capabilities: { ACCOUNT_SETTINGS_VIEW: true, ACCOUNT_BILLING_VIEW: true },
  organizations: [],
  account: { accountPlan: "PRO" },
  contextOptions: {
    personalSpace: { workspaceId: "personal-1", name: "Personal Space", role: "OWNER" },
    ownedWorkspaces: [],
    organizations: [
      {
        organizationId: "org-a",
        organizationName: "Acme",
        workspaces: [{ workspaceId: "ws-a", workspaceName: "Acme Claims", workspaceRole: "MEMBER" }],
      },
      {
        organizationId: "org-b",
        organizationName: "Beta",
        workspaces: [{ workspaceId: "ws-b", workspaceName: "Beta Legal", workspaceRole: "MEMBER" }],
      },
    ],
  },
}));
vi.mock("../../lib/platform-context", () => ({
  usePlatformContext: () => ({ envelope, state: { name: "READY" }, switchWorkspace }),
}));

import { AppAccountToolbar } from "../../components/app-shell-v2/AppAccountToolbar";

afterEach(() => cleanup());

function renderToolbar() {
  render(<AppAccountToolbar onLogout={() => {}} />);
  const switcher = screen.getByRole("button", { name: /Open workspace switcher/ });
  const account = document.querySelector<HTMLButtonElement>(".app-topbar-v2-user");
  if (!account) throw new Error("account button missing");
  return { switcher, account };
}

function key(target: Element | null, k: string) {
  act(() => {
    fireEvent.keyDown(target ?? document.body, { key: k });
  });
}

function menuItems(menuName: string) {
  return within(screen.getByRole("menu", { name: menuName })).getAllByRole("menuitem");
}

describe("AUD-0064: the workspace switcher is a keyboard menu", () => {
  it.each(["Enter", " ", "ArrowDown"])("%j on the button opens it and focuses the first item", (k) => {
    const { switcher } = renderToolbar();
    switcher.focus();
    key(switcher, k);
    expect(switcher.getAttribute("aria-expanded")).toBe("true");
    const items = menuItems("Switch workspace");
    expect(items.length).toBe(3);
    expect(document.activeElement).toBe(items[0]);
  });

  it("ArrowUp on the button opens it on the last item", () => {
    const { switcher } = renderToolbar();
    switcher.focus();
    key(switcher, "ArrowUp");
    const items = menuItems("Switch workspace");
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("arrows, Home and End move between items; arrows wrap", () => {
    const { switcher } = renderToolbar();
    switcher.focus();
    key(switcher, "Enter");
    const items = menuItems("Switch workspace");
    key(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    key(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    key(document.activeElement, "ArrowUp");
    expect(document.activeElement).toBe(items[2]);
    key(document.activeElement, "Home");
    expect(document.activeElement).toBe(items[0]);
    key(document.activeElement, "End");
    expect(document.activeElement).toBe(items[2]);
  });

  it("Escape from an item reached by Tab closes the menu and returns focus to the button", () => {
    const { switcher } = renderToolbar();
    act(() => {
      fireEvent.click(switcher);
    });
    const items = menuItems("Switch workspace");
    // The reported path: focus moved onto an item by Tab, not by the arrows.
    act(() => {
      items[1].focus();
    });
    key(items[1], "Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(switcher.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(switcher);
  });

  it("opening by click also puts focus on the first item", () => {
    const { switcher } = renderToolbar();
    act(() => {
      fireEvent.click(switcher);
    });
    expect(document.activeElement).toBe(menuItems("Switch workspace")[0]);
  });

  it("focus leaving the menu closes it without pulling focus back", () => {
    const { switcher, account } = renderToolbar();
    switcher.focus();
    key(switcher, "Enter");
    const items = menuItems("Switch workspace");
    act(() => {
      fireEvent.blur(items[2], { relatedTarget: account });
    });
    expect(screen.queryByRole("menu")).toBeNull();
    // control: moving between items does not close it
    key(switcher, "Enter");
    const again = menuItems("Switch workspace");
    act(() => {
      fireEvent.blur(again[0], { relatedTarget: again[1] });
    });
    expect(screen.getByRole("menu", { name: "Switch workspace" })).toBeTruthy();
  });

  it("choosing an item with Enter still switches workspace", () => {
    const { switcher } = renderToolbar();
    switcher.focus();
    key(switcher, "Enter");
    key(document.activeElement, "ArrowDown");
    act(() => {
      fireEvent.click(document.activeElement as HTMLElement);
    });
    expect(switchWorkspace).toHaveBeenCalledWith("ws-a");
  });
});

describe("AUD-0064: the account menu keeps the same contract", () => {
  it("Enter opens on the first item, arrows/End move, Escape returns to the button", () => {
    const { account } = renderToolbar();
    expect(account.getAttribute("aria-haspopup")).toBe("menu");
    account.focus();
    key(account, "Enter");
    expect(account.getAttribute("aria-expanded")).toBe("true");
    const items = menuItems("Account");
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[0]);
    key(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key(document.activeElement, "End");
    expect(document.activeElement).toBe(items[items.length - 1]);
    expect(items[items.length - 1].textContent).toContain("Sign out");
    key(document.activeElement, "Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(account);
  });

  it("its Switch workspace item opens the switcher with focus on its first item", () => {
    const { account } = renderToolbar();
    account.focus();
    key(account, "Enter");
    const switchItem = menuItems("Account").find((el) => el.textContent?.includes("Switch workspace"));
    expect(switchItem).toBeTruthy();
    act(() => {
      fireEvent.click(switchItem as HTMLElement);
    });
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
    expect(document.activeElement).toBe(menuItems("Switch workspace")[0]);
  });
});
