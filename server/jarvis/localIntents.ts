import { catalogEntry, collectionOf, resolveCatalogId, resolveCollection, resolveCountry } from "../../shared/catalog";
import type { ArcAction, ArcState } from "../../shared/types";
import { resolveColor } from "./colors";

/**
 * Deterministic fast path for frequent commands. High-confidence patterns only —
 * anything ambiguous returns null and goes to the LLM.
 */

export type LocalIntent =
  | { kind: "reply"; reply: string; actions: ArcAction[] }
  | { kind: "wake" }
  | { kind: "confirm"; approved: boolean }
  | { kind: "cancel" }
  | { kind: "note-add"; text: string }
  | { kind: "note-list" }
  | { kind: "note-clear" };

const WAKE = /^(?:(?:hey|hi|ok|okay|yo)\s+)?(?:jarvis|jervis|jarvis's)\b[\s,.!?:-]*/i;

/** Remove a leading wake word; returns whether one was present. */
export function stripWake(text: string): { text: string; woke: boolean } {
  const t = text.trim();
  const m = t.match(WAKE);
  if (m) return { text: t.slice(m[0].length).trim(), woke: true };
  return { text: t, woke: /\bjarvis\b/i.test(t) };
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[.!?,]+$/g, "")
    .replace(/^(please|can you|could you|would you|will you|i want you to|i'd like you to|go ahead and)\s+/g, "")
    .replace(/\s+please$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const reply = (text: string, ...actions: ArcAction[]): LocalIntent => ({ kind: "reply", reply: text, actions });

const WORD_NUM: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, twenty: 20, ninety: 90, half: 0.5 };

function evaluateMath(expr: string): number | null {
  const e = expr
    .replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-")
    .replace(/\b(times|multiplied by|x)\b/g, "*")
    .replace(/×/g, "*")
    .replace(/\b(divided by|over)\b/g, "/")
    .replace(/÷/g, "/")
    .replace(/\bsquared\b/g, "**2")
    .replace(/\bpercent of\b/g, "/100*")
    .replace(/,/g, "");
  if (!/^[\d\s+\-*/().%]+$/.test(e) || !/\d/.test(e) || !/[+\-*/%]/.test(e)) return null;
  try {
    const value = Function(`"use strict"; return (${e})`)();
    return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  } catch {
    return null;
  }
}

function formatNumber(n: number): string {
  return Math.abs(n) >= 1e4 ? n.toLocaleString("en-US") : String(n);
}

/** "it", "the earth", "that" → playground target. */
function objectTarget(fragment: string | undefined): string {
  if (!fragment) return "selected";
  const id = resolveCatalogId(fragment);
  return id ?? "selected";
}

const DIRECTIONS: Record<string, "left" | "right" | "up" | "down" | "forward" | "back" | "center"> = {
  left: "left",
  right: "right",
  up: "up",
  higher: "up",
  down: "down",
  lower: "down",
  forward: "forward",
  closer: "forward",
  "toward me": "forward",
  back: "back",
  backward: "back",
  away: "back",
  center: "center",
  middle: "center",
};

export function parseLocalIntent(raw: string, state: ArcState): LocalIntent | null {
  const t = normalize(raw);
  if (!t) return { kind: "wake" };

  // ── Confirmation by voice while a request is pending ──
  if (state.pending) {
    if (/^(yes|yeah|yep|confirm(ed)?|do it|go ahead|proceed|approved?|affirmative|sure)$/.test(t)) return { kind: "confirm", approved: true };
    if (/^(no|nope|cancel|deny|abort|don't|do not|negative|never mind|nevermind|stop)$/.test(t)) return { kind: "confirm", approved: false };
  }
  if (/^(stop|cancel|be quiet|quiet|shut up|silence|stop talking|never mind|nevermind)$/.test(t)) return { kind: "cancel" };

  // ── Small talk ──
  if (/^(hi|hello|hey|good (morning|afternoon|evening))( there)?$/.test(t)) return reply("Hello, boss.");
  if (/^(thanks|thank you|cheers|nice|great|perfect)( jarvis)?$/.test(t)) return reply("Anytime, boss.");
  if (/^(are you there|you there|are you online|status)$/.test(t)) return reply("Online and ready, boss.");
  if (/^what can you do$/.test(t))
    return reply("I can control your PC, run the 3D playground, and answer questions, boss.");

  // ── Time / date ──
  if (/\b(what time is it|what'?s the time|what is the time|current time|time now)\b/.test(t)) {
    const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return reply(`It's ${time}, boss.`);
  }
  if (/\b(what'?s the date|what is the date|what day is it|today'?s date|what is today)\b/.test(t)) {
    const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    return reply(`It's ${date}, boss.`);
  }

  // ── Math ──
  const math = t.match(/^(?:what'?s|what is|calculate|compute|how much is)\s+(.+)$/);
  if (math) {
    const value = evaluateMath(math[1]);
    if (value !== null) return reply(`${formatNumber(value)}, boss.`);
  }

  // ── Notes ──
  const note = t.match(/^(?:remember|note|make a note)(?: that)?\s+(.+)$/);
  if (note) return { kind: "note-add", text: raw.trim().replace(/^(?:jarvis[,\s]*)?(?:remember|note|make a note)(?: that)?\s+/i, "") };
  if (/^(what are|show|read|list)( me)? my notes$/.test(t)) return { kind: "note-list" };
  if (/^(clear|delete) (all )?my notes$/.test(t)) return { kind: "note-clear" };

  // ── ARC modes & cameras ──
  if (/^((activate|start|enable|enter|open|launch|engage|turn on|go to|switch to|bring up)( the)?( arc)? visor( mode)?|visor( mode)?)$/.test(t))
    return reply("Activating ARC Visor, boss.", { action: "SET_MODE", mode: "VISOR" });
  if (/^(exit|leave|close|deactivate|disable|turn off|stop|end|quit)( the)?( arc)? visor( mode)?$/.test(t))
    return reply("Exiting visor mode, boss.", { action: "EXIT_VISOR" });
  if (/^(re-?calibrate|calibrate)( the| my)?( gaze| eyes| eye tracking| visor)?$/.test(t)) return reply("Recalibrating, boss.", { action: "RECALIBRATE_GAZE" });
  if (/^(enable|turn on|start|activate) (eye tracking|gaze( tracking| control)?)$/.test(t)) return reply("Eye tracking on, boss.", { action: "SET_GAZE", enabled: true });
  if (/^(disable|turn off|stop|deactivate) (eye tracking|gaze( tracking| control)?)$/.test(t)) return reply("Eye tracking off, boss.", { action: "SET_GAZE", enabled: false });
  if (/^(enter|open|start|launch|activate|switch to|go to|show)( the)? playground( mode)?$/.test(t) || t === "playground" || t === "playground mode")
    return reply("Entering playground, boss.", { action: "SET_MODE", mode: "PLAYGROUND" });
  if (/^((exit|leave|close|quit)( the)? playground( mode)?|(enter|switch to|go to|back to|return to|activate)( the)? command( mode)?|command mode)$/.test(t))
    return reply("Command mode, boss.", { action: "SET_MODE", mode: "COMMAND" });
  const cam = t.match(/^(?:switch|change|use|go)(?: to)?(?: the)? (phone|mobile|pc|desktop|computer|laptop|web ?cam)(?:'s)?(?: camera| cam)?$/);
  if (cam) {
    const to = /phone|mobile/.test(cam[1]) ? "PHONE" : "PC";
    return reply(`Switching to the ${to === "PHONE" ? "phone" : "PC"} camera, boss.`, { action: "SWITCH_CAMERA", to });
  }

  // ── Collections: "pull up everything we have on Iron Man" → carousel of that category ──
  const coll =
    t.match(/^(?:pull up|bring up|show(?: me)?|display|open|load|give me|what do we have on|what have we got on|list)(?: me)? (?:everything|all(?: the)?(?: stuff| models| files| data)?|the(?: whole)?(?: collection| models)?)?(?: we(?: have|'ve got)| you(?: have|'ve got))?(?: on| about| of| for| from)?(?: the)? (.+?)(?: models| collection| stuff| files| category| suits)?$/) ??
    t.match(/^(.+?) (?:collection|models|category)$/);
  if (coll) {
    const id = /^(everything|all|all models|all the models|every model)$/.test(coll[1].trim()) ? "all" : resolveCollection(coll[1]);
    // Only when it really names a collection (not "show me the earth" / a single model).
    if (id && (id === "all" || !resolveCatalogId(coll[1]) || /everything|all|collection|models|stuff|suits|we have|have we/.test(t))) {
      const name = id === "all" ? "everything" : collectionOf(id)!.name;
      return reply(id === "all" ? "Here's everything, boss." : `Pulling up everything on ${name}, boss.`, { action: "DEEP_DIVE", enabled: true, collection: id });
    }
  }
  if (/^(show|pull up|bring up) (me )?everything$/.test(t)) return reply("Here's everything, boss.", { action: "DEEP_DIVE", enabled: true, collection: "all" });

  // ── Brightness (low by default) ──
  const bright = t.match(/^(?:set |change |make )?(?:the )?brightness(?: to| at)? (\d{1,3})(?: ?%| percent)?$/);
  if (bright) return reply(`Brightness ${bright[1]}%, boss.`, { action: "SET_BRIGHTNESS", value: Math.min(1, Number(bright[1]) / 100) });
  if (/^(brighter|brightness up|increase( the)? brightness|turn (up|on) the (lights|brightness)|more light|make it brighter)$/.test(t))
    return reply("Brighter, boss.", { action: "SET_BRIGHTNESS", value: Math.min(1, state.settings.brightness + 0.2) });
  if (/^(dimmer|darker|brightness down|decrease( the)? brightness|dim( the)? (lights|scene|it)|turn down the (lights|brightness)|less light|make it (dimmer|darker))$/.test(t))
    return reply("Dimmer, boss.", { action: "SET_BRIGHTNESS", value: Math.max(0, state.settings.brightness - 0.2) });

  // ── Model actions on the Deep Dive stage: open the faceplate, power up the reactor, paint it gold ──
  if (state.deepDive.active && state.deepDive.actions.length) {
    const acts = state.deepDive.actions;
    const ON = /^(open|raise|lift|deploy|extend|activate|enable|start|power up|power on|turn on|switch on|fire|launch|show|engage|arm)\b/;
    const OFF = /^(close|lower|shut|retract|deactivate|disable|stop|power down|power off|turn off|switch off|hide|disengage|disarm)\b/;
    const named = (a: (typeof acts)[number]) => [a.label.toLowerCase(), ...(a.words ?? [])].some((w) => w && t.includes(w));
    const choice = acts.find((a) => a.kind === "choice" && (a.options ?? []).some((o) => t.includes(o.toLowerCase())) && (named(a) || /^(paint|make it|switch to|go|change to|set)/.test(t) || / (mode|scheme|finish|colou?r|paint)$/.test(t)));
    if (choice) {
      const opt = (choice.options ?? []).find((o) => t.includes(o.toLowerCase()))!;
      return reply(`${opt}, boss.`, { action: "MODEL_ACTION", id: choice.id, value: opt });
    }
    const on = ON.test(t);
    const off = OFF.test(t);
    const toggles = acts.filter((a) => a.kind !== "choice");
    const target = toggles.find(named) ?? (/\b(it|this|that)$/.test(t) && (on || off) ? toggles.find((a) => a.kind === "toggle") : undefined);
    if (target && (on || off || target.kind === "trigger" || /^(toggle|flip|switch)/.test(t))) {
      const value = target.kind === "toggle" ? (on ? true : off ? false : !target.value) : undefined;
      return reply(target.kind === "trigger" ? `${target.label}, boss.` : `${target.label} ${value ? "on" : "off"}, boss.`, value === undefined ? { action: "MODEL_ACTION", id: target.id } : { action: "MODEL_ACTION", id: target.id, value });
    }
  }

  // ── Explode by amount and spin on/off (Deep Dive stage or the selected Playground object) ──
  const dd = state.deepDive;
  const diving = dd.active && state.spaces.PC === "PLAYGROUND";
  const amountWord = (w: string) => (/^half$/.test(w) ? 0.5 : /^(full|fully|max|maximum|all the way|completely)$/.test(w) ? 1 : Number(w) > 1 || /%|percent/.test(w) ? Number(w.replace(/[^\d.]/g, "")) / 100 : Number(w));
  const explodeTo =
    t.match(/^(?:explode|expand|separate|spread|open up|pull apart)(?: out| apart)?(?: (?:it|this|that|the (?:view|model|parts|object|whole thing)))?(?: (?:to|by|at|up to))? (\d{1,3}(?:\.\d+)?(?: ?%| percent)?|half|full|fully|max|maximum|all the way|completely)$/) ??
    t.match(/^(?:set |make |change )?(?:the )?explo(?:de|ded|sion)(?: view| amount| level)?(?: to| at)? (\d{1,3}(?:\.\d+)?(?: ?%| percent)?|half|full|max)$/);
  if (explodeTo) {
    const amount = Math.max(0, Math.min(1, amountWord(explodeTo[1].trim())));
    if (Number.isFinite(amount)) {
      const pct = `${Math.round(amount * 100)}%`;
      return diving
        ? reply(`Exploded to ${pct}, boss.`, { action: "DEEP_DIVE_SET", explode: amount })
        : reply(`Exploded to ${pct}, boss.`, { action: "EXPLODE_OBJECT", target: "selected", enabled: amount > 0, amount });
    }
  }
  if (/^(explode|explode the (view|model|parts)|exploded view)$/.test(t) && diving) return reply("Exploded view, boss.", { action: "DEEP_DIVE_SET", explode: 1 });
  if (/^(stop|pause|disable|turn off|kill|no)( the)? (spin|spinning|rotation|rotating)$|^(stop|pause) (it )?(spinning|rotating)$|^freeze( it)?$|^hold still$/.test(t))
    return diving ? reply("Holding still, boss.", { action: "DEEP_DIVE_SET", spin: 0 }) : reply("Holding still, boss.", { action: "SPIN_OBJECT", target: "selected", enabled: false, speed: 0 });
  if (/^(start|enable|turn on|resume)( the)? (spin|spinning|rotation|rotating)$/.test(t))
    return diving ? reply("Spinning, boss.", { action: "DEEP_DIVE_SET", spin: 0.4 }) : reply("Spinning, boss.", { action: "SPIN_OBJECT", target: "selected", enabled: true, speed: 0.5 });

  // ── Deep Dive (one model on its own stage; AR hologram + labels) ──
  if (/^(open |start |enable |activate |turn on |enter )?deep ?dive( mode)?$/.test(t))
    return reply("Pick a model, boss.", { action: "DEEP_DIVE", enabled: true });
  if (/^(exit|leave|close|stop|end|disable|turn off|quit)( the)? deep ?dive( mode)?$/.test(t))
    return reply("Leaving Deep Dive, boss.", { action: "DEEP_DIVE", enabled: false });
  const dive = t.match(/^(?:deep ?dive|dive)(?: into| in| on| with)?(?: the| my| a)?\s+(.+?)(?: model)?$/);
  if (dive) {
    const id = resolveCatalogId(dive[1]);
    const name = id ? catalogEntry(id)!.name : dive[1];
    return reply(`Deep diving into ${id ? "the " + name.toLowerCase() : name}, boss.`, { action: "DEEP_DIVE", enabled: true, model: id ?? dive[1] });
  }
  if (dd.active) {
    if (!dd.modelId) {
      if (/^(this one|that one|select( this| it| that)?( one)?|pick( this| that| it)?( one)?|open( this| it| that)( one)?|choose( this| that)?( one)?|go)$/.test(t))
        return reply("", { action: "CAROUSEL", command: "select" });
      if (/^(next|next one|spin( it)?|right)$/.test(t)) return reply("", { action: "CAROUSEL", command: "next" });
      if (/^(previous|back|last one|previous one|left)$/.test(t)) return reply("", { action: "CAROUSEL", command: "previous" });
    }
    const ar = t.match(/^(turn on|enable|activate|show|switch to|start|go|turn off|disable|deactivate|hide|stop|exit|leave)( the)? (ar|a r|hologram|holo|holographic)( mode| view)?$/);
    if (ar) {
      const on = !/off|disable|deactivate|hide|stop|exit|leave/.test(ar[1]);
      return reply(on ? "AR mode on, boss." : "AR mode off, boss.", { action: "DEEP_DIVE_SET", ar: on });
    }
    if (/^(ar|a r)( mode)?$/.test(t)) return reply("AR mode on, boss.", { action: "DEEP_DIVE_SET", ar: true });
    const c1 = t.match(/^(?:make|set|change|turn|paint)(?: the)? (background|bg|hologram|holo|diagram|model|labels?|text)(?: colou?r)?(?: to| into)? (.+)$/);
    const c2 = t.match(/^(.+?) (background|hologram|labels?)$/);
    const cm = c1 ? { what: c1[1], value: c1[2] } : c2 ? { what: c2[2], value: c2[1] } : null;
    if (cm && resolveColor(cm.value)) {
      const key = /background|bg/.test(cm.what) ? "bg" : /label|text/.test(cm.what) ? "labelColor" : "color";
      return reply("Done, boss.", { action: "DEEP_DIVE_SET", [key]: cm.value });
    }
    const style = t.match(/^(?:show |switch to |turn on |use |go )?(wire ?frame|x-? ?ray|solid|normal)(?: mode| view| style)?$/);
    if (style) {
      const s = /wire/.test(style[1]) ? "wireframe" : /x/.test(style[1]) ? "xray" : "solid";
      return reply(`${s === "xray" ? "X-ray" : s[0].toUpperCase() + s.slice(1)} view, boss.`, { action: "DEEP_DIVE_SET", style: s });
    }
    if (/^(explode|exploded view|take (it|that) apart|disassemble( it)?|explode (it|that)|separate( the)? parts)$/.test(t))
      return reply("Exploded view, boss.", { action: "DEEP_DIVE_SET", explode: 1 });
    if (/^(assemble( it)?|put (it|that) back( together)?|collapse( it)?|reassemble( it)?)$/.test(t))
      return reply("Reassembled, boss.", { action: "DEEP_DIVE_SET", explode: 0 });
    if (/^(stop|pause) (rotating|spinning|the rotation|it)$/.test(t)) return reply("Holding still, boss.", { action: "DEEP_DIVE_SET", spin: 0 });
    if (/^(spin|rotate|keep rotating|start rotating|auto rotate)( it)?$/.test(t)) return reply("Spinning, boss.", { action: "DEEP_DIVE_SET", spin: 0.4 });
    if (/^(show )?(all|more) labels$/.test(t)) return reply("All labels, boss.", { action: "DEEP_DIVE_SET", labels: true, detail: "all" });
    if (/^(show )?(fewer|less|main) labels$/.test(t)) return reply("Main labels only, boss.", { action: "DEEP_DIVE_SET", labels: true, detail: "few" });
    if (/^(hide|remove|turn off|disable)( the| all)? (labels|names)$/.test(t)) return reply("Labels off, boss.", { action: "DEEP_DIVE_SET", labels: false });
    if (/^(show|turn on|enable|add)( the)? (labels|names|part names)$|^label (it|the parts|everything)$/.test(t)) return reply("Labels on, boss.", { action: "DEEP_DIVE_SET", labels: true, detail: "auto" });
    if (/^(zoom out|show (the )?whole (thing|model)|reset( the)? (view|camera)|unfocus)$/.test(t)) return reply("", { action: "FOCUS_PART", part: null });
    const part = t.match(/^(?:focus on|zoom (?:in )?(?:to|on)|show(?: me)?|where is|what is|what'?s|highlight|go to|point (?:at|to))(?: the)?\s+(.+?)\??$/);
    if (part && dd.parts.length) {
      const words = part[1].replace(/^(the|a|an)\s+/, "");
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
      const hit = dd.parts.find((p) => norm(p.name) === words) ?? dd.parts.find((p) => norm(p.name).includes(words) || (words.length > 3 && words.includes(norm(p.name))));
      if (hit) return reply(hit.info ? `${hit.name}. ${hit.info}` : `${hit.name}, boss.`, { action: "FOCUS_PART", part: hit.id });
    }
  }

  // ── Files (before generic open/create/delete) ──
  const createFile = t.match(/^(?:create|make|new)(?: a)?(?: new)?(?: text)? file(?: named| called)?\s+(.+)$/);
  if (createFile) return reply("Certainly, boss.", { action: "CREATE_FILE", name: createFile[1], content: "" });
  const findFile = t.match(/^(?:find|search for|locate|look for)(?: the| my)? (?:file|files|document|documents|folder)(?: named| called)?\s+(.+)$/);
  if (findFile) return reply("Searching, boss.", { action: "SEARCH_FILE", query: findFile[1] });
  const openFile = t.match(/^open(?: the| my)? (?:file|document|folder)(?: named| called)?\s+(.+)$/) ?? t.match(/^open(?: the| my)?\s+(\S+\.[a-z0-9]{2,5})$/);
  if (openFile) return reply("Certainly, boss.", { action: "OPEN_FILE", path: openFile[1] });
  const deleteFile = t.match(/^(?:delete|remove|trash)(?: the| my)? (?:file|folder|document)(?: named| called)?\s+(.+)$/);
  if (deleteFile) return reply("That needs your confirmation, boss.", { action: "DELETE_FILE", path: deleteFile[1] });

  // ── Playground ──
  const location = t.match(/^(?:show(?: me)?|zoom (?:in )?(?:to|on)|go to|fly to|highlight|where is|find|locate|focus on)\s+(.+?)(?: on (?:the )?(?:earth|globe|map))?$/);
  if (location) {
    const country = resolveCountry(location[1]);
    if (country) {
      const hasEarth = state.scene.objects.some((o) => o.kind === "earth");
      const actions: ArcAction[] = [];
      if (!hasEarth) actions.push({ action: "SPAWN_OBJECT", object: "earth" });
      actions.push({ action: "SHOW_LOCATION", target: "earth", location: country.name });
      return reply(`Here is ${country.name}, boss.`, ...actions);
    }
  }

  const spawn = t.match(/^(?:spawn|create|add|bring up|load|make|display|summon|show(?: me)?|give me|generate)(?: me)?(?: an?| the| another)?(?: 3d| 3 d| three d)?(?: model of(?: an?| the)?)?\s+(.+)$/);
  if (spawn) {
    const id = resolveCatalogId(spawn[1]);
    if (id) return reply(`${catalogEntry(id)!.name} coming up, boss.`, { action: "SPAWN_OBJECT", object: id });
  }

  if (/^(clear|reset|empty|wipe)( the)? (scene|playground|everything|all)$/.test(t) || /^(delete|remove) (everything|all( objects)?)$/.test(t))
    return reply("Scene cleared, boss.", { action: "CLEAR_SCENE" });
  if (/^reset( the)? (view|camera)$/.test(t)) return reply("View reset, boss.", { action: "RESET_VIEW" });

  const del = t.match(/^(?:delete|remove|destroy|get rid of|despawn)\s+(it|that|this|the .+|.+)$/);
  if (del && (/^(it|that|this)$/.test(del[1]) || resolveCatalogId(del[1])))
    return reply("Removed, boss.", { action: "DELETE_OBJECT", target: objectTarget(del[1]) });

  if (/^(stop|pause) (rotating|spinning|the rotation|it)$/.test(t)) return reply("Holding still, boss.", { action: "SPIN_OBJECT", target: "selected", enabled: false, speed: 0 });
  const spin = t.match(/^(?:spin|keep rotating|start rotating|auto rotate|rotate continuously)(?: (it|the \w+))?$/);
  if (spin) return reply("Spinning, boss.", { action: "SPIN_OBJECT", target: objectTarget(spin[1]), enabled: true, speed: 0.5 });

  const rotate = t.match(/^(?:rotate|turn)(?: (it|that|the [a-z ]+?))?(?: (left|right|up|down|around|over))?(?: by)?(?: (\d+|ninety|a hundred and eighty) ?(?:degrees?|°))?$/);
  if (rotate) {
    const dir = rotate[2];
    let amount = rotate[3] ? (rotate[3] === "ninety" ? 90 : rotate[3].startsWith("a hundred") ? 180 : Number(rotate[3])) : 45;
    if (dir === "around") amount = 180;
    const axis = dir === "up" || dir === "down" || dir === "over" ? "x" : "y";
    if (dir === "left" || dir === "up") amount = -amount;
    return reply("Rotating, boss.", { action: "ROTATE_OBJECT", target: objectTarget(rotate[1]), axis, amount });
  }

  const bigger = t.match(/^(?:make|scale)(?: (it|that|the [a-z ]+?))? (bigger|larger|huge|smaller|tiny|little smaller|little bigger)$/) ?? t.match(/^(scale|zoom)(?: (it|that))? (up|down)$/);
  if (bigger) {
    const word = bigger[bigger.length - 1];
    const factor = /huge/.test(word) ? 2 : /tiny/.test(word) ? 0.5 : /little bigger/.test(word) ? 1.2 : /little smaller/.test(word) ? 0.83 : /bigger|larger|up/.test(word) ? 1.5 : 0.67;
    return reply(factor > 1 ? "Scaling up, boss." : "Scaling down, boss.", { action: "SCALE_OBJECT", target: objectTarget(bigger[1]), factor });
  }
  const scaleBy = t.match(/^(?:scale|resize)(?: (it|that|the [a-z ]+?))? (?:by|to) (\d+(?:\.\d+)?|half|two|three)(?: ?x| times)?$/);
  if (scaleBy) {
    const factor = WORD_NUM[scaleBy[2]] ?? Number(scaleBy[2]);
    if (factor >= 0.1 && factor <= 10) return reply("Scaling, boss.", { action: "SCALE_OBJECT", target: objectTarget(scaleBy[1]), factor });
  }
  if (/^(double|twice) (the|its) size$/.test(t)) return reply("Doubled, boss.", { action: "SCALE_OBJECT", target: "selected", factor: 2 });
  if (/^half (the|its) size$/.test(t)) return reply("Halved, boss.", { action: "SCALE_OBJECT", target: "selected", factor: 0.5 });

  const move = t.match(/^(?:move|shift|push|bring|put)(?: (it|that|the [a-z ]+?))?(?: a (?:bit|little))?(?: to(?: the)?)? (left|right|up|higher|down|lower|forward|closer|toward me|back|backward|away|center|middle)$/);
  if (move) return reply("Moving, boss.", { action: "MOVE_OBJECT", target: objectTarget(move[1]), direction: DIRECTIONS[move[2]], amount: 0.6 });

  const prop = t.match(/^(hide|remove|turn off|disable|show|turn on|enable|add)(?: the)? (atmosphere|clouds|rings|orbits|labels|wireframe)$/);
  if (prop) {
    const value = /show|turn on|enable|add/.test(prop[1]);
    const property = prop[2] as "atmosphere" | "clouds" | "rings" | "orbits" | "labels" | "wireframe";
    return reply(`${property[0].toUpperCase()}${property.slice(1)} ${value ? "on" : "off"}, boss.`, { action: "SET_PROPERTY", target: "selected", property, value });
  }
  if (/^(explode|exploded view|take (it|that) apart|disassemble( it)?|explode (it|that))$/.test(t))
    return reply("Exploded view, boss.", { action: "EXPLODE_OBJECT", target: "selected", enabled: true });
  if (/^(assemble( it)?|put (it|that) back( together)?|collapse( it)?|reassemble( it)?)$/.test(t))
    return reply("Reassembled, boss.", { action: "EXPLODE_OBJECT", target: "selected", enabled: false });
  const select = t.match(/^(?:select|pick|grab|focus on)(?: the)?\s+(.+)$/);
  if (select && resolveCatalogId(select[1])) return reply("Selected, boss.", { action: "SELECT_OBJECT", target: resolveCatalogId(select[1])! });

  // ── System & media ──
  if (/^(system (info|information|status|report|stats)|how is (my|the) (pc|system|computer)( doing)?|(show|give me)( the)? system (info|status|report))$/.test(t))
    return reply("Running diagnostics, boss.", { action: "SYSTEM_INFORMATION", topic: "overview" });
  if (/^(what'?s|what is|how much is|check)( my| the)? (cpu|processor)( usage| load)?$/.test(t)) return reply("Checking, boss.", { action: "SYSTEM_INFORMATION", topic: "cpu" });
  if (/^(what'?s|what is|how much is|check)( my| the)? (memory|ram)( usage)?$/.test(t)) return reply("Checking, boss.", { action: "SYSTEM_INFORMATION", topic: "memory" });
  if (/^(what'?s|what is|how much is|check)( my| the)? battery( level| status)?$|^battery( level| status)?$/.test(t)) return reply("Checking, boss.", { action: "SYSTEM_INFORMATION", topic: "battery" });

  if (/^(play|pause|resume)( the)?( music| song| media| track)?$/.test(t)) return reply("", { action: "CONTROL_MEDIA", command: "PLAY_PAUSE" });
  if (/^(next|skip)( the)?( track| song)?$|^skip( this)?( song| track)?$/.test(t)) return reply("", { action: "CONTROL_MEDIA", command: "NEXT" });
  if (/^(previous|last|go back)( track| song)$/.test(t)) return reply("", { action: "CONTROL_MEDIA", command: "PREVIOUS" });
  if (/^(volume up|turn (it|the volume) up|louder|increase( the)? volume)$/.test(t)) return reply("", { action: "CONTROL_MEDIA", command: "VOLUME_UP" });
  if (/^(volume down|turn (it|the volume) down|quieter|softer|decrease( the)? volume|lower( the)? volume)$/.test(t)) return reply("", { action: "CONTROL_MEDIA", command: "VOLUME_DOWN" });
  if (/^(mute|unmute)( the)?( volume| sound| audio)?$/.test(t)) return reply("", { action: "CONTROL_MEDIA", command: "MUTE" });

  // ── Web ──
  const yt = t.match(/^(?:search |look up )?(?:on )?youtube(?: for)? (.+)$/) ?? t.match(/^(?:play|search|find) (.+) on youtube$/);
  if (yt) return reply("Searching YouTube, boss.", { action: "SEARCH_WEB", query: yt[1], engine: "youtube" });
  const search = t.match(/^(?:search|google|look up|search the web)(?: for)? (.+?)(?: on google)?$/);
  if (search) return reply("Searching, boss.", { action: "SEARCH_WEB", query: search[1], engine: "google" });

  // ── Applications ──
  const query = t.match(/^(?:is|are) (.+?) (?:open|running|on|active)$/);
  if (query) return reply("", { action: "QUERY_APPLICATION", target: query[1].replace(/^the /, "") });
  const close = t.match(/^(?:close|quit|exit|kill|shut down|terminate)(?: the)? (.+?)(?: app| application)?$/);
  if (close) return reply("Certainly, boss.", { action: "CLOSE_APPLICATION", target: close[1] });
  const open = t.match(/^(?:open|launch|start|run|fire up|load up|bring up)(?: up)?(?: the| my)? (.+?)(?: app| application| for me)?$/);
  if (open) {
    const target = open[1];
    if (/\.(com|org|net|io|ai|dev|in|co)(\/|$)|\b(website|site)$/.test(target))
      return reply("Certainly, boss.", { action: "OPEN_WEBSITE", url: target.replace(/\s+(website|site)$/, "") });
    return reply("Certainly, boss.", { action: "OPEN_APPLICATION", target });
  }
  const type = raw.trim().match(/^(?:jarvis[,\s]*)?type\s+(.+)$/i);
  if (type) return reply("", { action: "TYPE_TEXT", text: type[1] });

  return null;
}
