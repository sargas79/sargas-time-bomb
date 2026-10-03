/**
 * The clock board: grouped cards, filters, GM controls, drag-drop actor to
 * create a corruption clock, export/import.
 */
import { APP_IDS, KINDS, MODULE_ID, SETTINGS, VISIBILITY, VISIBILITIES } from "../constants.js";
import { enrich } from "../compat.js";
import { getDialogV2, getSetting, isGM, moduleVersion, notify, randomID, rerenderModuleApps, t } from "../compat.js";
import { createClock, isComplete, lastChange, nextLabel, reachedThreshold } from "../services/clock-service.js";
import { validateClock } from "../services/validation-service.js";
import { everyText } from "../ui/describe.js";
import * as dispatcher from "../services/dispatcher-service.js";
import { exportEnvelope, parseImport } from "../services/portability-service.js";
import { canView } from "../services/permission-service.js";
import { declareRest } from "../services/rest-service.js";
import * as store from "../services/store-service.js";
import { formatMoment, timeInfo, TTASource } from "../services/time-source-service.js";
import { renderPie } from "../ui/pie.js";
import { nextText, stateText, visibilityText } from "../ui/describe.js";
import { ClockEditorApp } from "./clock-editor-app.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class BoardApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_IDS.board,
    classes: ["stb", "stb-board"],
    tag: "div",
    window: {
      title: "STB.Board.title",
      icon: "fa-solid fa-clock",
      resizable: true,
      contentClasses: ["stb-board__content"]
    },
    position: { width: 780, height: 640 },
    actions: {
      create: BoardApp.#onCreate,
      edit: BoardApp.#onEdit,
      delete: BoardApp.#onDelete,
      advance: BoardApp.#onAdvance,
      retreat: BoardApp.#onRetreat,
      setExact: BoardApp.#onSetExact,
      reset: BoardApp.#onReset,
      complete: BoardApp.#onComplete,
      reveal: BoardApp.#onReveal,
      hide: BoardApp.#onHide,
      dismiss: BoardApp.#onDismiss,
      declareRest: BoardApp.#onDeclareRest,
      evaluateNow: BoardApp.#onEvaluateNow,
      exportClocks: BoardApp.#onExport,
      importClocks: BoardApp.#onImport,
      toggleGroup: BoardApp.#onToggleGroup,
      clearFilters: BoardApp.#onClearFilters,
      toggleCompleted: BoardApp.#onToggleCompleted,
      openActor: BoardApp.#onOpenActor,
      setState: BoardApp.#onSetState,
      createRacingPair: BoardApp.#onCreateRacingPair
    }
  };

  static PARTS = {
    board: { template: `modules/${MODULE_ID}/templates/board.hbs`, scrollable: [".stb-board__groups"] }
  };

  #filters = { search: "", kind: "", visibility: "", actor: "", showCompleted: true };
  #collapsed = new Set((() => { try { return getSetting(SETTINGS.collapsedGroups) ?? []; } catch { return []; } })());
  #searchTimer = null;

  static #instance = null;
  static open() {
    if (!BoardApp.#instance) BoardApp.#instance = new BoardApp();
    BoardApp.#instance.render({ force: true });
    return BoardApp.#instance;
  }
  static get instance() { return BoardApp.#instance; }

  /* ---------------------------------------------------------------- */

  async _prepareContext() {
    const gm = isGM();
    const info = timeInfo();
    const all = store.getAllClocks().filter(c => canView(c));
    const f = this.#filters;
    const search = f.search.trim().toLowerCase();
    const filtered = all.filter(c => {
      if (f.kind && c.kind !== f.kind) return false;
      if (f.visibility && c.visibility !== f.visibility) return false;
      if (f.actor && c.actorUuid !== f.actor) return false;
      if (!f.showCompleted && isComplete(c) && !c.triggers?.length) return false;
      if (search && !(`${c.name} ${c.group} ${c.description}`.toLowerCase().includes(search))) return false;
      return true;
    });

    const groups = new Map();
    for (const c of filtered) {
      const key = c.group || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(await this.#cardContext(c, all, info, gm));
    }
    const groupList = [...groups.entries()]
      .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map(([name, cards]) => ({
        name: name || t("Board.ungrouped"),
        key: name || "__ungrouped",
        collapsed: this.#collapsed.has(name || "__ungrouped"),
        cards,
        count: cards.length
      }));

    const actors = [...new Map(all.filter(c => c.actorUuid).map(c => [c.actorUuid, c])).values()]
      .map(c => ({ uuid: c.actorUuid, name: store.resolveActor(c.actorUuid)?.name ?? c.actorUuid }));

    let density = "compact";
    try { density = getSetting(SETTINGS.playerBoardDensity) ?? "compact"; } catch { /* ignore */ }

    return {
      isGM: gm,
      density,
      groups: groupList,
      total: all.length,
      shown: filtered.length,
      filters: f,
      kinds: KINDS.map(k => ({ value: k, label: t(`Kind.${k}`), selected: f.kind === k })),
      visibilities: VISIBILITIES.map(v => ({ value: v, label: t(`Visibility.${v}`), selected: f.visibility === v })),
      actors,
      hasFilters: !!(f.search || f.kind || f.visibility || f.actor || !f.showCompleted),
      time: {
        sourceId: info.sourceId,
        sourceLabel: t(`Settings.timeSource.${info.sourceId}`),
        now: info.moment ? formatMoment(info.moment) : null,
        worldTime: info.worldTime,
        hasCalendar: info.hasCalendar,
        ttaMissing: !TTASource.isActive
      },
      isPrimaryGM: dispatcher.isPrimaryGM(),
      primaryGMName: globalThis.game.users.get(dispatcher.primaryGMId() ?? "")?.name ?? null
    };
  }

  async #cardContext(clock, all, info, gm) {
    const complete = isComplete(clock);
    const actor = clock.actorUuid ? store.resolveActor(clock.actorUuid) : null;
    const threshold = reachedThreshold(clock);
    const effectLink = threshold?.effectUuid ? await enrich(`@UUID[${threshold.effectUuid}]`) : null;
    const last = lastChange(clock);
    const lastChangeText = last ? t("Board.lastChanged", {
      when: last.campaignMoment ? formatMoment(last.campaignMoment) : new Date(last.at).toLocaleString(),
      source: t(`Source.${last.source}`),
      user: last.userId ? (globalThis.game.users.get(last.userId)?.name ?? "—") : "—"
    }) : null;
    const owner = clock.ownerUserId ? globalThis.game.users.get(clock.ownerUserId) : null;
    return {
      effectLink,
      thresholdNote: threshold?.note || null,
      lastChangeText,
      nextLabel: nextLabel(clock),
      hasLabels: !!clock.segmentLabels?.length,
      ownerName: owner?.name ?? null,
      actorMissing: !!clock.actorUuid && !actor,
      clock,
      id: clock.id,
      name: clock.name,
      icon: clock.icon,
      color: clock.color,
      kind: clock.kind,
      kindLabel: t(`Kind.${clock.kind}`),
      pie: renderPie(clock, { size: 88 }),
      state: stateText(clock),
      next: nextText(clock, { clocks: all, info }),
      visibility: visibilityText(clock),
      visibilityKey: clock.visibility,
      isGMOnly: clock.visibility === VISIBILITY.GM_ONLY,
      isPlayers: clock.visibility === VISIBILITY.PLAYERS,
      isActor: clock.visibility === VISIBILITY.ACTOR_OWNERS,
      actorName: actor?.name ?? null,
      actorUuid: clock.actorUuid,
      complete,
      expired: clock.kind === "alarm" && complete && !clock.dismissed,
      canControl: gm,
      canAdvance: gm && !complete,
      canRetreat: gm && (clock.direction === "drain" ? clock.filled < clock.segments : clock.filled > 0),
      isAlarm: clock.kind === "alarm",
      description: clock.description,
      triggerCount: clock.triggers?.length ?? 0,
      completedAt: typeof clock.completedAt === "object" && clock.completedAt ? formatMoment(clock.completedAt) : clock.completedAt
    };
  }

  /* ---------------------------------------------------------------- */

  _attachPartListeners(partId, el, options) {
    super._attachPartListeners?.(partId, el, options);
    const search = el.querySelector("[data-filter='search']");
    search?.addEventListener("input", ev => {
      clearTimeout(this.#searchTimer);
      const value = ev.target.value;
      this.#searchTimer = setTimeout(() => { this.#filters.search = value; this.render(); }, 250);
    });
    for (const sel of el.querySelectorAll("select[data-filter]")) {
      sel.addEventListener("change", ev => { this.#filters[ev.target.dataset.filter] = ev.target.value; this.render(); });
    }
    if (isGM()) {
      el.addEventListener("dragover", ev => { ev.preventDefault(); el.classList.add("is-dragover"); });
      el.addEventListener("dragleave", () => el.classList.remove("is-dragover"));
      el.addEventListener("drop", ev => this.#onDrop(ev));
    }
  }

  async #onDrop(event) {
    event.preventDefault();
    this.element.querySelector(".is-dragover")?.classList.remove("is-dragover");
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    let data = null;
    try { data = TE.getDragEventData(event); } catch { return; }
    if (data?.type !== "Actor" || !data.uuid) return;
    const actor = store.resolveActor(data.uuid);
    if (!actor) return;
    if (!store.isBindableActor(actor)) { notify("warn", t("Notify.actorTypeRefused", { name: actor.name, type: actor.type })); return; }
    if (!actor.isToken && !data.uuid.startsWith("Actor.") && actor.uuid) data.uuid = actor.uuid;
    const existing = store.getAllClocks().find(c => c.kind === "corruption" && c.actorUuid === data.uuid);
    if (existing) {
      notify("info", t("Notify.corruptionExists", { name: actor.name }));
      new ClockEditorApp({ clock: existing }).render({ force: true });
      return;
    }
    new ClockEditorApp({
      initial: {
        kind: "corruption",
        name: t("Board.corruptionName", { name: actor.name }),
        actorUuid: data.uuid,
        visibility: VISIBILITY.ACTOR_OWNERS,
        group: actor.isToken ? t("Board.tokenActors") : ""
      }
    }).render({ force: true });
  }

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  static #clockId(target) {
    return target.closest("[data-clock-id]")?.dataset.clockId;
  }

  static #onCreate(event, target) {
    const kind = target.dataset.kind || "progress";
    new ClockEditorApp({ initial: { kind } }).render({ force: true });
  }

  static #onEdit(event, target) {
    const clock = store.getClock(BoardApp.#clockId(target));
    if (!clock) return;
    if (!isGM()) { new ClockEditorApp({ clock, readonly: true }).render({ force: true }); return; }
    new ClockEditorApp({ clock }).render({ force: true });
  }

  static async #onDelete(event, target) {
    const clock = store.getClock(BoardApp.#clockId(target));
    if (!clock) return;
    const Dialog = getDialogV2();
    const ok = Dialog
      ? await Dialog.confirm({ window: { title: t("Board.deleteTitle") }, content: `<p>${t("Board.deleteConfirm", { name: foundry.utils.escapeHTML(clock.name) })}</p>`, rejectClose: false, modal: true })
      : confirm(t("Board.deleteConfirm", { name: clock.name }));
    if (!ok) return;
    await dispatcher.deleteClock(clock.id);
    rerenderModuleApps();
  }

  static async #onAdvance(event, target) {
    const n = Number(target.dataset.delta) || 1;
    await dispatcher.manual(BoardApp.#clockId(target), "delta", n);
  }

  static async #onRetreat(event, target) {
    const n = Number(target.dataset.delta) || 1;
    await dispatcher.manual(BoardApp.#clockId(target), "delta", -n);
  }

  static async #onSetExact(event, target) {
    const clock = store.getClock(BoardApp.#clockId(target));
    if (!clock || clock.kind === "alarm") return;
    const Dialog = getDialogV2();
    if (!Dialog) return;
    const value = await Dialog.prompt({
      window: { title: t("Board.setExactTitle") },
      content: `<div class="stb form-group"><label>${t("Board.setExactLabel", { segments: clock.segments })}</label><input type="number" name="filled" min="0" max="${clock.segments}" value="${clock.filled}" autofocus></div>`,
      ok: { label: t("Board.apply"), callback: (ev, button) => Number(button.form.elements.filled.value) },
      rejectClose: false,
      modal: true
    });
    if (value === null || value === undefined || Number.isNaN(value)) return;
    await dispatcher.manual(clock.id, "set", value);
  }

  static async #onReset(event, target) {
    await dispatcher.manual(BoardApp.#clockId(target), "reset");
  }

  static async #onComplete(event, target) {
    await dispatcher.manual(BoardApp.#clockId(target), "complete");
  }

  static async #onDismiss(event, target) {
    await dispatcher.manual(BoardApp.#clockId(target), "dismiss");
  }

  static async #onReveal(event, target) {
    const clock = store.getClock(BoardApp.#clockId(target));
    if (!clock) return;
    await dispatcher.saveClock({ ...clock, visibility: VISIBILITY.PLAYERS });
    rerenderModuleApps();
  }

  static async #onHide(event, target) {
    const clock = store.getClock(BoardApp.#clockId(target));
    if (!clock) return;
    await dispatcher.saveClock({ ...clock, visibility: VISIBILITY.GM_ONLY });
    rerenderModuleApps();
  }

  static async #onDeclareRest() {
    const actors = (globalThis.game.actors?.contents ?? []).filter(a => a.type === "character" && a.hasPlayerOwner).map(a => a.uuid);
    declareRest({ actors });
    notify("info", t("Notify.restDeclared", { n: actors.length }));
  }

  static async #onEvaluateNow() {
    const api = globalThis.game.modules.get(MODULE_ID)?.api;
    const result = await api?.evaluateNow();
    notify("info", t("Notify.evaluated", { n: result?.changed?.length ?? 0 }));
  }

  static #onExport() {
    const clocks = store.getAllClocks();
    const env = exportEnvelope(clocks, { moduleVersion: moduleVersion(), state: store.getState() });
    const name = `${MODULE_ID}-${new Date().toISOString().slice(0, 10)}.json`;
    foundry.utils.saveDataToFile(JSON.stringify(env, null, 2), "application/json", name);
  }

  static async #onImport() {
    const Dialog = getDialogV2();
    if (!Dialog) return;
    const content = `
      <div class="stb stb-import">
        <p class="hint">${t("Board.importHint")}</p>
        <div class="form-group"><label>${t("Board.importFile")}</label><input type="file" name="file" accept="application/json,.json"></div>
        <div class="form-group"><label>${t("Board.importText")}</label><textarea name="text" rows="6" placeholder="{ &quot;module&quot;: &quot;${MODULE_ID}&quot;, ... }"></textarea></div>
        <div class="form-group"><label class="checkbox"><input type="checkbox" name="keepIds"> ${t("Board.importKeepIds")}</label></div>
      </div>`;
    const payload = await Dialog.prompt({
      window: { title: t("Board.importTitle") },
      content,
      ok: {
        label: t("Board.importButton"),
        callback: async (ev, button) => {
          const form = button.form;
          const file = form.elements.file?.files?.[0];
          const text = file ? await file.text() : form.elements.text.value;
          return { text, keepIds: form.elements.keepIds.checked };
        }
      },
      rejectClose: false,
      modal: true
    });
    if (!payload?.text) return;
    const existing = store.getAllClocks();
    const info = timeInfo();
    const result = parseImport(payload.text, { regenerateIds: !payload.keepIds, existingClocks: existing, idGen: () => randomID(), calendar: info.calendar });
    if (!result.ok) {
      notify("error", t("Notify.importFailed", { reason: result.errors.map(e => t(`Error.${e.code}`, e.data)).join("; ") }));
      return;
    }
    if (result.clocks.length) {
      const now = new Date().toISOString();
      for (const c of result.clocks) { c.createdAt ??= now; c.updatedAt = now; }
      await store.writeBatch({ upsert: result.clocks });
    }
    notify("info", t("Notify.imported", { n: result.clocks.length, skipped: result.skipped.length }));
    rerenderModuleApps();
  }

  static #onToggleGroup(event, target) {
    const key = target.closest("[data-group]")?.dataset.group;
    if (!key) return;
    if (this.#collapsed.has(key)) this.#collapsed.delete(key); else this.#collapsed.add(key);
    try { globalThis.game.settings.set(MODULE_ID, SETTINGS.collapsedGroups, [...this.#collapsed]); } catch { /* client setting only */ }
    this.render();
  }

  static #onClearFilters() {
    this.#filters = { search: "", kind: "", visibility: "", actor: "", showCompleted: true };
    this.render();
  }

  static #onToggleCompleted() {
    this.#filters.showCompleted = !this.#filters.showCompleted;
    this.render();
  }

  static #onOpenActor(event, target) {
    const uuid = target.closest("[data-actor-uuid]")?.dataset.actorUuid;
    const actor = store.resolveActor(uuid);
    actor?.sheet?.render(true);
  }

  /** Pick a labelled state by name (weather fronts and other labelled clocks). */
  static async #onSetState(event, target) {
    const clock = store.getClock(BoardApp.#clockId(target));
    if (!clock?.segmentLabels?.length) return;
    const Dialog = getDialogV2();
    if (!Dialog) return;
    const current = clock.direction === "drain" ? clock.segments - clock.filled : clock.filled;
    const options = clock.segmentLabels.map((l, i) => `<option value="${i}" ${i === current ? "selected" : ""}>${foundry.utils.escapeHTML(l || String(i))}</option>`).join("");
    const idx = await Dialog.prompt({
      window: { title: t("Board.setStateTitle") },
      content: `<div class="stb form-group"><label>${t("Board.setStateLabel")}</label><select name="state" autofocus>${options}</select></div>`,
      ok: { label: t("Board.apply"), callback: (ev, button) => Number(button.form.elements.state.value) },
      rejectClose: false,
      modal: true
    });
    if (idx === null || idx === undefined || Number.isNaN(idx)) return;
    const filled = clock.direction === "drain" ? clock.segments - idx : idx;
    await dispatcher.manual(clock.id, "set", filled);
  }

  /** Two faction clocks linked both ways: when one completes, the other resets. */
  static async #onCreateRacingPair() {
    const Dialog = getDialogV2();
    if (!Dialog) return;
    const field = (name, label, value, type = "text", extra = "") => `<div class="form-group"><label>${label}</label><input type="${type}" name="${name}" value="${value}" ${extra}></div>`;
    const data = await Dialog.prompt({
      window: { title: t("Board.racingTitle") },
      content: `<div class="stb stb-import"><p class="hint">${t("Board.racingHint")}</p>
        ${field("a", t("Board.racingFirst"), t("Board.racingFirstDefault"))}
        ${field("b", t("Board.racingSecond"), t("Board.racingSecondDefault"))}
        ${field("segments", t("Editor.segments"), 8, "number", 'min="1" max="48"')}
        <div class="form-group"><label class="checkbox"><input type="checkbox" name="visible"> ${t("Board.racingVisible")}</label></div></div>`,
      ok: { label: t("Editor.create"), callback: (ev, button) => {
        const f = button.form.elements;
        return { a: f.a.value.trim(), b: f.b.value.trim(), segments: Number(f.segments.value) || 8, visible: f.visible.checked };
      } },
      rejectClose: false,
      modal: true
    });
    if (!data?.a || !data?.b) return;
    const visibility = data.visible ? VISIBILITY.PLAYERS : VISIBILITY.GM_ONLY;
    const idA = randomID(), idB = randomID();
    const mk = (id, name, group, rival) => createClock({
      id, kind: "faction", name: t("Board.racingName", { name }), group, segments: data.segments, visibility,
      triggers: [{ type: "linked", advance: "reset", clockId: rival, when: "completed" }]
    }, { idGen: () => randomID() });
    const a = mk(idA, data.a, data.a, idB);
    const b = mk(idB, data.b, data.b, idA);
    const all = [...store.getAllClocks(), a, b];
    for (const c of [a, b]) {
      const v = validateClock(c, { allClocks: all, isNew: true });
      if (!v.valid) { notify("error", t("Notify.invalid", { n: v.errors.length })); return; }
    }
    await store.writeBatch({ upsert: [a, b] });
    notify("info", t("Notify.racingCreated", { a: data.a, b: data.b }));
    rerenderModuleApps();
  }
}

/** Settings-menu shim: opens the singleton board instead of a new window. */
export class BoardMenu extends ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "stb-board-menu", classes: ["stb"] };
  async render() { BoardApp.open(); return this; }
}
