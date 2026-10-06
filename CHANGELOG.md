# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.4.0] - 2026-10-06

### Fixed
- Chat cards showed the clock's name and "3/6" as loose text where the pie
  belonged: Foundry strips inline SVG from stored chat content. The card now
  carries the clock snapshot in its message flag and draws the pie on render.
- The board's `⋯` menu item "Evaluate elapsed time now" wrapped onto two lines
  and spilled out of its button; menu items no longer wrap.
- Card titles were drawn in the theme's condensed heading font and cut to a
  few characters; they now use the body font, may take two lines, and the kind
  sits on its own caption line.
- The editor's inline rows (group, colour, icon; segments, filled, direction)
  stacked one field per line; "Add threshold" stretched to the full width; the
  description editor was an invisible box with a hidden edit toggle.
- Chat cards broke words mid-syllable ("Prog / ress", "manua / l") in a narrow
  chat column.
- The catch-up summary card named actor-bound (corruption) clocks in the public
  message; those clocks are now whispered to the GMs and the actor's owners.
- A repeating calendar-date trigger whose date lay years in the past re-armed
  one period per time step and over-ticked on the following steps; it now
  re-arms in one evaluation.
- A wrapping tick on a repeating clock skipped the thresholds it passed, so a
  linked "reaches a threshold" trigger on a weather front never fired on the
  wrap.
- A relayed rest is now checked on the primary GM: only bindable actors the
  relaying user owns count, and an empty relay moves nothing.
- A free-text hook trigger on a chat render hook could feed itself with the
  module's own cards; the module's documents are ignored by every hook trigger
  and the chat render hooks are refused outright.

### Changed
- Card controls: `−`, `+`, set exact, set state and dismiss stay on the card;
  complete, reset, reveal/hide and delete moved to a `⋯` menu with labels, so
  the row no longer wraps. Alarm cards no longer show a disabled `−`/`+`.
- Drop-down menus open on click and close on Escape as well as on hover.
- Real-world timestamps on cards, proposals and the audit log are shown without
  seconds.
- The export file holds clocks only; the world's "last processed" time marker
  is no longer written into it, and an older file's `state` block is ignored.
- The manifest check now verifies the i18n keys built at runtime (kinds,
  sources, settings choices, error and proposal codes).
- A GM is warned on load when stored clocks come from a newer schema than this
  version knows, since saving would downgrade them.

## [1.3.0] - 2026-10-03

### Added
- **Break timer**: from the board's `⋯` menu a GM starts a real-world countdown
  of 1–60 minutes (a lunch break, a pause). Every client shows it in a banner
  at the top of the screen and gets a notification and a chime when it ends. It
  follows the wall clock, survives reloads and never touches campaign time.
  API: `startBreak(minutes)`, `cancelBreak()`, `getBreak()`.

## [1.2.2] - 2026-10-03

### Fixed
- The clock editor failed to open ("Template part "form" must render a single
  HTML element"): its template rendered the scroll area and the footer as two
  root elements. The footer is now its own template part.

## [1.2.1] - 2026-10-03

### Fixed
- A burst of campaign-time changes (a double-clicked `+1 day`, or catch-up
  overlapping a settings update) could measure twice from the same "last
  processed" marker and over-tick elapsed-time clocks. The time handler now
  reads the marker and computes the span inside the write queue.
- A free-text hook trigger could name a document hook this module's own writes
  emit (`updateSetting`, `updateJournalEntry`, `updateUser`) and loop forever.
  Those names are refused, and a matched trigger that moves nothing and changes
  no bookkeeping is no longer written.
- A manual reset no longer re-arms a one-shot deadline whose date has passed,
  which fired it again on the next time step and completed the clock the GM had
  just reset.
- An approved note proposal now shows the note on the player's card instead of
  an empty card.

## [1.2.0] - 2026-10-03

### Added
- Rest triggers may opt in to Through the Ages' **Next adventure day** (its
  `timeChanged` reason, TTA 2.2+), so a project ticks when the party wakes
  even without Rest for the Night.
- After a structural calendar change (`calendarConfigured` with
  `structureChanged`), one GM warning names the clocks whose deadlines no
  longer exist.

### Changed
- Elapsed campaign time is measured with TTA's `campaignSeconds` when
  available, falling back to the local sum; the month-base guessing is gone
  (TTA dates are 1-based).

## [1.1.0] - 2026-10-03

### Added
- **Player proposals** (off by default, *Allow player proposals*): a player may
  propose +1 on a project they own or a note on their own corruption clock.
  The GM approves or rejects from a queue on the board; the player is told by
  whisper. Requests travel on the proposing user's own User document, through
  Through the Ages' relay when it is active or an equivalent built-in
  transport otherwise. Never a module socket.

## [1.0.1] - 2026-10-03

### Added
- Board cards show when a clock last changed, by what and by whom; labelled
  clocks preview the next state and offer a "set state by name" picker; a
  clock whose actor is gone says so.
- Faction clocks require a group; a "Racing pair" action creates two faction
  clocks linked both ways with reset. Reset links no longer count as cycles.
- Projects may name an owner user (display only) and show "N days remaining"
  when driven by elapsed days.
- Time and date triggers show as paused while the time source is off, and
  elapsed-time triggers say "(world time)" when no calendar is active.
- Group collapse state on the board is remembered per client.
- Validation checks the bound actor's type when it can be resolved.
- `check-manifest` also checks the package version, the download URL version
  and the presence of the icon and cover. README gains a Troubleshooting section.

### Changed
- The "Clock board" settings menu is GM-only, as the plan specifies; players
  keep the sidebar button.

## [1.0.0] - 2026-10-03

### Added
- Eight clock kinds on one schema: progress, countdown, looming threat, faction
  progress, corruption, alarm, project and weather front.
- Clock board with grouping, filters, search, GM controls, reveal/hide,
  drag-an-actor-to-create-corruption, export and import.
- Clock editor with kind presets, live pie preview, thresholds, per-type trigger
  sub-forms, visibility, completion behaviour, rich description and audit log.
- PF2e only (Remaster): declared under `relationships.systems`; no rules
  automation. Thresholds may link a PF2e condition or effect for the GM to
  apply by hand.
- Triggers: manual, scene change, rest (`pf2e.restForTheNight` debounced into
  one party rest, and "Declare rest"), elapsed campaign time, calendar date
  (with repeat), curated Foundry and PF2e hooks plus free-text hooks, and
  linked clocks (depth-limited, cycle-checked).
- Repeating clocks never rest at full: the last segment completes a cycle and
  wraps to the start in the same write. Alarms are one segment drawn as a badge.
- Through the Ages integration as the preferred time source, with a Foundry
  world-time fallback; catch-up when the first GM connects; rewind notice.
- Primary-GM executor election and one batched write per evaluation.
- Storage matching the privacy model: world setting for player-visible clocks,
  a GM-only journal entry (ownership repaired on load) for GM-only and
  actor-bound clocks, and read-only owner mirror entries per actor so owners
  see their corruption clocks without being able to edit them.
- Chat cards, emitted hooks for companion modules, and a public API.
- Unit tests for the pure services and a stubbed-Foundry test for the
  dispatcher's single-write guarantee and executor election.
