import { test } from "node:test";
import assert from "node:assert/strict";
import { describeVoice, findVoice, parseVoiceConfig, resolveVoiceSource, voiceFromListing, voiceTiming, type PiperConfig } from "./piperVoices";
import { LruCache } from "./PiperVoice";
import { VoiceChain, type Synthesis, type VoiceProvider } from "./VoiceProvider";

const BRYCE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/bryce/medium/en_US-bryce-medium.onnx";

test("voice links and names resolve to Hugging Face downloads", () => {
  const bryce = { id: "en_US-bryce-medium", onnx: BRYCE, json: `${BRYCE}.json` };
  // a name, a file name, the samples page, the folder page, the file pages
  assert.deepEqual(resolveVoiceSource("en_US-bryce-medium"), bryce);
  assert.deepEqual(resolveVoiceSource("en_US-bryce-medium.onnx"), bryce);
  assert.deepEqual(resolveVoiceSource("https://rhasspy.github.io/piper-samples/#en_US-bryce-medium"), bryce);
  assert.deepEqual(resolveVoiceSource("https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/bryce/medium"), bryce);
  assert.deepEqual(resolveVoiceSource("https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/bryce/medium/en_US-bryce-medium.onnx"), bryce);
  assert.deepEqual(resolveVoiceSource("https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/bryce/medium/en_US-bryce-medium.onnx.json?download=true"), bryce);
  assert.equal((resolveVoiceSource("en_GB-northern_english_male-medium") as { onnx: string }).onnx, "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx");
  // someone's own voice in their own repo: a file, or a folder to list
  assert.deepEqual(resolveVoiceSource("https://huggingface.co/someone/my-voices/blob/main/jarvis/jarvis-high.onnx"), {
    id: "jarvis-high",
    onnx: "https://huggingface.co/someone/my-voices/resolve/main/jarvis/jarvis-high.onnx",
    json: "https://huggingface.co/someone/my-voices/resolve/main/jarvis/jarvis-high.onnx.json",
  });
  assert.deepEqual(resolveVoiceSource("https://huggingface.co/someone/my-voices/tree/main/jarvis"), { repo: "someone/my-voices", rev: "main", path: "jarvis" });
  assert.deepEqual(resolveVoiceSource("https://huggingface.co/someone/my-voices"), { repo: "someone/my-voices", rev: "main", path: "" });
});

test("voices only come from Hugging Face", () => {
  for (const bad of [
    "https://example.com/voice.onnx",
    "https://huggingface.co.evil.com/a/b/resolve/main/x.onnx",
    "http://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/bryce/medium",
    "file:///C:/Windows/system32/x.onnx",
    "https://rhasspy.github.io/piper-samples/",
    "https://huggingface.co/a/b/resolve/main/../../x.onnx",
    "https://huggingface.co/a/b/resolve/main/..%2F..%2Fevil.onnx",
    "make him sound cool",
  ]) {
    const r = resolveVoiceSource(bad);
    assert.ok("error" in r || ("repo" in r && !r.path.includes("..")), `${bad} → ${JSON.stringify(r)}`);
    if ("onnx" in r) assert.fail(`${bad} should not download`);
  }
});

test("a folder listing yields exactly one voice", () => {
  const f = { repo: "someone/my-voices", rev: "main", path: "jarvis" };
  const one = voiceFromListing(f, [
    { type: "file", path: "jarvis/jarvis-high.onnx" },
    { type: "file", path: "jarvis/jarvis-high.onnx.json" },
    { type: "file", path: "jarvis/README.md" },
  ]);
  assert.deepEqual(one, {
    id: "jarvis-high",
    onnx: "https://huggingface.co/someone/my-voices/resolve/main/jarvis/jarvis-high.onnx",
    json: "https://huggingface.co/someone/my-voices/resolve/main/jarvis/jarvis-high.onnx.json",
  });
  assert.ok("error" in voiceFromListing(f, [{ type: "file", path: "jarvis/model.onnx" }])); // no config next to it
  assert.ok("error" in voiceFromListing(f, [
    { type: "file", path: "a.onnx" },
    { type: "file", path: "a.onnx.json" },
    { type: "file", path: "b.onnx" },
    { type: "file", path: "b.onnx.json" },
  ]));
});

test("voice configs are validated and described", () => {
  const cfg = parseVoiceConfig({
    dataset: "bryce",
    audio: { sample_rate: 22050, quality: "medium" },
    language: { code: "en_US", name_english: "English", country_english: "United States" },
    inference: { length_scale: 1 },
    num_speakers: 1,
    phoneme_id_map: { a: [1] },
  }) as PiperConfig;
  assert.ok(cfg);
  assert.deepEqual(describeVoice("en_US-bryce-medium", cfg, 63_531_379), { id: "en_US-bryce-medium", name: "Bryce", language: "English (United States)", quality: "medium", speakers: 1, sizeMb: 63.5 });
  assert.equal(describeVoice("en_GB-northern_english_male-medium", cfg, 1).name, "Northern English Male");
  assert.equal(describeVoice("jarvis-high", { ...cfg, dataset: "my_jarvis" }, 1).name, "My Jarvis");
  assert.equal(parseVoiceConfig({ audio: { sample_rate: 22050 } }), null); // no phonemes: not a Piper voice
  assert.equal(parseVoiceConfig("nope"), null);
  assert.equal(parseVoiceConfig(null), null);
});

test("speed and pitch: Piper re-times the speech so only the pitch moves", () => {
  assert.deepEqual(voiceTiming(1, 0), { lengthScale: 1, rate: 1 });
  assert.deepEqual(voiceTiming(1.25, 0), { lengthScale: 0.8, rate: 1 });
  assert.deepEqual(voiceTiming(1, -2), { lengthScale: 0.891, rate: 0.8909 });
  assert.deepEqual(voiceTiming(1, 12), { lengthScale: 2, rate: 2 });
  assert.deepEqual(voiceTiming(1, 0, 1.1), { lengthScale: 1.1, rate: 1 }); // the voice's own default length
  // played back at `rate`, the speech lasts exactly 1/speed of normal
  for (const [speed, pitch] of [[1.2, -3], [0.8, 2], [1, -4]]) {
    const { lengthScale, rate } = voiceTiming(speed, pitch);
    assert.ok(Math.abs(lengthScale / rate - 1 / speed) < 0.002, `${speed} ${pitch}`);
  }
});

test("voices are found by id or by name", () => {
  const voices = [
    { id: "en_US-bryce-medium", name: "Bryce", language: "", quality: "", speakers: 1, sizeMb: 1 },
    { id: "en_GB-northern_english_male-medium", name: "Northern English Male", language: "", quality: "", speakers: 1, sizeMb: 1 },
  ];
  assert.equal(findVoice(voices, "en_US-bryce-medium")?.name, "Bryce");
  assert.equal(findVoice(voices, "bryce")?.name, "Bryce");
  assert.equal(findVoice(voices, "the northern english male")?.name, "Northern English Male");
  assert.equal(findVoice(voices, "morgan freeman"), null);
  assert.equal(findVoice(voices, ""), null);
});

test("reply cache keeps the most recently used", () => {
  const c = new LruCache<number>(2);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1); // a is fresh again
  c.set("c", 3); // b goes
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  c.deleteWhere((k) => k === "a");
  assert.equal(c.size, 1);
});

test("the voice chain falls back so JARVIS is never silent", async () => {
  const voice = (name: string, engine: "PIPER" | "GROQ" | "LOCAL", ok: boolean, available = true): VoiceProvider => ({
    name,
    engine,
    available,
    unavailableReason: available ? undefined : `${name} off`,
    synthesize: async (): Promise<Synthesis> => {
      if (!ok) throw new Error(`${name} failed`);
      return { mime: "audio/wav", data: Buffer.from(name) };
    },
  });
  const chain = new VoiceChain([voice("piper", "PIPER", false), voice("groq", "GROQ", false, false), voice("windows", "LOCAL", true)]);
  assert.equal(chain.engine, "PIPER");
  assert.equal(String((await chain.synthesize("hi")).data), "windows"); // piper failed, groq is off
  const none = new VoiceChain([voice("piper", "PIPER", true, false), voice("windows", "LOCAL", true, false)]);
  assert.equal(none.available, false);
  assert.equal(none.unavailableReason, "piper off; windows off");
  await assert.rejects(none.synthesize("hi"));
});
