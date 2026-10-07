import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated data dir: this test must never touch the real session.
process.env.ARC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "arc-spaces-"));
const { ArcCore } = await import("./ArcCore");
const { CameraManager } = await import("../camera/CameraManager");

test("phone and PC have their own spaces", () => {
  const core = new ArcCore();
  core.deviceConnected("PC", "PC");
  core.deviceConnected("PHONE", "Phone");
  const s = core.getState();
  assert.deepEqual(s.spaces, { PC: "COMMAND", PHONE: "COMMAND" });
  assert.equal(s.primaryDevice, "PHONE");
  assert.equal(s.voiceInput, "PHONE");

  // "enter playground" said on the phone: only the PC changes.
  core.setMode("PLAYGROUND", "PHONE");
  assert.deepEqual(s.spaces, { PC: "PLAYGROUND", PHONE: "COMMAND" });
  assert.equal(s.primaryDevice, "PC"); // JARVIS speaks on the PC in the Playground
  assert.deepEqual(s.vision.routes, [{ source: "PC", consumer: "PC" }]);

  // Visor is phone-first even when asked from the PC; the PC stays in the Playground.
  core.setMode("VISOR", "PC");
  assert.deepEqual(s.spaces, { PC: "PLAYGROUND", PHONE: "VISOR" });
  assert.equal(s.visor.device, "PHONE");
  assert.equal(s.primaryDevice, "PHONE");
  assert.deepEqual(s.vision.routes, [{ source: "PHONE", consumer: "PHONE" }, { source: "PC", consumer: "PC" }]);

  // Exit visor returns the phone to Command; "command mode" from the phone (already there) brings the PC back.
  core.exitVisor();
  assert.deepEqual(s.spaces, { PC: "PLAYGROUND", PHONE: "COMMAND" });
  core.setMode("COMMAND", "PHONE");
  assert.deepEqual(s.spaces, { PC: "COMMAND", PHONE: "COMMAND" });
  assert.deepEqual(s.vision.routes, []);
});

test("visor runs on the PC without a phone; phone disconnect resets its space", () => {
  const core = new ArcCore();
  core.deviceConnected("PC", "PC");
  core.setMode("VISOR", "PC");
  assert.equal(core.getState().spaces.PC, "VISOR");
  assert.equal(core.getState().visor.device, "PC");
  core.exitVisor();
  assert.equal(core.getState().spaces.PC, "COMMAND");

  core.deviceConnected("PHONE", "Phone");
  core.setMode("VISOR", "PHONE");
  core.deviceDisconnected("PHONE");
  assert.equal(core.getState().spaces.PHONE, "COMMAND");
  assert.equal(core.getState().visor.device, null);
});

test("deep dive closes when the PC leaves the Playground and remembers looks per model", () => {
  const core = new ArcCore();
  core.deviceConnected("PC", "PC");
  core.setSpace("PC", "PLAYGROUND");
  core.setDeepDive(true, "heart", "Heart");
  core.updateDeepDive({ ar: true, bg: "#000000" });
  core.setDeepDive(true, "brain", "Brain");
  assert.equal(core.getState().deepDive.settings.ar, false);
  core.setDeepDive(true, "heart", "Heart");
  assert.equal(core.getState().deepDive.settings.bg, "#000000");
  core.setSpace("PC", "COMMAND");
  assert.equal(core.getState().deepDive.active, false);
});

test("phone hand tracking is opt-in", () => {
  const cam = new CameraManager("PC");
  const connected = { PHONE: true, PC: true };
  assert.deepEqual(cam.routes({ PC: "COMMAND", PHONE: "COMMAND" }, connected), []);
  cam.phoneHands = true;
  assert.deepEqual(cam.routes({ PC: "COMMAND", PHONE: "COMMAND" }, connected), [{ source: "PHONE", consumer: "PHONE" }]);
  cam.switchCamera("PHONE");
  assert.deepEqual(cam.routes({ PC: "PLAYGROUND", PHONE: "COMMAND" }, connected), [{ source: "PHONE", consumer: "PC" }]);
});
