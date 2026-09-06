# Phase 7 §B9 — every chart in the Admin console, and what happened to it

Written by hand and checked against the tree, because a chart is not something
a script can classify: whether a picture is worth drawing depends on what the
data means, and the whole point of this section is that somebody had to answer
that per surface.

## The inventory

The console renders visual data in exactly one place.

| Surface | What it draws | Disposition |
|---|---|---|
| `/admin/platform/observability` → Live trends | Six sparklines over polled operational metrics | `KEPT_WITH_PROVEN_DATA` |

Everything else in the 47 pages presents figures as KPI tiles, tables or status
capsules. That is not an omission this phase made — earlier passes removed the
decorative charts, and the remaining question was whether the survivor earns
its pixels.

## `/admin/platform/observability` → Live trends — KEPT_WITH_PROVEN_DATA

**The dataset.** `GET /v1/admin/platform/metrics`, polled every 15 seconds by
the page's own effect, accumulated into a rolling client-side buffer. Nothing
is fetched for the chart specifically and nothing is interpolated; each point
is one poll of the same snapshot the tiles above it read.

**The timeframe.** The last `SAMPLE_CAP` samples, stated on the page as
"Last N polled samples (~M min)". The delta beside each line names its own
window — "this session" — rather than implying a period the buffer does not
cover.

**The units.** Counts and levels, named by the caption: queue backlog,
escalations open, queue retries, reviewer queue overdue, invalid webhook
signatures. Two are counters and four are gauges, and the registry entry for
each records which — a counter's line is a rate of arrival and a gauge's is a
level, and they are not read the same way.

**The scope.** Platform-wide. The page carries a `Scope: Platform` badge and
its effect has an empty dependency list, deliberately: nothing it reads varies
with the active workspace, so switching workspace does not re-fetch and does
not change a value.

**Missing and partial.** Three states, kept apart:

* `NOT_MEASURED` — no metric by that name is registered. The page says so in
  words. This was `metrics.counters[key] ?? 0` once, which drew a flat,
  permanent, reassuring line for a metric that did not exist.
* `AWAITING_SAMPLE` — the metric is registered and the buffer is empty, which
  is the first fifteen seconds of a session and not a fault.
* fewer than two samples — "collecting samples…", because a line needs two
  points and one point drawn as a line is a trend nobody measured.

**The accessible value.** The current reading is rendered as text beside the
line, and the delta above it, so the figures are never only in the picture.
This phase fixed the `aria-label`, which said `"<caption> trend"` — the subject
of the picture with none of its content. It now reads
`"<caption>: <first> to <last> over the last <n> samples"`, which is the same
three facts a sighted reader takes from the shape.

**Why a chart and not a KPI.** The tiles above already give every current
value. What the tiles cannot show is whether a backlog of 40 is on its way up
or on its way down, and that is the question an operator opens this page to
answer during an incident. A line over a known window answers it; a bigger
number does not.

**Why not a table.** Fifty samples × six metrics is 300 cells of noise for a
reading that is entirely about shape. The exact numbers that matter — where it
started, where it is now, and the change — are all rendered as text.

## What none of them are

No chart in the console renders:

* a fake or smoothed trend — every point is a real poll,
* the current value repeated as if it were history,
* an unregistered metric key — those render `NOT_MEASURED`,
* unavailable data as zero,
* a time range or unit the caption does not state.

## Where the claim is enforced

`apps/web/app/(app)/admin/platform/observability/page.tsx` carries the
registry with a comment per key recording which name it replaced and why; the
sampler refuses to substitute zero for an absent key. `admin-states` and the
state matrix cover the `NOT_MEASURED` and `AWAITING_SAMPLE` renderings.
