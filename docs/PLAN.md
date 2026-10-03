# Sargas Time Bomb — Adventure Clock System

Implementation plan for `sargas-time-bomb`, a Foundry VTT v14 module that adds
progress clocks, countdowns, looming threats, faction progress, corruption,
alarms, projects and weather fronts, and advances them manually, on scene change,
at rest, on elapsed campaign time, on calendar deadlines, or after configurable
events. It is designed as a companion to **Through the Ages** (`through-the-ages`,
v2.1.0), which supplies the campaign calendar and clock, while still working in a
world that does not run it.

Status: implemented (milestones M0–M6). This document is kept as the design reference; see `README.md` for usage.

---

## 1. Decisions and assumptions

| # | Decision | Rationale |
|---|---|---|
| D1 | Module id `sargas-time-bomb`, title **Sargas Time Bomb**, subtitle "Adventure Clock System". i18n prefix `STB`, CSS scope `.stb`, application ids `stb-*`. | Matches the GitHub repository name, which Foundry requires to equal the folder name. Mirrors TTA's `TTA` / `.tta` / `tta-*` conventions so the two modules read as a family. |
| D2 | Through the Ages is an **optional** dependency, declared under `relationships.recommends`. | "Must work with" TTA is satisfied by a first-class integration; a hard `requires` would stop the clocks from being useful in a world that only wants manual, scene, rest or hook triggers. Calendar-dated features degrade cleanly (see §6). |
| D3 | Foundry v14 only (`14.366` minimum and verified), system-agnostic, no game mechanics. Rest detection uses known system hooks when present plus a GM "Declare rest" control that works everywhere. | Same compatibility target and philosophy as TTA. |
| D4 | The module **never writes campaign time**. It reads TTA and Foundry world time; it never calls `advanceTime`, `game.time.advance` or similar. | Removes any possibility of a feedback loop with TTA's `timeChanged` hook or its in-flight guard, and keeps "who moved the date" answerable by one module. |
| D5 | All writes are GM-only in 1.0. Players view clocks they are allowed to see. A player-proposal relay (projects, corruption) is scheduled for 1.1 and will copy TTA's User-flag relay rather than a socket. | TTA's relay already documents why module sockets cannot authenticate a sender. Shipping the viewer first keeps 1.0 small. |
| D6 | Trigger evaluation runs on exactly one client, the **primary GM** (lowest id among active GMs, the same election TTA uses). Manual ticks may come from any GM. | Every trigger source (hooks, settings changes, world time) fires on every client; without an executor election each tick would be applied once per connected GM. |
| D7 | Storage follows TTA's privacy model: player-visible clocks in a world setting, GM-only clocks as flags on a journal entry nobody owns, actor-bound clocks (corruption) as flags on the actor. | World settings reach every client; document ownership is what Foundry actually enforces. Actor flags give per-player visibility for free through actor ownership. |
| D8 | Deadlines and "last processed" moments are stored as calendar dates `{year, month, day, hour, minute}`, never as absolute day numbers. | A GM can change TTA's month lengths after the fact; dates survive that, absolute-day offsets do not. |
| D9 | Rewinding campaign time never un-ticks a clock automatically. The GM is notified once, and may adjust manually. | A rewind is a deliberate correction in TTA (it confirms before moving). Silent un-ticking of a threat clock would be surprising and hard to audit. |

Assumptions to confirm with the owner before milestone M2: D2 (optional vs required), D5 (no player writes in 1.0), and whether chat cards default to on.

---

## 2. Scope: the eight clock kinds

Every clock is one record in a single schema (§4). A **kind** only sets defaults,
the editor's presets, and how the board draws and labels it. Nothing is a separate
subsystem, so a kind can be changed after creation.

| Kind | What it is | Defaults | Special behaviour |
|---|---|---|---|
| **Progress** | Blades-style pie, fills forward. | 4/6/8/12 segments, fill, stop when full. | None; the baseline. |
| **Countdown** | Pie that drains, or a deadline on a calendar date. | Drain, 6 segments, completion = empty. | May carry a `deadline`; with TTA the board shows "due 12 Ashfen 142, 07:00 (in 2 days)". |
| **Looming threat** | Progress clock with an escalation ladder. | 8 segments, thresholds at 2/4/6/8 with labels. | Crossing a threshold posts a chat card and fires `thresholdReached`. |
| **Faction progress** | Progress clock tagged to a faction group, optionally racing another clock. | 8 segments, group = faction name. | Board groups by faction; `linked` trigger lets one clock's completion reset or advance a rival. |
| **Corruption** | Per-character clock bound to an actor. | 6 segments, stored on the actor, visible to the actor's owners. | Thresholds carry GM-authored effect text; completion can be set to "stay full". |
| **Alarm** | Fires at a campaign moment or after elapsed time; no pie needed. | 0 segments, one-shot. | `date` or `time` trigger with `advance: complete`. Repeat option (every N days) for recurring alarms. |
| **Project** | Long-term work measured in rests or campaign days. | 8 segments, `rest` trigger +1, or `time` every 1 day. | Shows "N rests remaining". Player proposals come in 1.1. |
| **Weather front** | Repeating clock whose segments are named states. | 6 named segments ("Clear, Overcast, Rain, Storm, Clearing, Clear"), `time` every 6 h, repeat. | Board shows the current state as the headline; each change fires `weatherChanged` for other modules to react to. No scene automation in this module. |

### Not in 1.0

Player-initiated ticks, scene weather or lighting automation (left to companion
modules via the hooks in §8), per-token overlays, automatic effects on actors,
compendium packs, and any rules text from a published game.

---

## 3. Repository layout

Mirrors TTA so the two can share tooling and reviewers.

```
sargas-time-bomb/
├─ module.json
├─ package.json                 { "type": "module", "scripts": { "test": "node --test tests/*.test.js" } }
├─ README.md  CHANGELOG.md  LICENSE
├─ .gitignore
├─ .github/
│  ├─ workflows/ci.yml          npm test + node tools/check-manifest.mjs
│  ├─ workflows/release.yml     tag-driven; stamps version, reconciles CHANGELOG, zips, publishes
│  └─ scripts/release-changelog.mjs
├─ tools/check-manifest.mjs
├─ assets/icon.png  assets/cover.png      (linked by manifest `media`, not zipped)
├─ lang/en.json
├─ styles/sargas-time-bomb.css            (every rule under `.stb`; one sidebar button class outside it)
├─ templates/
│  ├─ board.hbs                           clock board window
│  ├─ clock-editor.hbs
│  ├─ partials/clock-card.hbs             one clock: pie, name, meta, GM controls
│  ├─ partials/clock-pie.hbs              SVG pie, reused by board and chat cards
│  ├─ partials/threshold-list.hbs
│  ├─ partials/trigger-list.hbs
│  └─ chat/clock-card.hbs                 chat message body
├─ scripts/
│  ├─ module.js                           init / setup / ready lifecycle
│  ├─ constants.js                        no Foundry globals; importable by tests
│  ├─ settings.js
│  ├─ hooks.js                            sidebar button, document and system hook wiring
│  ├─ api.js                              game.modules.get("sargas-time-bomb").api
│  ├─ compat.js                           t(), log(), html``, sanitizeHTML, rerenderModuleApps (copied from TTA)
│  ├─ applications/
│  │  ├─ board-app.js                     ApplicationV2 + HandlebarsApplicationMixin, id "stb-board"
│  │  └─ clock-editor-app.js
│  ├─ services/
│  │  ├─ clock-service.js                 pure: tick, drain, thresholds, completion, repeat, normalise
│  │  ├─ trigger-service.js               pure: given an event and a clock, how many segments move
│  │  ├─ schedule-service.js              pure: campaign-moment arithmetic, deadlines, elapsed buckets
│  │  ├─ validation-service.js            pure: bounds, trigger shapes, threshold order
│  │  ├─ migration-service.js             pure: schemaVersion upgrades
│  │  ├─ portability-service.js           pure: export/import envelope
│  │  ├─ store-service.js                 Foundry: world setting + GM-only entry + actor flags
│  │  ├─ dispatcher-service.js            Foundry: primary-GM election, event queue, serialised writes
│  │  ├─ time-source-service.js           Foundry: adapters for TTA and for world time (§6)
│  │  ├─ rest-service.js                  Foundry: system rest hooks + manual rest, debounced
│  │  ├─ chat-service.js                  Foundry: chat cards
│  │  └─ permission-service.js
│  └─ data/
│     └─ kinds.js                         per-kind defaults and presets
└─ tests/
   ├─ helpers/foundry-stub.js
   ├─ clock-service.test.js
   ├─ trigger-service.test.js
   ├─ schedule-service.test.js
   ├─ validation-service.test.js
   ├─ migration-service.test.js
   └─ portability-service.test.js
```

Rule carried over from TTA: `constants.js`, `data/`, and every `*-service.js`
marked *pure* must not touch Foundry globals at import time, so `node --test`
runs them with no runtime.

---

## 4. Data model

```js
// One clock. Stored in one of three places depending on `visibility` (§5).
{
  id: "k9Fh2...",                 // foundry.utils.randomID()
  schemaVersion: 1,
  kind: "progress",               // progress | countdown | threat | faction | corruption | alarm | project | weather
  name: "The Duke's patience",
  description: "",                // sanitised HTML, same policy as TTA notes
  color: "#8f3d2e", icon: "fa-solid fa-hourglass",
  group: "Crows",                 // free text; board groups by it (faction name, region, etc.)
  sortOrder: 0,

  segments: 8,                    // 0 allowed only for kind "alarm"
  filled: 3,
  direction: "fill",              // fill | drain
  segmentLabels: [],              // weather fronts: one label per segment
  thresholds: [                   // ordered, unique `at`
    { at: 4, label: "Patrols doubled", note: "" }
  ],
  onComplete: "stop",             // stop | reset | repeat | stayFull (corruption)
  completedAt: null,              // campaign moment or ISO string

  visibility: "gm-only",          // gm-only | players | actor-owners (corruption only)
  actorUuid: null,                // corruption: "Actor.abc123" or token actor uuid

  triggers: [                     // evaluated by trigger-service; empty = manual only
    { id, type: "scene", advance: 1, scenes: [] },                       // active scene changed (any, or listed ids)
    { id, type: "rest",  advance: 1 },                                   // §7
    { id, type: "time",  advance: 1, every: { days: 1 } },               // elapsed campaign time; needs a time source
    { id, type: "date",  advance: "complete", at: { year, month, day, hour, minute }, repeatEvery: null },
    { id, type: "hook",  advance: 1, hook: "deleteCombat" },             // curated list + free text
    { id, type: "linked", advance: 1, clockId: "...", when: "completed" } // or "threshold"
  ],
  // per-trigger bookkeeping so an elapsed-time rule accumulates across many small advances
  triggerState: { [triggerId]: { carrySeconds: 0, lastFiredAt: null } },

  log: [                          // capped at LOG_MAX (50), newest first
    { at: "2026-10-02T...", campaignMoment: { year, month, day, hour, minute } | null,
      userId, source: "manual|scene|rest|time|date|hook|linked|import", delta: +1, filled: 3 }
  ]
}
```

World-level record, kept beside the clocks:

```js
{ schemaVersion: 1, lastProcessedMoment: { year, month, day, hour, minute } | null,
  lastProcessedWorldTime: number | null }
```

Bounds (in `constants.js`, enforced by `validation-service`): segments 0–48,
thresholds ≤ 12, triggers ≤ 8 per clock, name ≤ 120, description ≤ 20 000,
clocks ≤ 500, log ≤ 50 entries, linked-trigger chain depth ≤ 5.

---

## 5. Storage and privacy

| Visibility | Where | Who receives it |
|---|---|---|
| `players` | world setting `sargas-time-bomb.clocks` (array) | every client |
| `gm-only` | `flags.sargas-time-bomb.clocks` on a journal entry **"Adventure Clocks (GM only)"** with `ownership.default = NONE`, in a module-managed "Adventure Clocks" folder | GMs only; the document never reaches a player |
| `actor-owners` | `flags.sargas-time-bomb.clocks` on the actor | whoever Foundry already sends the actor to |

`store-service` presents one `getClocks(user)` that merges what this client can
read, and one `saveClock` that routes by visibility. Revealing a clock moves it
between stores in a single operation; hiding moves it back. The ready hook
repairs the private entry's ownership on load, as TTA does.

Writes are serialised through `dispatcher-service` (one in-flight write at a
time, queued) because the shared array is one setting and the last write wins.
A trigger evaluation batches every affected clock plus the updated
`lastProcessedMoment` into one write, so a crash or re-render between them
cannot double-tick.

---

## 6. Through the Ages integration

### What TTA exposes today (v2.1.0)

- Hook `through-the-ages.timeChanged` with `{ date, time }` and
  `through-the-ages.dateChanged` with `date`. **Both fire only on the client
  that made the change**, because they come from `Hooks.callAll` inside
  `setCurrentDateTime`.
- World setting `through-the-ages.calendarData` holding `calendar.currentDate`,
  `calendar.currentTime`, `calendar.monthLengths`, `monthNames`, affixes, moons.
- API `game.modules.get("through-the-ages").api`: `getCalendar`,
  `getCurrentDate`, `getCurrentTime`, `formatDate`, `formatTime`,
  `utils.addDays`, `utils.dayKey`, `utils.parseKey`. Not exposed: `toAbsoluteDay`,
  `addSeconds`, an elapsed-seconds figure, or the reason for a change.
- TTA advances Foundry world time by the same elapsed seconds on every move, and
  warns when something else moves world time (combat rounds).

### Time source adapter (`time-source-service.js`)

One interface, two adapters, chosen by the setting **Time source**
(`auto` default: TTA when active, otherwise world time):

```
onElapsed(callback({ seconds, from: moment|null, to: moment|null, source }))
currentMoment()      -> { year, month, day, hour, minute } | null
formatMoment(m)      -> string
momentToSeconds(m)   -> number    (for deadline comparison)
```

**TTA adapter**

- Subscribes to the `updateSetting` document hook and reacts when
  `setting.key === "through-the-ages.calendarData"`. This fires on every client,
  so the primary GM sees changes made from any GM's window; the local
  `timeChanged` hook is also subscribed as a fast path and deduplicated by moment.
- Computes elapsed seconds as `momentToSeconds(new) - momentToSeconds(old)` where
  `old` is the stored `lastProcessedMoment` (not the previous hook payload), so a
  burst of advances or a missed event cannot lose time.
- `momentToSeconds` reads `calendar.monthLengths` from the API and sums them
  itself (about 10 lines). If a later TTA release exposes `utils.toAbsoluteDay`,
  the adapter prefers it.
- Negative elapsed time (a rewind) is reported to the GM once per rewind and
  skipped (D9); `lastProcessedMoment` is moved to the new moment so the next
  forward move measures from there.
- Ignores `updateWorldTime` entirely while TTA is the source, so a combat round
  never ticks an elapsed-time clock. A separate, explicit **`hook: combatRound`**
  trigger exists for GMs who want a per-round clock.

**World-time adapter** (TTA absent or disabled)

- Subscribes to `updateWorldTime`, elapsed = `worldTime - lastProcessedWorldTime`.
- `currentMoment()` returns null; `date` triggers are unavailable and the editor
  says why; alarms fall back to "after N seconds of world time".

### What the integration gives each feature

| Feature | With TTA | Without TTA |
|---|---|---|
| Elapsed-time triggers (`every 6 h`, `every 1 day`) | driven by calendar moves, including "next adventure day" and `+1 week` | driven by world-time seconds |
| Deadlines and alarms on a date | editor offers a calendar date picker; board shows `formatDate` output and "in N days" | hidden; the editor shows a one-line note recommending TTA |
| Weather fronts | advance per campaign hours/days; headline carries the campaign date | advance per world-time seconds |
| Audit log | each entry stamped with the campaign moment | entry stamped with world time |
| Catch-up when no GM was online | the first GM to connect evaluates the span from `lastProcessedMoment` to now and posts one summary card | same, from `lastProcessedWorldTime` |

### Recommended companion changes in TTA (optional, backward compatible, v2.2)

These are not needed for 1.0 of this module, but each removes a workaround:

1. Add `elapsedSeconds` and `reason` (`"advance" | "set" | "nextAdventureDay"`) to
   the `timeChanged` payload. Lets a project clock treat *next adventure day* as a
   rest without this module guessing from a 07:00 timestamp.
2. Expose `utils.toAbsoluteDay`, `utils.fromAbsoluteDay` and `utils.addSeconds`.
3. Emit `through-the-ages.calendarConfigured` after a configuration save so this
   module can revalidate stored deadlines against the new month lengths.

---

## 7. Trigger sources and how each is wired

| Trigger | Signal | Executor | Notes |
|---|---|---|---|
| `manual` | board buttons, API | any GM | always available; `+N`/`−N`, set exact, reset, complete |
| `scene` | `updateScene` where `changes.active === true` (default) or `canvasReady` (option "when the GM views a scene") | primary GM | optional list of scene ids; "any scene" by default; same-scene re-activation does not count |
| `rest` | system hooks when present: `pf2e.restForTheNight`, `dnd5e.restCompleted` (v3+), `dnd5e.longRest` / `dnd5e.shortRest` (older); plus the module's own **Declare rest** button and `api.declareRest({ kind: "long" })`, which fire `sargas-time-bomb.rest` | primary GM | per-actor hooks (dnd5e) are **debounced into one rest** within a configurable window (default 5 s); the signature of each system hook is verified against the installed system before relying on it, with a logged warning and no tick if the shape is unexpected |
| `time` | time-source adapter (§6) | primary GM | `every: { hours \| days \| weeks }`; carries remainder seconds in `triggerState` so 3 × 8 h = 1 day exactly |
| `date` | time-source adapter | primary GM | fires once when `currentMoment >= at`; `repeatEvery` re-arms it |
| `hook` | curated list (`combatRound`, `combatStart`, `deleteCombat`, `createChatMessage` filtered to rolls, `pauseGame`) plus free text for any Foundry or module hook | primary GM | free-text hooks are registered lazily and listed in a GM settings panel so they can be audited and removed |
| `linked` | `sargas-time-bomb.clockCompleted` / `thresholdReached` from another clock | primary GM | depth-limited (5) and cycle-checked at save time |

Every evaluation goes through `trigger-service.evaluate(clock, event) -> delta`,
a pure function with tests; `dispatcher-service` only collects events, elects
the executor, calls the pure function, and writes once.

---

## 8. Public surface

### Settings (`game.settings`, all localised)

| Key | Scope | Default | Purpose |
|---|---|---|---|
| `clocks` | world, hidden | `[]` | player-visible clocks |
| `state` | world, hidden | `{}` | `lastProcessedMoment`, `lastProcessedWorldTime`, `schemaVersion` |
| `privateEntryId`, `folderId` | world, hidden | `""` | module-managed documents |
| `timeSource` | world | `auto` | `auto` / `through-the-ages` / `world-time` / `off` |
| `restDebounceSeconds` | world | `5` | §7 |
| `catchUpOnConnect` | world | `true` | evaluate missed time when the first GM connects |
| `chatCards` | world | `visible-only` | `off` / `visible-only` / `all` (GM-only clocks whisper to GMs) |
| `showBoardToPlayers` | world | `true` | whether the sidebar button appears for players |
| `playerBoardDensity` | client | `compact` | per-client display |
| `debugLogging` | client | `false` | same semantics as TTA |
| menu `boardMenu` | restricted | | opens the board; menu `hooksMenu` lists registered free-text hooks |

### Hooks emitted (for `sargas-visual-automation` and others)

- `sargas-time-bomb.clockAdvanced` `{ clock, delta, source, moment }`
- `sargas-time-bomb.thresholdReached` `{ clock, threshold, moment }`
- `sargas-time-bomb.clockCompleted` `{ clock, moment }`
- `sargas-time-bomb.weatherChanged` `{ clock, previousLabel, label, moment }`
- `sargas-time-bomb.rest` `{ kind, actors, source }`

### API (`game.modules.get("sargas-time-bomb").api`)

`openBoard`, `getClocks({ visible })`, `getClock(id)`, `createClock(data)`,
`updateClock(id, changes)`, `deleteClock(id)`, `advanceClock(id, delta, { source })`,
`setClock(id, filled)`, `resetClock(id)`, `completeClock(id)`, `revealClock(id)`,
`hideClock(id)`, `declareRest(options)`, `evaluateNow()`, `exportClocks()`,
`importClocks(json)`, `utils: { nextTrigger(clock), describeTrigger(trigger), momentToSeconds }`,
`applications: { BoardApp, ClockEditorApp }`, `MODULE_ID`.

### UI

- **Sidebar button** in the Journal directory header, next to TTA's Calendar
  button, using the same placement logic (`.header-actions, .action-buttons`
  then fallbacks). Visible to players only when `showBoardToPlayers` is on.
- **Clock board** (`stb-board`, resizable): grouped by `group`, filter by kind /
  visibility / actor, search; each card shows the SVG pie, name, current state or
  threshold reached, the next expected trigger in words ("advances at rest",
  "due in 2 days"), and GM controls `−1 +1 ⋯`. Drag an actor onto the board to
  create a corruption clock for it. Reveal/hide toggle. Expired alarms stay
  highlighted until dismissed.
- **Clock editor** (`stb-clock-editor`): kind presets, segments with live pie
  preview, thresholds list, triggers list with per-type sub-forms (date picker
  renders TTA month names), visibility, on-complete behaviour, rich-text
  description (ProseMirror with textarea fallback, as in TTA), the audit log.
- **Chat card**: pie, name, what changed, who or what caused it, campaign moment.

---

## 9. Milestones

Each milestone leaves a loadable module and a green `npm test`.

| M | Deliverable | Acceptance |
|---|---|---|
| **M0 Scaffold** | manifest, `module.js`, settings, `en.json`, CSS tokens, CI + release workflows, `check-manifest.mjs`, README skeleton | loads in v14.366 with no console errors; CI green on an empty test suite |
| **M1 Core model** | `constants`, `kinds`, `clock-service`, `validation-service`, `migration-service` with tests | tick/drain/complete/reset/repeat/stayFull, threshold crossing in both directions, normalisation of malformed input, limits enforced |
| **M2 Board + editor** | `store-service` (three stores, reveal/hide, ownership repair), `BoardApp`, `ClockEditorApp`, manual advance, chat cards, sidebar button | GM creates/edits/advances/reveals; a player sees only visible and actor-owned clocks and no controls; console on a player client shows no GM-only clock data |
| **M3 Triggers** | `dispatcher-service` (primary GM, queue), `trigger-service` + tests, `scene`, `rest` (system hooks + Declare rest + debounce), `hook`, `linked` | two connected GMs produce one tick per event; dnd5e-style per-actor rest fires once; linked chains stop at depth 5 |
| **M4 Time and TTA** | `schedule-service` + tests, `time-source-service` with both adapters, `time` and `date` triggers, alarms, weather fronts, catch-up, rewind handling, TTA-formatted dates in board and cards | TTA `+1 day` ticks a daily clock once and an 8 h clock three times; a combat round ticks nothing; rewind warns once; disabling TTA switches to world time without data loss |
| **M5 Kinds polish** | corruption on actors (drag-drop, token actors), projects ("N rests left"), faction grouping and racing clocks | per-actor visibility verified with a player client; unlinked token actors handled deliberately |
| **M6 Release 1.0.0** | export/import, README (GM and player workflows, permissions table, storage table), CHANGELOG, icon/cover, tag `v1.0.0` | manifest check passes; install from the release manifest URL works |

Follow-ups (1.1+): player proposals via a User-flag relay; pinned mini-panel of
visible clocks; token HUD badge for corruption; TTA companion changes from §6.

---

## 10. Testing

- **Unit (node --test, no Foundry)**: clock arithmetic; threshold detection
  including jumps over several thresholds in one tick; elapsed-time bucketing
  with carried remainders; deadline evaluation across month boundaries using a
  stubbed TTA calendar with uneven month lengths; negative deltas; migration from
  schema 0 to 1; export envelope refusal of newer versions.
- **Stubbed Foundry**: a `foundry-stub.js` modelled on TTA's, recording setting
  writes, hooks and notifications, used to test the dispatcher's single-write
  guarantee and primary-GM election.
- **Manual checklist** (documented in README under Development): two GM clients;
  one player client; TTA enabled, disabled, and absent; module disable/re-enable;
  repeated execution for duplicate buttons, hooks or flags; GM-only entry
  ownership tampered from the sidebar and repaired on load.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| System rest hook signatures differ between system versions | feature-detect and verify payload shape; log and skip rather than tick; the manual **Declare rest** path always works |
| Double ticks with several GMs | primary-GM election plus one batched write per evaluation with the processed moment inside it |
| TTA calendar reconfiguration moves deadlines | dates stored as calendar dates; revalidation on `updateSetting` for `calendarData` when month count or lengths change; invalid deadlines flagged on the board rather than fired |
| Combat rounds advancing world time | ignored while TTA is the source; explicit `combatRound` hook trigger for those who want it |
| Free-text hook names typed wrongly or maliciously | GM-only, listed in a settings panel, registered lazily, never evaluated as code |
| World-setting growth (500 clocks × 50 log entries) | caps in constants; the log trims on write; board renders lazily by group |
