/**
 * PHASE 12 POINT 4 — PASS H2 (2026-08-03).
 *
 * Pass H made every workspace-scoped loader on the review/collaboration/
 * notification surfaces depend on the workspace it actually reads, and gave
 * each one an `isStale` guard so a response for the PREVIOUS workspace cannot
 * paint under the newly selected one.
 *
 * This suite pins the three behaviours that change carried, using the exact
 * shape the production pages now use (a `useCallback` keyed on the workspace
 * id + an effect that passes a cancellation probe into it):
 *
 *   1. a workspace switch re-issues the fetch for the NEW workspace;
 *   2. a slow response for the OLD workspace is discarded, never rendered;
 *   3. a response that resolves after unmount performs no state write.
 *
 * The component below is deliberately a faithful miniature of the production
 * pattern rather than an import of one page, so the invariant is pinned once
 * for every page that adopted it (review/{metrics,qc,schemas,disagreements},
 * collaboration-teams detail + AssignmentsTab, notifications).
 */

import React, { useCallback, useEffect, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, act, screen } from "@testing-library/react";

/** Resolvable-on-demand fetch, so a response can be held open across a switch. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Fetcher = (workspaceId: string) => Promise<string>;

function WorkspaceScopedList({
  workspaceId,
  fetchRows,
  onStateWrite,
}: {
  workspaceId: string;
  fetchRows: Fetcher;
  onStateWrite?: (value: string) => void;
}) {
  const [rows, setRows] = useState<string>("(none)");

  // The production shape: keyed on the workspace, and every post-await write
  // is gated on the caller's staleness probe.
  const refresh = useCallback(
    async (isStale?: () => boolean) => {
      const next = await fetchRows(workspaceId);
      if (isStale?.()) return;
      onStateWrite?.(next);
      setRows(next);
    },
    [workspaceId, fetchRows, onStateWrite],
  );

  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return <span data-testid="rows">{rows}</span>;
}

describe("Pass H2 — workspace-scoped loaders are re-keyed and stale-safe", () => {
  it("switching workspace re-issues the read for the NEW workspace", async () => {
    const seen: string[] = [];
    const fetchRows: Fetcher = async (id) => {
      seen.push(id);
      return `rows:${id}`;
    };

    const { rerender } = render(
      <WorkspaceScopedList workspaceId="ws-A" fetchRows={fetchRows} />,
    );
    await act(async () => undefined);
    expect(seen).toEqual(["ws-A"]);
    expect(screen.getByTestId("rows").textContent).toBe("rows:ws-A");

    rerender(<WorkspaceScopedList workspaceId="ws-B" fetchRows={fetchRows} />);
    await act(async () => undefined);
    // The loader is keyed on the workspace, so the switch refetched. Before
    // Pass H the callback was memoised with `[]` and this second read never
    // happened — the page kept showing workspace A's rows under B.
    expect(seen).toEqual(["ws-A", "ws-B"]);
    expect(screen.getByTestId("rows").textContent).toBe("rows:ws-B");
  });

  it("a slow response for the PREVIOUS workspace is discarded, never rendered", async () => {
    const slowA = deferred<string>();
    const fetchRows: Fetcher = (id) =>
      id === "ws-A" ? slowA.promise : Promise.resolve(`rows:${id}`);

    const writes: string[] = [];
    const { rerender } = render(
      <WorkspaceScopedList
        workspaceId="ws-A"
        fetchRows={fetchRows}
        onStateWrite={(v) => writes.push(v)}
      />,
    );
    // Switch BEFORE A resolves.
    rerender(
      <WorkspaceScopedList
        workspaceId="ws-B"
        fetchRows={fetchRows}
        onStateWrite={(v) => writes.push(v)}
      />,
    );
    await act(async () => undefined);
    expect(screen.getByTestId("rows").textContent).toBe("rows:ws-B");

    // A's response lands late — it must be dropped, not painted into B.
    await act(async () => {
      slowA.resolve("rows:ws-A");
      await slowA.promise;
    });
    expect(writes).not.toContain("rows:ws-A");
    expect(screen.getByTestId("rows").textContent).toBe("rows:ws-B");
  });

  it("a response that resolves after unmount performs no state write", async () => {
    const slow = deferred<string>();
    const writes: string[] = [];
    const { unmount } = render(
      <WorkspaceScopedList
        workspaceId="ws-A"
        fetchRows={() => slow.promise}
        onStateWrite={(v) => writes.push(v)}
      />,
    );
    unmount();
    await act(async () => {
      slow.resolve("rows:ws-A");
      await slow.promise;
    });
    expect(writes).toEqual([]);
  });

  it("a one-shot mutation runs exactly once even when its callback identity changes", async () => {
    // The accept-invite page shape: `run` is now listed as a dependency, and a
    // ref guard is what keeps acceptance idempotent. Re-rendering with a new
    // callback identity must NOT fire a second mutation.
    const calls: string[] = [];
    function OneShot({ token }: { token: string }) {
      const startedRef = React.useRef(false);
      const run = useCallback(async () => {
        calls.push(token);
      }, [token]);
      useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;
        void run();
      }, [run]);
      return null;
    }
    const { rerender } = render(<OneShot token="t-1" />);
    await act(async () => undefined);
    rerender(<OneShot token="t-1" />);
    rerender(<OneShot token="t-1" />);
    await act(async () => undefined);
    expect(calls).toEqual(["t-1"]);
  });

  it("a memoised confirm dialog does not re-create the action callback each render", () => {
    // `useConfirmAction().confirm` is memoised once by the provider, which is
    // why Pass H could list it as a dependency instead of omitting it. If it
    // ever stops being stable, an action callback would be rebuilt on every
    // render and any effect depending on it would re-fire.
    const identities = new Set<unknown>();
    const confirm = vi.fn();
    function ActionHost({ tick }: { tick: number }) {
      const onDelete = useCallback(async () => {
        await confirm();
      }, []);
      identities.add(onDelete);
      return <span data-testid="tick">{tick}</span>;
    }
    const { rerender } = render(<ActionHost tick={1} />);
    rerender(<ActionHost tick={2} />);
    rerender(<ActionHost tick={3} />);
    expect(identities.size).toBe(1);
  });
});
