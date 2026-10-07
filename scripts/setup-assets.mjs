// Downloads / copies runtime assets into client/public so ARC serves everything
// locally (no CDN dependency at runtime). Safe to re-run; existing files are kept.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "client", "public");

const SSS = "https://www.solarsystemscope.com/textures/download";
const THREE_TEX = "https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/textures/planets";
const downloads = [
  {
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
    out: "models/hand_landmarker.task",
  },
  {
    // VISOR: 478 face landmarks incl. irises, blendshapes (blink) and head pose.
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
    out: "models/face_landmarker.task",
  },
  { url: `${THREE_TEX}/earth_atmos_2048.jpg`, out: "textures/earth_day.jpg" },
  { url: `${THREE_TEX}/earth_normal_2048.jpg`, out: "textures/earth_normal.jpg" },
  { url: `${THREE_TEX}/earth_specular_2048.jpg`, out: "textures/earth_specular.jpg" },
  { url: `${THREE_TEX}/earth_lights_2048.png`, out: "textures/earth_lights.png" },
  { url: `${THREE_TEX}/earth_clouds_1024.png`, out: "textures/earth_clouds.png" },
  { url: `${THREE_TEX}/moon_1024.jpg`, out: "textures/moon.jpg" },
  // Planet textures © Solar System Scope (solarsystemscope.com/textures), CC BY 4.0
  ...["mars", "saturn", "sun", "moon", "jupiter", "mercury", "venus_atmosphere", "uranus", "neptune", "stars_milky_way"].map((n) => ({ url: `${SSS}/2k_${n}.jpg`, out: `textures/2k_${n}.jpg` })),
  { url: `${SSS}/2k_saturn_ring_alpha.png`, out: "textures/2k_saturn_ring_alpha.png" },
  {
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson",
    out: "geo/countries.geojson",
    transform: slimGeojson,
  },
];

function slimGeojson(buf) {
  const data = JSON.parse(buf.toString("utf8"));
  const round = (c) => (typeof c[0] === "number" ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] : c.map(round));
  return Buffer.from(
    JSON.stringify({
      type: "FeatureCollection",
      features: data.features.map((f) => ({
        type: "Feature",
        properties: { name: f.properties.NAME || f.properties.ADMIN },
        geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) },
      })),
    }),
  );
}

async function download({ url, out, transform }) {
  const target = path.join(pub, out);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    console.log(`  ✓ ${out} (cached)`);
    return true;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let buf = Buffer.from(await res.arrayBuffer());
    if (transform) buf = transform(buf);
    fs.writeFileSync(target, buf);
    console.log(`  ↓ ${out} (${(buf.length / 1024).toFixed(0)} KB)`);
    return true;
  } catch (err) {
    console.warn(`  ✗ ${out} — ${err.message} (ARC will fall back gracefully)`);
    return false;
  }
}

console.log("ARC asset setup");
const wasmSrc = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDst = path.join(pub, "mediapipe");
fs.mkdirSync(wasmDst, { recursive: true });
for (const f of fs.readdirSync(wasmSrc)) fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmDst, f));
console.log("  ✓ mediapipe wasm runtime");

// Draco decoder for compressed glTF/GLB models in the library.
const dracoSrc = path.join(root, "node_modules", "three", "examples", "jsm", "libs", "draco", "gltf");
const dracoDst = path.join(pub, "draco");
fs.mkdirSync(dracoDst, { recursive: true });
for (const f of fs.readdirSync(dracoSrc)) fs.copyFileSync(path.join(dracoSrc, f), path.join(dracoDst, f));
console.log("  ✓ draco decoder");

const results = await Promise.all(downloads.map(download));
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `Done with ${failed} missing asset(s).` : "All assets ready.");
