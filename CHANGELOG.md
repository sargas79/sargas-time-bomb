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
- Triggers: manual, scene change, rest (system hooks, chat detection and
  "Declare rest"), elapsed campaign time, calendar date (with repeat), curated
  and free-text Foundry hooks, and linked clocks (depth-limited, cycle-checked).
- Through the Ages integration as the preferred time source, with a Foundry
  world-time fallback; catch-up when the first GM connects; rewind notice.
- Primary-GM executor election and one batched write per evaluation.
- Three storage locations matching the privacy model: world setting, GM-only
  journal entry with ownership repaired on load, and actor flags.
- Chat cards, emitted hooks for companion modules, and a public API.
- Unit tests for the pure services and a stubbed-Foundry test for the
  dispatcher's single-write guarantee and executor election.
