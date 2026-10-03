# Sargas Time Bomb — Adventure Clock System

A Foundry VTT v14 module that adds **progress clocks, countdowns, looming
threats, faction progress, corruption, alarms, projects and weather fronts**,
and advances them manually, on scene change, at rest, on elapsed campaign time,
on calendar deadlines, or after configurable Foundry events.

It is designed as a companion to **[Through the Ages](https://github.com/sargas79/through-the-ages)**
(`through-the-ages`), which supplies the campaign calendar and clock. It still
works in a world that does not run it: elapsed-time triggers fall back to
Foundry world time and calendar-dated features degrade cleanly.

- System-agnostic, no game mechanics, no rules text.
- Never writes campaign time. It only reads it.
- All writes are GM-only. Players see the clocks they are allowed to see.

## Installation

Paste the manifest URL into Foundry's **Install Module** dialog:

```
https://github.com/sargas79/sargas-time-bomb/releases/latest/download/module.json
```

Requires Foundry VTT **14.366** or later. Through the Ages 2.1.0+ is recommended
but optional.

## The eight kinds

Every clock shares one schema. A kind only sets defaults and how the board draws
it, so a clock's kind can be changed after creation.

| Kind | What it is | Defaults |
|---|---|---|
| **Progress** | Blades-style pie that fills forward. | 6 segments, stop when full |
| **Countdown** | Pie that drains, or a deadline on a calendar date. | 6 segments, drain |
| **Looming threat** | Progress clock with an escalation ladder. Crossing a threshold posts a card. | 8 segments, thresholds at 2/4/6/8 |
| **Faction progress** | Progress clock tagged to a faction; link it to a rival to race. | 8 segments |
| **Corruption** | Per-character clock stored on the actor, visible to its owners. | 6 segments, stays full |
| **Alarm** | Fires at a campaign moment or after elapsed time. No pie. | 0 segments, one-shot or repeating |
| **Project** | Long-term work measured in rests or campaign days. | 8 segments, +1 per rest |
| **Weather front** | Repeating clock whose segments are named states. | 6 named states, every 6 h, repeats |

## GM workflow

1. Open the board from the **Clocks** button in the Journal sidebar (next to
   Through the Ages' Calendar button), or from **Module Settings → Clock board**.
2. **New clock** opens the editor. Pick a kind, segments, thresholds and
   triggers. Leave triggers empty for a manual clock.
3. Use `−` / `+` on a card, or the `#` button to set an exact value. Reset,
   complete, reveal and hide are one click each.
4. Drop an **actor** onto the board to create a corruption clock bound to it.
5. **Declare rest** (long or short) from the board's `⋯` menu when your system
   does not report rests, or when you want to count one anyway.
6. **Export / Import** from the same menu. Imports get fresh ids and linked
   triggers inside the file are remapped.

## Player workflow

Players see the **Clocks** button if the GM leaves *Show board button to
players* on. Their board lists clocks with visibility **Players**, plus
**Actor owners** clocks for actors they own. There are no controls; opening a
card shows a read-only view.

## Triggers

| Trigger | Fires when | Notes |
|---|---|---|
| Manual | A GM clicks or calls the API | Always available |
| Scene change | A scene is activated (or, by setting, viewed by the GM) | Optionally limited to listed scenes; re-activating the same scene does not count |
| Rest | `pf2e.restForTheNight`, `dnd5e.restCompleted`/`longRest`/`shortRest`, rest chat messages, or **Declare rest** | Per-actor system hooks are folded into one rest within the debounce window |
| Elapsed time | Campaign time advances by the period (hours / days / weeks) | Remainders carry over, so 3 × 8 h = exactly 1 day |
| Calendar date | The campaign moment reaches a date | Needs a calendar time source; may repeat every N hours/days/weeks |
| Foundry hook | A curated hook (`combatRound`, `combatStart`, `deleteCombat`, dice roll posted, `pauseGame`) or any free-text hook | Free-text hooks are listed under **Module Settings → Registered hooks** |
| Linked clock | Another clock completes or reaches a threshold | Chains are limited to 5 clocks deep and checked for cycles on save |

Each trigger either **advances** the clock by N (negative allowed), **completes**
it, or **resets** it.

### Who evaluates triggers

Every trigger source fires on every connected client. To avoid one tick per
GM, triggers are evaluated by exactly one client: the **primary GM** (lowest
user id among connected GMs). The board shows who that is. Manual ticks and
declared rests run on the acting GM's client. When the primary GM disconnects,
the next GM takes over and catches up.

## Through the Ages integration

| Feature | With Through the Ages | Without |
|---|---|---|
| Elapsed-time triggers | Driven by calendar moves, including "next adventure day" and `+1 week` | Driven by world-time seconds |
| Deadlines and alarms on a date | Date picker with month names; board shows the formatted date and "in N days" | Hidden; the editor explains why |
| Weather fronts | Advance per campaign hours/days | Advance per world-time seconds |
| Audit log | Stamped with the campaign moment | Stamped with world time |
| Catch-up | First GM to connect evaluates from the last processed moment | Same, from the last processed world time |

The module measures elapsed time from its own stored *last processed moment*,
not from the previous event, so bursts of advances and missed events cannot
lose time. While Through the Ages is the source, Foundry world-time changes
(e.g. combat rounds) are ignored; use the explicit **Combat round** hook
trigger if you want a per-round clock. A rewind of campaign time never
un-ticks a clock: the GM is told once and may adjust manually.

## Permissions

| Action | GM | Player |
|---|---|---|
| View clocks with visibility *Players* | ✓ | ✓ |
| View *Actor owners* clocks | ✓ | owners of that actor |
| View *GM only* clocks | ✓ | — |
| Create, edit, delete, advance, reveal, hide, import | ✓ | — |
| Export | all clocks | visible clocks only |

## Storage

| Visibility | Where | Who receives it |
|---|---|---|
| Players | World setting `sargas-time-bomb.clocks` | Every client |
| GM only | Flags on the journal entry **"Adventure Clocks (GM only)"** (ownership *None*, in the "Adventure Clocks" folder) | GMs only; the document never reaches a player |
| Actor owners | Flags on the actor | Whoever Foundry already sends the actor to |

The private entry's ownership is repaired on load if it was changed. Deadlines
and processed moments are stored as calendar dates, so changing month lengths
later does not shift them. Limits: 500 clocks, 48 segments, 12 thresholds and 8
triggers per clock, a 50-entry audit log per clock.

## Settings

| Setting | Scope | Default |
|---|---|---|
| Time source | world | Automatic (Through the Ages when active, else world time) |
| Scene triggers fire when | world | A scene is activated |
| Rest debounce (seconds) | world | 5 |
| Catch up on connect | world | on |
| Chat cards | world | Player-visible clocks only |
| Show board button to players | world | on |
| Board density | client | Compact |
| Debug logging | client | off |

## Hooks emitted

For companion modules (scene weather, lighting, token overlays, …):

```
sargas-time-bomb.clockAdvanced     { clock, delta, source, moment }
sargas-time-bomb.thresholdReached  { clock, threshold, moment }
sargas-time-bomb.clockCompleted    { clock, moment }
sargas-time-bomb.weatherChanged    { clock, previousLabel, label, moment }
sargas-time-bomb.rest              { kind, actors, source }
sargas-time-bomb.ready             api
```

## API

`game.modules.get("sargas-time-bomb").api`

```js
openBoard(); openEditor(id);
getClocks({ visible }); getClock(id);
createClock(data); updateClock(id, changes); deleteClock(id);
advanceClock(id, delta, { source }); setClock(id, filled); resetClock(id); completeClock(id); dismissClock(id);
revealClock(id); hideClock(id);
declareRest({ kind: "long" | "short" });
evaluateNow();                       // catch up elapsed time (primary GM)
exportClocks(); importClocks(json);
utils: { nextTrigger(clock), describeTrigger(trigger), momentToSeconds(moment), formatMoment(moment), timeInfo() }
applications: { BoardApp, ClockEditorApp }
```

Example: a daily weather front that players can see.

```js
await game.modules.get("sargas-time-bomb").api.createClock({
  kind: "weather", name: "Coastal front", visibility: "players",
  segmentLabels: ["Clear", "Overcast", "Rain", "Storm", "Clearing", "Clear"],
  triggers: [{ type: "time", advance: 1, every: { hours: 6 } }]
});
```

## Development

```
npm test          # node --test over the pure services and the stubbed dispatcher
npm run check     # manifest, i18n keys, template references, import hygiene
```

`scripts/constants.js`, `scripts/data/` and every service marked *pure* must not
touch Foundry globals at import time; the checker imports them under plain Node.

### Manual checklist

- Two GM clients: one tick per scene change, rest and time advance; the board
  names the primary GM; disconnecting the primary hands over and catches up.
- One player client: sees only *Players* and owned-actor clocks, no controls,
  and the console shows no GM-only clock data.
- Through the Ages enabled, disabled and absent: `+1 day` ticks a daily clock
  once and an 8 h clock three times; a combat round ticks nothing; disabling
  TTA switches to world time without losing data; rewind warns once.
- Module disable/re-enable: no duplicate sidebar buttons, hooks or flags.
- GM-only entry ownership changed from the sidebar is repaired on load.

### Releasing

Tag `vX.Y.Z`. The release workflow runs the tests, stamps the version into
`module.json`, reconciles `CHANGELOG.md`, zips the module and publishes the
release with `module.json` and `sargas-time-bomb.zip` attached.

## License

MIT © 2026 Diego Vescovini
