/**
 * Clock editor: kind presets, segments with live pie preview, thresholds,
 * triggers with per-type sub-forms, visibility, completion behaviour,
 * description and the audit log.
 */
import {
  APP_IDS, CURATED_HOOKS, DIRECTIONS, EVERY_UNITS, KINDS, LIMITS, LINK_WHEN, MODULE_ID, ON_COMPLETE,
  TRIGGER_TYPES, VISIBILITIES, VISIBILITY
} from "../constants.js";
import { enrich, getFormDataExtended, isGM, notify, randomID, rerenderModuleApps, sanitizeHTML, t } from "../compat.js";
import { changeKind, createClock, normalizeClock, normalizeTrigger } from "../services/clock-service.js";
import { kindDefaults } from "../data/kinds.js";
import * as dispatcher from "../services/dispatcher-service.js";
import * as store from "../services/store-service.js";
import { formatMoment, timeInfo, TTASource } from "../services/time-source-service.js";
import { validateClock } from "../services/validation-service.js";
import { renderPie } from "../ui/pie.js";
import { triggerText } from "../ui/describe.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function toArray(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  return Object.keys(obj).sort((a, b) => Number(a) - Number(b)).map(k => obj[k]);
}

function asList(v) {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v.filter(x => x !== "") : [v];
}

export class ClockEditorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["stb", "stb-editor"],
    tag: "form",
    window: { title: "STB.Editor.title", icon: "fa-solid fa-pen-to-square", resizable: true, contentClasses: ["stb-editor__content"] },
    position: { width: 640, height: "auto" },
    form: { handler: ClockEditorApp.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      setKind: ClockEditorApp.#onSetKind,
      setSegments: ClockEditorApp.#onSetSegments,
      addThreshold: ClockEditorApp.#onAddThreshold,
      removeThreshold: ClockEditorApp.#onRemoveThreshold,
      addTrigger: ClockEditorApp.#onAddTrigger,
      removeTrigger: ClockEditorApp.#onRemoveTrigger,
      clearActor: ClockEditorApp.#onClearActor,
      clearEffect: ClockEditorApp.#onClearEffect,
      fillLabels: ClockEditorApp.#onFillLabels,
      toggleLog: ClockEditorApp.#onToggleLog,
      cancel: ClockEditorApp.#onCancel
    }
  };

  static PARTS = {
    // Each part must render exactly one root element, so the footer is its own part.
    form: { template: `modules/${MODULE_ID}/templates/clock-editor.hbs`, scrollable: [""] },
    footer: { template: `modules/${MODULE_ID}/templates/clock-editor-footer.hbs` }
  };

  #draft;
  #isNew;
  #readonly;
  #showLog = false;
  #errors = [];

  constructor(options = {}) {
    super(options);
    this.#readonly = options.readonly === true || !isGM();
    if (options.clock) {
      this.#draft = normalizeClock(structuredClone(options.clock));
      this.#isNew = false;
    } else {
      this.#draft = createClock(options.initial ?? {}, { idGen: () => randomID() });
      this.#isNew = true;
    }
  }

  _initializeApplicationOptions(options) {
    const opts = super._initializeApplicationOptions(options);
    opts.id = `${APP_IDS.editor}-${options.clock?.id ?? randomID(8)}`;
    return opts;
  }

  get title() {
    return this.#isNew ? t("Editor.titleNew") : t("Editor.titleEdit", { name: this.#draft.name });
  }

  /* ---------------------------------------------------------------- */

  async _prepareContext() {
    const d = this.#draft;
    const info = timeInfo();
    const all = store.getAllClocks();
    const preset = kindDefaults(d.kind);
    const calendar = info.calendar;
    const monthNames = calendar?.monthNames;
    const monthOptions = calendar
      ? calendar.monthLengths.map((len, i) => ({ value: i + calendar.monthBase, label: monthNames?.[i] ?? String(i + calendar.monthBase), days: len }))
      : null;
    const scenes = (globalThis.game.scenes?.contents ?? []).map(s => ({ id: s.id, name: s.name }));
    const otherClocks = all.filter(c => c.id !== d.id).map(c => ({ id: c.id, name: c.name, group: c.group }));
    const actor = d.actorUuid ? store.resolveActor(d.actorUuid) : null;

    const triggers = d.triggers.map((tr, index) => ({
      ...tr,
      index,
      typeLabel: t(`TriggerType.${tr.type}`),
      text: triggerText(tr, { clocks: all, info }),
      advanceMode: tr.advance === "complete" ? "complete" : tr.advance === "reset" ? "reset" : "steps",
      advanceSteps: typeof tr.advance === "number" ? tr.advance : 1,
      isScene: tr.type === "scene",
      isRest: tr.type === "rest",
      isTime: tr.type === "time",
      isDate: tr.type === "date",
      isHook: tr.type === "hook",
      isLinked: tr.type === "linked",
      scenes: scenes.map(s => ({ ...s, selected: tr.scenes?.includes(s.id) })),
      every: { hours: tr.every?.hours ?? "", days: tr.every?.days ?? "", weeks: tr.every?.weeks ?? "" },
      repeat: !!tr.repeatEvery,
      repeatEvery: { hours: tr.repeatEvery?.hours ?? "", days: tr.repeatEvery?.days ?? "", weeks: tr.repeatEvery?.weeks ?? "" },
      at: tr.at ?? { year: info.moment?.year ?? 1, month: info.moment?.month ?? (calendar?.monthBase ?? 1), day: info.moment?.day ?? 1, hour: 7, minute: 0 },
      monthOptions: monthOptions?.map(m => ({ ...m, selected: m.value === (tr.at?.month ?? info.moment?.month) })),
      curatedHooks: CURATED_HOOKS.map(h => ({ value: h.hook, label: t(`Hook.${h.key}`), selected: tr.hook === h.hook })),
      isCustomHook: !!tr.hook && !CURATED_HOOKS.some(h => h.hook === tr.hook),
      clocks: otherClocks.map(c => ({ ...c, selected: c.id === tr.clockId })),
      whenOptions: LINK_WHEN.map(w => ({ value: w, label: t(`LinkWhen.${w}`), selected: tr.when === w })),
      targetThresholds: (all.find(c => c.id === tr.clockId)?.thresholds ?? []).map(th => ({ at: th.at, label: th.label, selected: tr.at === th.at }))
    }));

    const addableTypes = TRIGGER_TYPES.filter(tp => tp !== "date" || info.hasCalendar);

    return {
      clock: d,
      isNew: this.#isNew,
      readonly: this.#readonly,
      isGM: isGM(),
      pie: renderPie(d, { size: 120 }),
      kinds: KINDS.map(k => ({ value: k, label: t(`Kind.${k}`), hint: t(`KindHint.${k}`), selected: d.kind === k, icon: kindDefaults(k).icon })),
      segmentPresets: preset.segmentPresets,
      isAlarm: d.kind === "alarm",
      isWeather: d.kind === "weather",
      isCorruption: d.kind === "corruption",
      isProject: d.kind === "project",
      isFaction: d.kind === "faction",
      owners: (() => {
        const users = globalThis.game.users?.contents ?? [];
        const list = users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name, selected: u.id === d.ownerUserId }));
        if (d.ownerUserId && !list.some(o => o.id === d.ownerUserId)) {
          list.push({ id: d.ownerUserId, name: users.find(u => u.id === d.ownerUserId)?.name ?? t("Editor.ownerUnknown", { id: d.ownerUserId }), selected: true });
        }
        return list;
      })(),
      directions: DIRECTIONS.map(v => ({ value: v, label: t(`Direction.${v}`), selected: d.direction === v })),
      onCompleteOptions: ON_COMPLETE.map(v => ({ value: v, label: t(`OnComplete.${v}`), selected: d.onComplete === v })),
      visibilities: VISIBILITIES.filter(v => v !== VISIBILITY.ACTOR_OWNERS || d.actorUuid).map(v => ({ value: v, label: t(`Visibility.${v}`), selected: d.visibility === v })),
      actor: actor ? { name: actor.name, uuid: d.actorUuid, img: actor.img } : null,
      segmentLabels: Array.from({ length: d.segments }, (_, i) => ({ index: i, value: d.segmentLabels[i] ?? "" })),
      thresholds: await Promise.all(d.thresholds.map(async (th, index) => ({
        ...th, index,
        effectLink: th.effectUuid ? await enrich(`@UUID[${th.effectUuid}]`) : null,
        effectName: th.effectUuid ? (globalThis.fromUuidSync?.(th.effectUuid)?.name ?? th.effectUuid) : null
      }))),
      canAddThreshold: d.thresholds.length < LIMITS.THRESHOLDS_MAX && d.segments > 0,
      triggers,
      canAddTrigger: d.triggers.length < LIMITS.TRIGGERS_MAX,
      triggerTypes: addableTypes.map(tp => ({ value: tp, label: t(`TriggerType.${tp}`) })),
      hasCalendar: info.hasCalendar,
      ttaMissing: !TTASource.isActive,
      timeSourceId: info.sourceId,
      descriptionHTML: await enrich(d.description),
      useProseMirror: !!globalThis.customElements?.get("prose-mirror"),
      limits: LIMITS,
      errors: this.#errors.map(e => t(`Error.${e.code}`, e.data)),
      showLog: this.#showLog,
      log: d.log.map(entry => ({
        ...entry,
        when: entry.campaignMoment ? formatMoment(entry.campaignMoment) : new Date(entry.at).toLocaleString(),
        sourceLabel: t(`Source.${entry.source}`),
        userName: entry.userId ? (globalThis.game.users.get(entry.userId)?.name ?? "—") : "—",
        deltaText: entry.delta > 0 ? `+${entry.delta}` : `${entry.delta}`
      })),
      createdAt: d.createdAt ? new Date(d.createdAt).toLocaleString() : null
    };
  }

  _attachPartListeners(partId, el, options) {
    super._attachPartListeners?.(partId, el, options);
    if (partId !== "form") return;
    el.addEventListener("change", ev => {
      if (ev.target.matches("[data-no-rerender]")) { this.#readForm(); return; }
      this.#readForm();
      this.render();
    });
    if (isGM()) {
      el.addEventListener("dragover", ev => ev.preventDefault());
      el.addEventListener("drop", ev => this.#onDrop(ev));
    }
  }

  async #onDrop(event) {
    event.preventDefault();
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
    let data;
    try { data = TE.getDragEventData(event); } catch { return; }
    if (!data?.uuid) return;
    this.#readForm();
    if (data.type === "Item") {
      // A PF2e condition or effect dropped on a threshold row becomes its link. Never applied automatically.
      const row = event.target.closest?.("[data-threshold-index]");
      if (!row) return;
      const i = Number(row.dataset.thresholdIndex);
      if (this.#draft.thresholds[i]) this.#draft.thresholds[i].effectUuid = data.uuid;
      this.render();
      return;
    }
    if (data.type !== "Actor") return;
    const actor = store.resolveActor(data.uuid);
    if (!actor) return;
    if (!store.isBindableActor(actor)) { notify("warn", t("Notify.actorTypeRefused", { name: actor.name, type: actor.type })); return; }
    this.#draft.actorUuid = data.uuid;
    if (this.#draft.kind === "corruption") this.#draft.visibility = VISIBILITY.ACTOR_OWNERS;
    this.render();
  }

  /* ---------------------------------------------------------------- */

  #readForm() {
    const FDE = getFormDataExtended();
    if (!FDE || !this.element) return;
    const data = new FDE(this.element).object;
    const obj = foundry.utils.expandObject(data);
    this.#applyFormData(obj);
  }

  #applyFormData(obj) {
    const d = structuredClone(this.#draft);
    const simple = ["name", "group", "icon", "color", "direction", "onComplete", "visibility", "actorUuid", "ownerUserId"];
    for (const k of simple) if (obj[k] !== undefined) d[k] = obj[k];
    if (obj.description !== undefined) d.description = sanitizeHTML(obj.description);
    if (obj.segments !== undefined) d.segments = Number(obj.segments);
    if (obj.filled !== undefined) d.filled = Number(obj.filled);
    if (obj.kind && obj.kind !== d.kind) {
      Object.assign(d, changeKind(d, obj.kind));
    }
    if (obj.segmentLabels !== undefined) d.segmentLabels = toArray(obj.segmentLabels).map(v => String(v ?? ""));
    if (obj.thresholds !== undefined) {
      d.thresholds = toArray(obj.thresholds).map((th, i) => ({ at: Number(th.at), label: th.label ?? "", note: th.note ?? "", effectUuid: th.effectUuid || d.thresholds[i]?.effectUuid || null }));
    }
    if (obj.triggers !== undefined) {
      const list = toArray(obj.triggers);
      d.triggers = list.map((raw, i) => {
        const prev = d.triggers[i] ?? {};
        const type = raw.type ?? prev.type;
        const out = { id: prev.id, type };
        const mode = raw.advanceMode ?? "steps";
        out.advance = mode === "complete" ? "complete" : mode === "reset" ? "reset" : Number(raw.advanceSteps ?? prev.advance ?? 1);
        if (type === "scene") out.scenes = asList(raw.scenes);
        if (type === "rest") out.onAdventureDay = raw.onAdventureDay === true || raw.onAdventureDay === "true";
        if (type === "time") {
          out.every = {};
          for (const u of EVERY_UNITS) if (raw.every?.[u] !== "" && raw.every?.[u] !== undefined) out.every[u] = Number(raw.every[u]);
          out.once = raw.once === true || raw.once === "true";
        }
        if (type === "date") {
          const at = raw.at ?? {};
          out.at = { year: Number(at.year), month: Number(at.month), day: Number(at.day), hour: Number(at.hour ?? 0), minute: Number(at.minute ?? 0) };
          const repeat = raw.repeat === true || raw.repeat === "true";
          if (repeat) {
            out.repeatEvery = {};
            for (const u of EVERY_UNITS) if (raw.repeatEvery?.[u] !== "" && raw.repeatEvery?.[u] !== undefined) out.repeatEvery[u] = Number(raw.repeatEvery[u]);
            if (!Object.keys(out.repeatEvery).length) out.repeatEvery = { days: 1 };
          } else out.repeatEvery = null;
        }
        if (type === "hook") {
          out.hook = raw.hookSelect === "__custom" ? (raw.hookCustom ?? "") : (raw.hookSelect ?? raw.hook ?? prev.hook ?? "");
          const curated = CURATED_HOOKS.find(h => h.hook === out.hook);
          out.filter = curated?.filter ?? null;
        }
        if (type === "linked") {
          out.clockId = raw.clockId ?? prev.clockId ?? "";
          out.when = raw.when ?? prev.when ?? "completed";
          out.at = raw.at !== undefined && raw.at !== "" ? Number(raw.at) : null;
        }
        return normalizeTrigger(out, () => randomID());
      });
      // A deadline the GM moved is a new deadline: forget that the old one fired.
      for (const tr of d.triggers) {
        const before = this.#draft.triggers.find(x => x.id === tr.id);
        if (tr.type === "date" && before?.type === "date" && JSON.stringify(before.at) !== JSON.stringify(tr.at) && d.triggerState?.[tr.id]) {
          d.triggerState[tr.id] = { ...d.triggerState[tr.id], fired: false, lastFiredAt: null };
        }
      }
    }
    if (d.visibility === VISIBILITY.ACTOR_OWNERS && !d.actorUuid) d.visibility = VISIBILITY.GM_ONLY;
    // Keep ids and timestamps; normalise everything else.
    const normalised = normalizeClock(d, { idGen: () => randomID() });
    normalised.id = this.#draft.id;
    normalised.createdAt = this.#draft.createdAt;
    this.#draft = normalised;
  }

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  static #onSetKind(event, target) {
    this.#readForm();
    this.#draft = changeKind(this.#draft, target.dataset.kind);
    this.render();
  }

  static #onSetSegments(event, target) {
    this.#readForm();
    const n = Number(target.dataset.value);
    this.#draft.segments = n;
    this.#draft = normalizeClock(this.#draft);
    this.render();
  }

  static #onAddThreshold() {
    this.#readForm();
    const d = this.#draft;
    const used = new Set(d.thresholds.map(th => th.at));
    let at = 1;
    while (used.has(at) && at <= d.segments) at++;
    if (at > d.segments) return;
    d.thresholds.push({ at, label: "", note: "", effectUuid: null });
    d.thresholds.sort((a, b) => a.at - b.at);
    this.render();
  }

  static #onRemoveThreshold(event, target) {
    this.#readForm();
    const i = Number(target.dataset.index);
    this.#draft.thresholds.splice(i, 1);
    this.render();
  }

  static #onAddTrigger(event, target) {
    this.#readForm();
    const select = this.element.querySelector("[name='newTriggerType']");
    const type = target.dataset.type || select?.value || "scene";
    const info = timeInfo();
    const base = { id: randomID(), type, advance: 1 };
    if (type === "time") base.every = { days: 1 };
    if (type === "date") { base.advance = "complete"; base.at = info.moment ?? { year: 1, month: info.calendar?.monthBase ?? 1, day: 1, hour: 7, minute: 0 }; }
    if (type === "hook") base.hook = "deleteCombat";
    if (type === "linked") base.when = "completed";
    this.#draft.triggers.push(normalizeTrigger(base, () => randomID()));
    this.#draft = normalizeClock(this.#draft);
    this.render();
  }

  static #onRemoveTrigger(event, target) {
    this.#readForm();
    const i = Number(target.dataset.index);
    this.#draft.triggers.splice(i, 1);
    this.#draft = normalizeClock(this.#draft);
    this.render();
  }

  static #onClearActor() {
    this.#readForm();
    this.#draft.actorUuid = null;
    if (this.#draft.visibility === VISIBILITY.ACTOR_OWNERS) this.#draft.visibility = VISIBILITY.GM_ONLY;
    this.render();
  }

  static #onClearEffect(event, target) {
    this.#readForm();
    const i = Number(target.dataset.index);
    if (this.#draft.thresholds[i]) this.#draft.thresholds[i].effectUuid = null;
    this.render();
  }

  static #onFillLabels() {
    this.#readForm();
    const preset = kindDefaults("weather").segmentLabels ?? [];
    this.#draft.segmentLabels = Array.from({ length: this.#draft.segments }, (_, i) => preset[i % preset.length] ?? "");
    this.render();
  }

  static #onToggleLog() {
    this.#readForm();
    this.#showLog = !this.#showLog;
    this.render();
  }

  static #onCancel() {
    this.close();
  }

  static async #onSubmit(event, form, formData) {
    if (this.#readonly) { this.close(); return; }
    this.#applyFormData(foundry.utils.expandObject(formData.object));
    const clock = this.#draft;
    const info = timeInfo();
    const all = store.getAllClocks();
    // Only judge the actor type when the actor resolves; an orphaned binding is
    // reported on the card, not blocked here, so the GM can still edit or unbind.
    const boundActor = clock.actorUuid ? store.resolveActor(clock.actorUuid) : null;
    const actorType = boundActor ? boundActor.type : undefined;
    const result = validateClock(clock, { allClocks: all, calendar: info.calendar, isNew: this.#isNew, actorType });
    if (!result.valid) {
      this.#errors = result.errors;
      notify("warn", t("Notify.invalid", { n: result.errors.length }));
      this.render();
      return;
    }
    this.#errors = [];
    const now = new Date().toISOString();
    clock.updatedAt = now;
    if (this.#isNew) clock.createdAt ??= now;
    await dispatcher.saveClock(clock);
    try { await globalThis.game.modules.get(MODULE_ID)?.api?.syncHookListeners?.(); } catch { /* ignore */ }
    notify("info", t(this.#isNew ? "Notify.created" : "Notify.saved", { name: clock.name }));
    this.#isNew = false;
    rerenderModuleApps();
    this.close();
  }
}
