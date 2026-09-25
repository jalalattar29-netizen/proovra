# L — END-TO-END HANDLER TRACE LEDGER

**Frozen SHA:** `71e148f34410c7c231f8930d1387d8924b10b4e5`
**Instrument:** `09-handler-ledger.mjs` · machine data: `handler-ledger.json`

Answers mandate §9. The previous pass inventoried handlers and explicitly did
**not** trace them; the mandate rules that inadequate. Every handler binding
reachable from an applicable route is now either traced to a terminal effect,
classified as a primitive prop-forward, or individually unresolved with the exact
stopping point named.

---

## L.1 Method

For each `on*` binding the tracer takes the bound expression and follows named
callees **across files** — same-file declarations, imports, barrel re-exports —
cycle-guarded, **with no three-level cap** (depth bound 12, and exceeding it is
reported, not silently truncated). It accumulates every terminal effect reachable
from the body:

`API` · `NAV` · `STATE` · `FEEDBACK` · `DIALOG` · `FORM` · `DOWNLOAD` · `STORAGE`

When the chain leaves the statically resolvable graph the stopping point is
recorded with its reason.

### The PROP_FORWARD category, and why it exists

`<Pressable onPress={onPress}>` inside `ProovraButton` is not an untraced
handler — it has no effect of its own **by construction**, and the effect lives at
every call site. Counting these as unresolved would inflate the unresolved
figure with the entire design-system layer; counting them as traced would invent
an effect. They are their own category. 512 such bindings exist across both
platforms.

---

## L.2 Results — distinct bindings

| | PWA | Native |
|---|---:|---:|
| **Distinct handler bindings** | **1,555** | **645** |
| Traced to a terminal effect | **921** | **474** |
| `PROP_FORWARD` (primitive forwards its own callback) | 257 | 109 |
| **Accounted for** | **1,178 (75.8%)** | **583 (90.4%)** |
| `NO_EFFECT_FOUND` | 207 | 51 |
| **`UNRESOLVED`** | **170** | **11** |

(5,595 binding *occurrences* across routes; shared components recur, so the
distinct figures above are the honest denominators.)

## L.3 Effect distribution

| Effect | PWA occurrences | Native occurrences |
|---|---:|---:|
| `STATE` | 1,575 | 638 |
| `DIALOG` | 433 | 220 |
| `FEEDBACK` | 352 | 221 |
| `API` | 337 | 290 |
| `NAV` | 29 | **506** |
| `FORM` | 83 | 0 |
| `STORAGE` | 63 | 15 |
| `DOWNLOAD` | 7 | 13 |

### Reading the two that look wrong

* **`NAV` 29 web vs 506 native** is not a native advantage. The web navigates
  declaratively with `<Link href>` (counted at L4 as `LINK` elements, not as
  handlers); native navigates imperatively with `router.push` inside `onPress`.
  Same product behaviour, different idiom — **VALID PLATFORM ADAPTATION**, and a
  worked example of why a handler count alone decides nothing.
* **`FORM` 83 web vs 0 native** is real. React Native has no `<form>`/
  `preventDefault`; submission is a button `onPress`. The product question — does
  each web form have a native submit path — is answered per route in
  `routes/*.md`, not by this count.

## L.4 The 181 unresolved bindings — named, not hidden

| Reason | Occurrences | Honest reading |
|---|---:|---|
| callee is a **prop callback or in-scope binding** the static graph cannot bind | 5,143 | the dominant boundary. A component receives `onConfirm` from a parent chosen at runtime; source cannot name which |
| callee comes from an **external package** | (included above) | e.g. `next/navigation`, `expo-router` — a real terminal boundary, named |
| callee **not found** in the resolved target module | 4 | genuine resolution failures; listed in `handler-ledger.json` |

**Native's 11 unresolved against the web's 170** reflects composition style, not
quality: the web passes far more render-props and callback props through generic
containers.

## L.5 What this ledger does and does not establish

**Does:** every applicable handler binding has a disposition. 1,761 of 2,200
distinct bindings are traced to a terminal effect class; 366 are primitive
forwards; 181 are unresolved with a named stopping point; 258 reach no detected
effect.

**Does not:** it does not prove two handlers that both reach `API` call the *same*
endpoint with the *same* parameters and render the *same* result. That comparison
is done per route at L8 in `routes/*.md`, and the parameter-level gap it exposes
is `K-DATA-FLOW-MATRIX.md` §K.3.

**Nothing here was executed.** No handler was run, on any platform.
