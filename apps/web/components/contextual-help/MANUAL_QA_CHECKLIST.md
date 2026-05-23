# Phase 38.16 — Manual QA checklist

Source-level tests (in `services/api/test/phase-38-16-*.test.ts`)
verify structural a11y contracts (role, aria-label, dismiss-button
labels, aria-expanded wiring) and density-attribute consumption.

The items below CANNOT be verified by source tests. They require a
real browser + device emulation. Run this checklist after any change
that touches the panels listed under "Surfaces" before claiming
browser-verified coverage.

## Surfaces in scope

- Capture intake rail (`data-capture-intake-rail`)
- Capture workflow guidance (`data-capture-workflow-guidance`)
- Capture readiness panel (`data-capture-readiness`)
- Capture suggestions panel (`data-capture-suggestions`)
- ContextualHelp (`data-contextual-help`)
- PageRouteGate panels (`data-page-route-gate`)
- WorkflowSafetyNotice (`data-workflow-safety-notice`)
- Command palette (`data-command-palette`)

## Responsive

### Desktop (≥ 1280px)
- [ ] No horizontal overflow on any surface
- [ ] Intake rail wraps to a second line when stages don't fit
- [ ] Dashboard band groupings render as 2-col / 3-col where the
      registry declares a `gridGroup`
- [ ] Command palette centred at 640px max-width

### Laptop (1024-1279px)
- [ ] Intake rail still readable (chips stay on baseline)
- [ ] Dashboard band groupings still 2-col where possible
- [ ] Sidebar fits without horizontal scroll

### Tablet (768-1023px)
- [ ] Sidebar collapses or hides via the mobile nav pattern
- [ ] Intake rail wraps gracefully to multiple lines
- [ ] Capture panels (rail + guidance + readiness + suggestions
      + help) do not collectively push the camera/upload controls
      below the fold by more than one viewport's worth of scroll
- [ ] PageRouteGate denial panels fit within the viewport
      (no horizontal scrollbars)

### Mobile (≤ 767px)
- [ ] Mobile nav usable (sidebar reachable via shell nav)
- [ ] Command palette opens with `Cmd+K` (or equivalent) and the
      input is focusable + the dialog has a tap-target for close
- [ ] Capture page is usable — camera + upload controls reachable
      without excessive vertical scrolling
- [ ] Tables (evidence, cases, reviewer-ops) scroll horizontally
      or stack — no clipped columns
- [ ] Intake rail collapses to a vertical list OR wraps cleanly

### Density modes
- [ ] Switch persona's `operationalDensityPreference` between
      `comfortable` / `compact` / `spacious` (via /settings/persona)
      and observe the panels in scope visibly change padding +
      font-size via the CSS variables defined in
      `apps/web/components/app-shell-v2/app-shell-v2.css`
- [ ] `compact` mode does not clip text or overlap chips
- [ ] `spacious` mode does not push critical controls off-screen on
      laptop or smaller

## Accessibility

### Keyboard-only
- [ ] Tab order through the intake rail lands on the active stage
      with a visible focus ring
- [ ] Tab order through ContextualHelp lands on the toggle button,
      then the dismiss button
- [ ] Escape closes the command palette
- [ ] Escape closes any open dialog (PageRouteGate panels render
      a `<main>`, not a dialog — they are content surfaces and do
      not require Escape handling)
- [ ] Focus returns to the trigger after the command palette closes

### Screen reader
- [ ] Intake rail is announced as "Capture intake progression
      navigation, list of 5 items"
- [ ] Active stage announces "step 2 of 5, current step"
      (via `aria-current="step"`)
- [ ] ContextualHelp toggle announces "Help: <title>, button,
      expanded" or "collapsed" depending on state
- [ ] Dismiss buttons announce their accessible name
      (e.g. "Dismiss capture readiness panel, button")
- [ ] Command palette announces "Command palette dialog,
      Search tools and routes, edit text"

### Visible focus
- [ ] All buttons render a visible focus ring (not just outline:0)
- [ ] Tab+Shift cycles backward without trapping focus
- [ ] No `tabindex="-1"` blocks legitimate keyboard navigation

## Reporting

If any item fails, file a defect in the relevant Phase 38.x worklog
and link the screen + browser + density mode.

If a browser/device for verification is genuinely unavailable, note
that the verification is **deferred** rather than claiming pass.
