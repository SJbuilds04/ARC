import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLocalIntent, stripWake } from "./localIntents";
import { matchPart, parseModelOutput } from "./Jarvis";
import { resolveColor } from "./colors";
import { classify } from "../security/risk";
import { chunkForSpeech } from "../voice/VoiceProvider";
import { resolveCollection } from "../../shared/catalog";
import type { ArcState } from "../../shared/types";

const state = (overrides: Partial<ArcState> = {}): ArcState =>
  ({
    spaces: { PC: "COMMAND", PHONE: "COMMAND" },
    pending: null,
    library: [],
    deepDive: { active: false, modelId: null, modelName: null, settings: {}, parts: [], focusPart: null, collection: null, actions: [] },
    scene: { objects: [], selectedId: null },
    vision: { activeSource: "PHONE", routes: [], sources: {} },
    devices: { PHONE: { connected: true }, PC: { connected: true } },
    ...overrides,
  }) as unknown as ArcState;

const actionsOf = (text: string, s = state()) => {
  const intent = parseLocalIntent(stripWake(text).text, s);
  return intent?.kind === "reply" ? intent.actions : null;
};

test("wake word handling", () => {
  assert.deepEqual(stripWake("JARVIS, open VS Code"), { text: "open VS Code", woke: true });
  assert.deepEqual(stripWake("Hey Jarvis"), { text: "", woke: true });
  assert.equal(stripWake("open chrome").woke, false);
  assert.equal(parseLocalIntent("", state())?.kind, "wake");
});

test("MVP flow commands resolve locally", () => {
  assert.deepEqual(actionsOf("JARVIS, open VS Code."), [{ action: "OPEN_APPLICATION", target: "vs code" }]);
  // "open <model>" opens the 3D model; other names stay apps
  assert.deepEqual(actionsOf("JARVIS, open the black hole in playground mode."), [{ action: "SPAWN_OBJECT", object: "black_hole" }]);
  assert.deepEqual(actionsOf("open iron spider"), [{ action: "SPAWN_OBJECT", object: "iron_spider" }]);
  assert.deepEqual(actionsOf("open the arc reactor"), [{ action: "SPAWN_OBJECT", object: "arc_reactor" }]);
  assert.deepEqual(actionsOf("open gargantua in deep dive"), [{ action: "DEEP_DIVE", enabled: true, model: "black_hole" }]);
  assert.deepEqual(actionsOf("open google earth"), [{ action: "OPEN_APPLICATION", target: "google earth" }]);
  assert.deepEqual(actionsOf("Jarvis, enter playground"), [{ action: "SET_MODE", mode: "PLAYGROUND" }]);
  assert.deepEqual(actionsOf("Spawn a 3D Earth"), [{ action: "SPAWN_OBJECT", object: "earth" }]);
  assert.deepEqual(actionsOf("show india"), [
    { action: "SPAWN_OBJECT", object: "earth" },
    { action: "SHOW_LOCATION", target: "earth", location: "India" },
  ]);
  const withEarth = state({ scene: { objects: [{ id: "e1", kind: "earth", name: "Earth", position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, props: {} }], selectedId: "e1" } });
  assert.deepEqual(actionsOf("show india", withEarth), [{ action: "SHOW_LOCATION", target: "earth", location: "India" }]);
});

test("playground manipulation phrases", () => {
  assert.deepEqual(actionsOf("make it bigger"), [{ action: "SCALE_OBJECT", target: "selected", factor: 1.5 }]);
  assert.deepEqual(actionsOf("rotate it"), [{ action: "ROTATE_OBJECT", target: "selected", axis: "y", amount: 45 }]);
  assert.deepEqual(actionsOf("move it to the left"), [{ action: "MOVE_OBJECT", target: "selected", direction: "left", amount: 0.6 }]);
  assert.deepEqual(actionsOf("hide the atmosphere"), [{ action: "SET_PROPERTY", target: "selected", property: "atmosphere", value: false }]);
  assert.equal(actionsOf("delete the object"), null); // ambiguous → LLM decides using scene context
  assert.deepEqual(actionsOf("delete it"), [{ action: "DELETE_OBJECT", target: "selected" }]);
  assert.deepEqual(actionsOf("explode it"), [{ action: "EXPLODE_OBJECT", target: "selected", enabled: true }]);
});

test("math, time and app queries are instant", () => {
  const math = parseLocalIntent("what is 25 times 4", state());
  assert.equal(math?.kind === "reply" && math.reply, "100, boss.");
  assert.deepEqual(actionsOf("is chrome open?"), [{ action: "QUERY_APPLICATION", target: "chrome" }]);
  assert.equal(parseLocalIntent("what time is it", state())?.kind, "reply");
});

test("voice confirmation only while pending", () => {
  assert.notEqual(parseLocalIntent("yes", state())?.kind, "confirm");
  const pending = state({ pending: { id: "x" } as ArcState["pending"] });
  assert.deepEqual(parseLocalIntent("yes", pending), { kind: "confirm", approved: true });
  assert.deepEqual(parseLocalIntent("cancel", pending), { kind: "confirm", approved: false });
});

test("ambiguous text falls through to the LLM", () => {
  assert.equal(parseLocalIntent("explain how neural networks work in detail", state()), null);
  assert.equal(parseLocalIntent("what's the capital of france", state()), null);
});

test("model output is validated; invalid / unknown actions are dropped", () => {
  const out = parseModelOutput(
    JSON.stringify({
      reply: "Certainly, boss.",
      actions: [
        { action: "OPEN_APPLICATION", target: "Visual Studio Code", risk: "LOW" },
        { type: "spawn_object", object: "earth" },
        { action: "RUN_SHELL", command: "rm -rf /" },
        { action: "SCALE_OBJECT", target: "selected", factor: 1000 },
      ],
    }),
  );
  assert.equal(out.reply, "Certainly, boss.");
  assert.deepEqual(out.actions, [
    { action: "OPEN_APPLICATION", target: "Visual Studio Code" },
    { action: "SPAWN_OBJECT", object: "earth" },
  ]);
  assert.equal(out.dropped, 2);
  assert.deepEqual(parseModelOutput("not json at all").actions, []);
});

test("risk is decided by ARC, not the model", () => {
  assert.deepEqual(classify({ action: "OPEN_APPLICATION", target: "x" }, false), { risk: "LOW", requiresConfirmation: true, holdMs: 0 });
  assert.equal(classify({ action: "OPEN_APPLICATION", target: "x" }, true).requiresConfirmation, false);
  assert.equal(classify({ action: "SYSTEM_INFORMATION", topic: "overview" }, false).requiresConfirmation, false);
  assert.deepEqual(classify({ action: "CLOSE_APPLICATION", target: "x" }, true), { risk: "MEDIUM", requiresConfirmation: true, holdMs: 0 });
  const del = classify({ action: "DELETE_FILE", path: "a.txt" }, true);
  assert.equal(del.risk, "HIGH");
  assert.equal(del.requiresConfirmation, true);
  assert.ok(del.holdMs > 0);
  assert.equal(classify({ action: "SPAWN_OBJECT", object: "earth" }, false).requiresConfirmation, false);
});

test("speech chunking keeps sentences under the TTS limit", () => {
  const chunks = chunkForSpeech("First sentence. ".repeat(40));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 190));
  assert.deepEqual(chunkForSpeech("100, boss."), ["100, boss."]);
  // JARVIS starts talking after the first sentence, not after a 190-character block
  const reply = chunkForSpeech("Certainly, boss. The Mark 42 was Tony's first prehensile suit. Each piece flies to him on its own, and it can be recalled from anywhere.");
  assert.equal(reply[0], "Certainly, boss.");
  assert.equal(reply.join(" "), "Certainly, boss. The Mark 42 was Tony's first prehensile suit. Each piece flies to him on its own, and it can be recalled from anywhere.");
  // a long first sentence breaks at a clause
  const long = chunkForSpeech("The arc reactor powers the suit through a palladium core that was later replaced, because it was slowly poisoning Tony's blood.");
  assert.ok(long[0].length <= 90 && long[0].endsWith(","), long[0]);
  assert.ok(long.every((c) => c.length <= 190));
});

test("visor voice commands", () => {
  assert.deepEqual(actionsOf("JARVIS, activate visor"), [{ action: "SET_MODE", mode: "VISOR" }]);
  assert.deepEqual(actionsOf("open the visor"), [{ action: "SET_MODE", mode: "VISOR" }]);
  assert.deepEqual(actionsOf("exit visor"), [{ action: "EXIT_VISOR" }]);
  assert.deepEqual(actionsOf("recalibrate gaze"), [{ action: "RECALIBRATE_GAZE" }]);
  assert.deepEqual(actionsOf("disable eye tracking"), [{ action: "SET_GAZE", enabled: false }]);
  const r = parseLocalIntent("activate visor", state());
  assert.equal(r?.kind === "reply" && r.reply, "Activating ARC Visor, boss.");
});

const diving = (parts: { id: string; name: string; level: 1 | 2 }[] = [], modelId: string | null = "heart") =>
  state({ deepDive: { active: true, modelId, modelName: "Heart", settings: {} as never, parts, focusPart: null, collection: null, actions: [] } });

test("deep dive voice commands", () => {
  assert.deepEqual(actionsOf("deep dive the heart"), [{ action: "DEEP_DIVE", enabled: true, model: "heart" }]);
  assert.deepEqual(actionsOf("JARVIS, deep dive into my drone"), [{ action: "DEEP_DIVE", enabled: true, model: "drone" }]);
  assert.deepEqual(actionsOf("open deep dive"), [{ action: "DEEP_DIVE", enabled: true }]);
  assert.deepEqual(actionsOf("exit deep dive"), [{ action: "DEEP_DIVE", enabled: false }]);
  // Only inside Deep Dive:
  assert.equal(actionsOf("turn on ar mode"), null);
  const s = diving();
  assert.deepEqual(actionsOf("turn on AR mode", s), [{ action: "DEEP_DIVE_SET", ar: true }]);
  assert.deepEqual(actionsOf("turn off the hologram", s), [{ action: "DEEP_DIVE_SET", ar: false }]);
  assert.deepEqual(actionsOf("make the background black", s), [{ action: "DEEP_DIVE_SET", bg: "black" }]);
  assert.deepEqual(actionsOf("dark blue background", s), [{ action: "DEEP_DIVE_SET", bg: "dark blue" }]);
  assert.deepEqual(actionsOf("change the hologram colour to green", s), [{ action: "DEEP_DIVE_SET", color: "green" }]);
  assert.deepEqual(actionsOf("x-ray view", s), [{ action: "DEEP_DIVE_SET", style: "xray" }]);
  assert.deepEqual(actionsOf("explode it", s), [{ action: "DEEP_DIVE_SET", explode: 1 }]);
  assert.equal(actionsOf("make the background flurple", s), null); // unknown colour → LLM
});

test("deep dive parts and carousel by voice", () => {
  const parts = [
    { id: "aorta", name: "Aorta", level: 1 as const },
    { id: "left-ventricle", name: "Left ventricle", level: 1 as const },
  ];
  assert.deepEqual(actionsOf("show me the left ventricle", diving(parts)), [{ action: "FOCUS_PART", part: "left-ventricle" }]);
  assert.deepEqual(actionsOf("what is the aorta", diving(parts)), [{ action: "FOCUS_PART", part: "aorta" }]);
  assert.equal(matchPart("the ventricle", parts as never)?.id, "left-ventricle");
  const picking = diving([], null);
  assert.deepEqual(actionsOf("this one", picking), [{ action: "CAROUSEL", command: "select" }]);
  assert.deepEqual(actionsOf("next", picking), [{ action: "CAROUSEL", command: "next" }]);
});

test("colour names resolve to hex", () => {
  assert.equal(resolveColor("black"), "#000000");
  assert.equal(resolveColor("the colour dark blue"), "#020c24");
  assert.equal(resolveColor("#ABC".toLowerCase()), "#aabbcc");
  assert.equal(resolveColor("bright green"), "#2fe07a");
  assert.equal(resolveColor("flurple"), null);
});

test("explode by percent, spin on/off, labels without AR", () => {
  const s = state({ spaces: { PC: "PLAYGROUND", PHONE: "COMMAND" }, deepDive: { active: true, modelId: "heart", modelName: "Heart", settings: {} as never, parts: [], focusPart: null, collection: null, actions: [] } });
  assert.deepEqual(actionsOf("explode the view to 40%", s), [{ action: "DEEP_DIVE_SET", explode: 0.4 }]);
  assert.deepEqual(actionsOf("explode it 75 percent", s), [{ action: "DEEP_DIVE_SET", explode: 0.75 }]);
  assert.deepEqual(actionsOf("explode to half", s), [{ action: "DEEP_DIVE_SET", explode: 0.5 }]);
  assert.deepEqual(actionsOf("set explode to 20", s), [{ action: "DEEP_DIVE_SET", explode: 0.2 }]);
  assert.deepEqual(actionsOf("explode the view", s), [{ action: "DEEP_DIVE_SET", explode: 1 }]);
  assert.deepEqual(actionsOf("stop spin", s), [{ action: "DEEP_DIVE_SET", spin: 0 }]);
  assert.deepEqual(actionsOf("start spinning", s), [{ action: "DEEP_DIVE_SET", spin: 0.4 }]);
  assert.deepEqual(actionsOf("show labels", s), [{ action: "DEEP_DIVE_SET", labels: true, detail: "auto" }]);
  assert.deepEqual(actionsOf("hide labels", s), [{ action: "DEEP_DIVE_SET", labels: false }]);
  // Outside Deep Dive the same words drive the selected Playground object.
  assert.deepEqual(actionsOf("explode it to 30%"), [{ action: "EXPLODE_OBJECT", target: "selected", enabled: true, amount: 0.3 }]);
  assert.deepEqual(actionsOf("stop spin"), [{ action: "SPIN_OBJECT", target: "selected", enabled: false, speed: 0 }]);
});

test("collections, brightness and model actions by voice", () => {
  const s = state({ settings: { autoExecuteLowRisk: false, brightness: 0.3 } } as never);
  assert.deepEqual(actionsOf("JARVIS, pull up everything we have on Iron Man", s), [{ action: "DEEP_DIVE", enabled: true, collection: "ironman" }]);
  assert.deepEqual(actionsOf("show me all the spider man suits", s), [{ action: "DEEP_DIVE", enabled: true, collection: "spiderman" }]);
  assert.deepEqual(actionsOf("pull up everything on quantum physics", s), [{ action: "DEEP_DIVE", enabled: true, collection: "physics" }]);
  assert.deepEqual(actionsOf("show me everything", s), [{ action: "DEEP_DIVE", enabled: true, collection: "all" }]);
  assert.deepEqual(actionsOf("show me the earth", s), [{ action: "SPAWN_OBJECT", object: "earth" }]); // a single model, not a collection
  assert.deepEqual(actionsOf("deep dive the iron man suit", s), [{ action: "DEEP_DIVE", enabled: true, model: "mark3" }]);
  assert.deepEqual(actionsOf("set brightness to 40%", s), [{ action: "SET_BRIGHTNESS", value: 0.4 }]);
  // the category tabs send collection ids, which must resolve to themselves
  for (const id of ["ironman", "spiderman", "space", "physics", "radiation", "anatomy", "machines", "yours"]) assert.equal(resolveCollection(id), id);
  assert.equal(resolveCollection("my models"), "yours");
  const acts = [
    { id: "faceplate", label: "Faceplate", kind: "toggle" as const, words: ["faceplate", "helmet", "mask"], value: false },
    { id: "paint", label: "Paint", kind: "choice" as const, options: ["Classic", "Stealth", "Gold"], value: "Classic" },
  ];
  const d = state({ settings: { brightness: 0.3 } as never, spaces: { PC: "PLAYGROUND", PHONE: "COMMAND" }, deepDive: { active: true, modelId: "mark3", modelName: "Mark III", settings: {} as never, parts: [], focusPart: null, collection: null, actions: acts } });
  assert.deepEqual(actionsOf("open the faceplate", d), [{ action: "MODEL_ACTION", id: "faceplate", value: true }]);
  assert.deepEqual(actionsOf("switch model", d), [{ action: "DEEP_DIVE", enabled: true }]);
  assert.deepEqual(actionsOf("back to the carousel", d), [{ action: "DEEP_DIVE", enabled: true }]);
  assert.deepEqual(actionsOf("close the helmet", d), [{ action: "MODEL_ACTION", id: "faceplate", value: false }]);
  assert.deepEqual(actionsOf("open it", d), [{ action: "MODEL_ACTION", id: "faceplate", value: true }]);
  assert.deepEqual(actionsOf("paint it gold", d), [{ action: "MODEL_ACTION", id: "paint", value: "Gold" }]);
  assert.deepEqual(actionsOf("stealth mode", d), [{ action: "MODEL_ACTION", id: "paint", value: "Stealth" }]);
});

test("radiation & light models by voice", () => {
  assert.deepEqual(actionsOf("show me the x ray machine"), [{ action: "SPAWN_OBJECT", object: "xray_machine" }]);
  assert.deepEqual(actionsOf("JARVIS, open the x-ray animation"), [{ action: "SPAWN_OBJECT", object: "xray_machine" }]);
  assert.deepEqual(actionsOf("deep dive the gamma rays"), [{ action: "DEEP_DIVE", enabled: true, model: "gamma_rays" }]);
  assert.deepEqual(actionsOf("show me a photon"), [{ action: "SPAWN_OBJECT", object: "photon" }]);
  assert.deepEqual(actionsOf("spawn a laser"), [{ action: "SPAWN_OBJECT", object: "laser" }]);
  assert.deepEqual(actionsOf("show me a neutron star"), [{ action: "SPAWN_OBJECT", object: "pulsar" }]);
  assert.deepEqual(actionsOf("open the large hadron collider"), [{ action: "SPAWN_OBJECT", object: "collider" }]);
  assert.deepEqual(actionsOf("deep dive the fusion reactor"), [{ action: "DEEP_DIVE", enabled: true, model: "tokamak" }]);
  assert.deepEqual(actionsOf("pull up everything on radiation"), [{ action: "DEEP_DIVE", enabled: true, collection: "radiation" }]);
  assert.equal(resolveCollection("radiation"), "radiation");
  // on the photon's stage, the band switches by voice ("x ray" without the hyphen too)
  const bands = { id: "band", label: "Band", kind: "choice" as const, options: ["Radio", "Visible", "Ultraviolet", "X-ray", "Gamma"], words: ["band", "spectrum"], value: "Visible" };
  const d = state({ spaces: { PC: "PLAYGROUND", PHONE: "COMMAND" }, deepDive: { active: true, modelId: "photon", modelName: "Photon & EM Wave", settings: {} as never, parts: [], focusPart: null, collection: null, actions: [bands] } });
  assert.deepEqual(actionsOf("switch to x ray", d), [{ action: "MODEL_ACTION", id: "band", value: "X-ray" }]);
  assert.deepEqual(actionsOf("change the band to ultraviolet", d), [{ action: "MODEL_ACTION", id: "band", value: "Ultraviolet" }]);
  // …but naming the machine still opens the machine (Jarvis turns the spawn into a dive while diving)
  assert.deepEqual(actionsOf("open the x ray machine", d), [{ action: "SPAWN_OBJECT", object: "xray_machine" }]);
});

test("light / dark theme by voice", () => {
  assert.deepEqual(actionsOf("JARVIS, switch to light mode"), [{ action: "SET_THEME", theme: "light" }]);
  assert.deepEqual(actionsOf("dark mode"), [{ action: "SET_THEME", theme: "dark" }]);
  assert.deepEqual(actionsOf("turn on dark theme"), [{ action: "SET_THEME", theme: "dark" }]);
  assert.deepEqual(actionsOf("go dark"), [{ action: "SET_THEME", theme: "dark" }]);
  assert.deepEqual(actionsOf("change to light"), [{ action: "SET_THEME", theme: "light" }]);
  assert.deepEqual(actionsOf("turn off dark mode"), [{ action: "SET_THEME", theme: "light" }]);
  assert.deepEqual(actionsOf("toggle the theme"), [{ action: "SET_THEME", theme: "toggle" }]);
  // still the radiation & light collection, and still the brightness
  assert.deepEqual(actionsOf("pull up everything on light"), [{ action: "DEEP_DIVE", enabled: true, collection: "radiation" }]);
  assert.deepEqual(actionsOf("make it darker", state({ settings: { brightness: 0.5 } } as never)), [{ action: "SET_BRIGHTNESS", value: 0.3 }]);
});

test("JARVIS's own voice by voice", () => {
  const voices = [
    { id: "en_US-bryce-medium", name: "Bryce", language: "English (United States)", quality: "medium", speakers: 1, sizeMb: 63.5 },
    { id: "en_GB-alan-medium", name: "Alan", language: "English (Great Britain)", quality: "medium", speakers: 1, sizeMb: 63.2 },
  ];
  const s = state({ voice: { id: "en_US-bryce-medium", speed: 1, pitch: 0, fx: 0.5, voices, engineReady: true, download: null } } as never);
  assert.deepEqual(actionsOf("JARVIS, talk faster", s), [{ action: "SET_VOICE", speed: 1.1 }]);
  assert.deepEqual(actionsOf("speak a bit slower", s), [{ action: "SET_VOICE", speed: 0.9 }]);
  assert.deepEqual(actionsOf("make your voice deeper", s), [{ action: "SET_VOICE", pitch: -1 }]);
  assert.deepEqual(actionsOf("turn off the voice effect", s), [{ action: "SET_VOICE", fx: 0 }]);
  assert.deepEqual(actionsOf("turn on the jarvis effect", s), [{ action: "SET_VOICE", fx: 0.5 }]);
  assert.deepEqual(actionsOf("reset your voice", s), [{ action: "SET_VOICE", speed: 1.3, pitch: 0 }]);
  assert.deepEqual(actionsOf("change your voice to alan", s), [{ action: "SET_VOICE", voice: "en_GB-alan-medium" }]);
  assert.deepEqual(actionsOf("use the bryce voice", s), [{ action: "SET_VOICE", voice: "en_US-bryce-medium" }]);
  assert.deepEqual(actionsOf("change your voice to morgan freeman", s), []); // not installed: JARVIS says so, nothing changes
  assert.deepEqual(actionsOf("what voice are you using", s), []);
});
