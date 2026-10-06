import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLocalIntent, stripWake } from "./localIntents";
import { parseModelOutput } from "./Jarvis";
import { classify } from "../security/risk";
import { chunkForSpeech } from "../voice/VoiceProvider";
import type { ArcState } from "../../shared/types";

const state = (overrides: Partial<ArcState> = {}): ArcState =>
  ({
    mode: "COMMAND",
    pending: null,
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
