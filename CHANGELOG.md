# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
