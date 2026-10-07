import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, part } from "./parts";
import { holoGain } from "../holo";

/**
 * Arc reactors (ARC's own procedural recreations, not official assets), built like machined
 * parts: lathe-turned housings with stepped bevels and concentric tool marks, copper windings
 * with individual wire turns, clamps, spokes, screws, cables out of the back, a glowing core
 * and a lens. Interactive: power up/down, open the casing.
 */

const TAU = Math.PI * 2;
const texCache = new Map<string, THREE.Texture>();

/** Height field → normal map (tileable). */
function normalTexture(key: string, w: number, h: number, height: (x: number, y: number) => number, strength: number, repeat: [number, number]): THREE.Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(w, h);
  const H = (x: number, y: number) => height(((x % w) + w) % w, ((y % h) + h) % h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (-dx / l) * 127.5 + 127.5;
      img.data[i + 1] = (-dy / l) * 127.5 + 127.5;
      img.data[i + 2] = (1 / l) * 127.5 + 127.5;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = THREE.NoColorSpace;
  texCache.set(key, t);
  return t;
}

/** Radial falloff for the light behind the windings: bright at the core, dark at the rim. */
function radialGlow(): THREE.Texture {
  const hit = texCache.get("radial");
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(128, 128, 10, 128, 128, 128);
  gr.addColorStop(0, "#ffffff");
  gr.addColorStop(0.35, "#c8c8c8");
  gr.addColorStop(0.75, "#4a4a4a");
  gr.addColorStop(1, "#141414");
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set("radial", t);
  return t;
}

/** Copper wire turns: rounded ridges across the winding. */
const wireMap = () => normalTexture("wire", 16, 4, (x) => Math.sqrt(Math.abs(Math.sin((Math.PI * x) / 16))), 2.2, [1, 1]);
/** Concentric tool marks for turned parts (stripes along the lathe profile). */
const turnedMap = () => normalTexture("turned", 8, 256, (_x, y) => 0.5 + 0.5 * Math.sin(y * 1.7) + 0.3 * Math.sin(y * 0.43), 0.35, [1, 1]);

function materials() {
  return {
    steel: new THREE.MeshPhysicalMaterial({ color: 0xaeb6bf, metalness: 1, roughness: 0.3, normalMap: turnedMap(), normalScale: new THREE.Vector2(0.45, 0.45), clearcoat: 0.2, clearcoatRoughness: 0.25 }),
    brushed: new THREE.MeshStandardMaterial({ color: 0x9aa2ab, metalness: 1, roughness: 0.34, normalMap: turnedMap(), normalScale: new THREE.Vector2(0.6, 0.6) }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2c3138, metalness: 0.92, roughness: 0.36 }),
    black: new THREE.MeshStandardMaterial({ color: 0x101215, metalness: 0.6, roughness: 0.5 }),
    copper: new THREE.MeshPhysicalMaterial({ color: 0xc8793f, metalness: 1, roughness: 0.3, normalMap: wireMap(), normalScale: new THREE.Vector2(0.9, 0.9), clearcoat: 0.4, clearcoatRoughness: 0.2 }),
    insulation: new THREE.MeshStandardMaterial({ color: 0x1d2a33, metalness: 0.1, roughness: 0.55 }),
    cable: new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.2, roughness: 0.6 }),
  };
}

/** Lathe from (radius, z) pairs, axis along +z. */
function turned(profile: [number, number][], seg = 96, phiStart = 0): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, z]) => new THREE.Vector2(r, z)),
    seg,
    phiStart,
  );
  g.rotateX(Math.PI / 2);
  return g;
}

function screw(m: THREE.Material, r: number, dark: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const head = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, r * 0.7, 6), m);
  head.rotation.x = Math.PI / 2;
  g.add(head);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(r * 1.4, r * 0.22, r * 0.3), dark);
  slot.position.z = r * 0.3;
  g.add(slot);
  return g;
}

function buildReactor(kind: "round" | "triangle"): BuiltObject {
  const M = materials();
  const glowColor = new THREE.Color(kind === "round" ? 0xcff4ff : 0xdcf7ff);
  const softColor = new THREE.Color(0x4fbfff);
  const glow = new THREE.MeshBasicMaterial({ color: glowColor, toneMapped: false });
  const softGlow = new THREE.MeshBasicMaterial({ color: softColor, toneMapped: false, map: radialGlow() });
  const content = new THREE.Group();

  // ─── housing: turned can with stepped bevels ───
  const housing = new THREE.Group();
  content.add(housing);
  const can = new THREE.Mesh(
    turned([
      [0.0, -0.42],
      [0.84, -0.42],
      [0.9, -0.4],
      [0.96, -0.34],
      [0.98, -0.1],
      [1.0, -0.06],
      [1.0, 0.0],
      [0.96, 0.02],
      [0.9, 0.02],
      [0.9, -0.02],
      [0.86, -0.04],
      [0.84, -0.3],
      [0.0, -0.3],
    ]),
    M.brushed,
  );
  housing.add(can);
  const well = new THREE.Mesh(new THREE.CircleGeometry(0.84, 96), M.black);
  well.position.z = -0.295;
  housing.add(well);
  // cables out of the back (Mk I) / clean back (new element)
  if (kind === "round") {
    for (let i = 0; i < 3; i++) {
      const a = -0.6 + i * 0.6;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(Math.cos(a) * 0.5, Math.sin(a) * 0.5 - 0.2, -0.42),
        new THREE.Vector3(Math.cos(a) * 0.62, Math.sin(a) * 0.4 - 0.5, -0.6),
        new THREE.Vector3(Math.cos(a) * 0.7, -1.0, -0.7),
        new THREE.Vector3(Math.cos(a) * 0.75, -1.5, -0.66),
      ]);
      const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.045, 10), M.cable);
      housing.add(cable);
      const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 16), M.dark);
      boot.position.copy(curve.getPoint(0));
      boot.rotation.x = Math.PI / 2;
      housing.add(boot);
    }
  }

  // ─── glow plate behind everything (seen through the gaps) ───
  const backGlow = new THREE.Mesh(new THREE.CircleGeometry(0.8, 96), softGlow);
  backGlow.position.z = -0.28;
  content.add(backGlow);

  const coils = new THREE.Group();
  content.add(coils);
  const coreGroup = new THREE.Group();
  content.add(coreGroup);
  let innerRing: THREE.Object3D;

  if (kind === "round") {
    // ─── ten copper windings round a toroidal core, with clamps between them ───
    const R = 0.58;
    const core = new THREE.Mesh(new THREE.TorusGeometry(R, 0.1, 20, 120), M.insulation);
    core.position.z = -0.14;
    coils.add(core);
    for (let i = 0; i < 10; i++) {
      const a0 = (i / 10) * TAU + 0.05;
      const span = TAU / 10 - 0.1;
      const geo = new THREE.TorusGeometry(R, 0.135, 24, 40, span);
      // wire turns: ~34 per winding (uv.x runs along the arc)
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * 34);
      const w = new THREE.Mesh(geo, M.copper);
      w.rotation.z = a0;
      w.position.z = -0.14;
      coils.add(w);
      // clamp
      const b = a0 + span + 0.05;
      const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.36, 0.32), M.dark);
      clamp.position.set(Math.cos(b) * R, Math.sin(b) * R, -0.14);
      clamp.rotation.z = b;
      coils.add(clamp);
      const bolt = screw(M.steel, 0.028, M.black);
      bolt.position.set(Math.cos(b) * R, Math.sin(b) * R, 0.03);
      coils.add(bolt);
    }
    // spokes behind the windings
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + TAU / 20;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.035, 0.05), M.dark);
      spoke.position.set(Math.cos(a) * 0.62, Math.sin(a) * 0.62, -0.25);
      spoke.rotation.z = a;
      coils.add(spoke);
    }
    // inner contact ring
    innerRing = new THREE.Mesh(
      turned([
        [0.3, -0.24],
        [0.4, -0.24],
        [0.42, -0.2],
        [0.42, -0.04],
        [0.4, 0.0],
        [0.34, 0.0],
        [0.32, -0.04],
        [0.3, -0.04],
      ]),
      M.steel,
    );
    content.add(innerRing);
    // palladium core: glowing disc, machined hub, fine ring
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 72), glow);
    disc.rotation.x = Math.PI / 2;
    disc.position.z = -0.12;
    coreGroup.add(disc);
    const hub = new THREE.Mesh(
      turned([
        [0.0, -0.06],
        [0.14, -0.06],
        [0.15, -0.04],
        [0.15, 0.02],
        [0.12, 0.04],
        [0.07, 0.04],
        [0.06, 0.06],
        [0.0, 0.06],
      ]),
      M.dark,
    );
    hub.scale.setScalar(0.8);
    coreGroup.add(hub);
    const fine = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.012, 10, 72), M.steel);
    fine.position.z = -0.06;
    coreGroup.add(fine);
  } else {
    // ─── new element: triangular core in a ring of radial slats ───
    const tri = (r: number, round: number) => {
      const pts = [-90, 30, 150].map((d) => new THREE.Vector2(Math.cos((d * Math.PI) / 180) * r, Math.sin((d * Math.PI) / 180) * r));
      const s = new THREE.Shape();
      for (let i = 0; i < 3; i++) {
        const p = pts[i];
        const a = pts[(i + 2) % 3];
        const b = pts[(i + 1) % 3];
        const s0 = p.clone().lerp(a, round);
        const e0 = p.clone().lerp(b, round);
        if (i === 0) s.moveTo(s0.x, s0.y);
        else s.lineTo(s0.x, s0.y);
        s.quadraticCurveTo(p.x, p.y, e0.x, e0.y);
      }
      s.closePath();
      return s;
    };
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * TAU;
      const slat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.022, 0.16), M.dark);
      slat.position.set(Math.cos(a) * 0.66, Math.sin(a) * 0.66, -0.16);
      slat.rotation.z = a;
      coils.add(slat);
    }
    const ringOuter = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.03, 12, 120), M.steel);
    ringOuter.position.z = -0.08;
    coils.add(ringOuter);
    const glowTri = tri(0.48, 0.2);
    glowTri.holes.push(new THREE.Path(tri(0.25, 0.24).getPoints(10)));
    const triMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(glowTri, { depth: 0.08, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 3, curveSegments: 12 }), glow);
    triMesh.position.z = -0.16;
    coreGroup.add(triMesh);
    const frame = tri(0.54, 0.19);
    frame.holes.push(new THREE.Path(tri(0.495, 0.2).getPoints(12)));
    const frameMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(frame, { depth: 0.14, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2, curveSegments: 12 }), M.steel);
    frameMesh.position.z = -0.17;
    coreGroup.add(frameMesh);
    const innerFrame = tri(0.25, 0.24);
    innerFrame.holes.push(new THREE.Path(tri(0.215, 0.25).getPoints(10)));
    const innerMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(innerFrame, { depth: 0.1, bevelEnabled: false, curveSegments: 10 }), M.steel);
    innerMesh.position.z = -0.15;
    coreGroup.add(innerMesh);
    const centre = new THREE.Mesh(new THREE.CircleGeometry(0.2, 48), M.black);
    centre.position.z = -0.17;
    coreGroup.add(centre);
    innerRing = frameMesh;
  }

  // ─── front bezel (opens with the casing) ───
  const casing = new THREE.Group();
  content.add(casing);
  const bezel = new THREE.Mesh(
    turned([
      [0.8, -0.02],
      [0.82, 0.03],
      [0.86, 0.07],
      [0.96, 0.08],
      [1.02, 0.05],
      [1.03, -0.01],
      [0.99, -0.03],
    ]),
    M.brushed,
  );
  casing.add(bezel);
  const nScrews = kind === "round" ? 10 : 6;
  for (let i = 0; i < nScrews; i++) {
    const a = ((i + 0.5) / nScrews) * TAU;
    const s = screw(M.steel, 0.032, M.black);
    s.position.set(Math.cos(a) * 0.92, Math.sin(a) * 0.92, 0.09);
    s.rotation.z = a * 1.7;
    casing.add(s);
  }
  // lens: a faint reflective disc (no light in front of it, so no glare)
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.81, 96),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, roughness: 0.04, metalness: 0, clearcoat: 1, depthWrite: false }),
  );
  lens.position.z = 0.0;
  lens.userData.noPick = true;
  lens.userData.keepMaterial = true;
  casing.add(lens);

  const light = new THREE.PointLight(glowColor, 1, 3.2, 2);
  light.position.z = -0.05;
  content.add(light);

  // ─── actions ───
  const state = { power: true, casing: false };
  const anim = { power: 1, open: 0 };
  let exploded = 0;
  const actions: ModelAction[] = [
    { id: "power", label: "Power", kind: "toggle", words: ["power", "reactor", "core", "energy"], value: true, parts: [coreGroup] },
    { id: "casing", label: "Casing", kind: "toggle", words: ["casing", "cover", "case", "glass", "housing", "bezel"], value: false, parts: [casing] },
  ];
  const parts = [
    part("Core", kind === "round" ? "Palladium core: the reaction glows inside the machined hub." : "New-element core: triangular, cleaner and far more powerful.", 1, at(coreGroup, 0, 0, 0.1), coreGroup),
    part(kind === "round" ? "Copper windings" : "Containment slats", kind === "round" ? "Ten coils of copper wire that contain and shape the plasma." : "Radial slats that focus the field around the core.", 1, at(coils, 0.58, 0.0, 0.05), coils),
    part("Front bezel", "Turned steel bezel with the lens; screws hold it to the housing.", 2, at(bezel, 0, 0.94, 0.1), casing),
    part("Contact ring", "Carries power from the core to the suit.", 2, at(innerRing, kind === "round" ? 0.42 : 0.5, 0, 0.05), innerRing),
    part("Housing", kind === "round" ? "Machined can; the cables carry power out of the back." : "Sealed housing for the new element.", 2, at(can, 0, -0.97, -0.2), housing),
  ];

  content.rotation.x = -0.2;
  const group = new THREE.Group();
  group.add(content);
  return {
    content: group,
    radius: 1.15,
    parts,
    actions,
    act(id, value) {
      if (id === "power") state.power = Boolean(value);
      if (id === "casing") state.casing = Boolean(value);
    },
    explode(a) {
      exploded = a;
      coils.position.z = 0.45 * a;
      coreGroup.position.z = 0.8 * a;
      innerRing.position.z = (kind === "round" ? 0.6 : 0) * a;
      housing.position.z = -0.4 * a;
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 3);
      anim.power += ((state.power ? 1 : 0) - anim.power) * k;
      anim.open += ((state.casing ? 1 : 0) - anim.open) * k;
      casing.position.z = anim.open * 0.8 + exploded * 1.1;
      casing.rotation.z = anim.open * 0.5;
      const flick = 0.94 + 0.06 * Math.sin(t * 13) * Math.sin(t * 7.3);
      const g = holoGain.value; // follows the brightness control
      const p = anim.power * flick;
      glow.color.copy(glowColor).multiplyScalar((0.05 + 1.45 * p) * g);
      softGlow.color.copy(softColor).multiplyScalar((0.01 + (kind === "round" ? 0.42 : 0.3) * p) * g);
      light.intensity = 1.2 * p * g;
      coreGroup.rotation.z += dt * 0.25 * anim.power * (kind === "round" ? 1 : 0.3);
      M.copper.emissive.setRGB(0.12 * p * g, 0.04 * p * g, 0.01 * p * g);
    },
  };
}

export const buildArcReactor = () => buildReactor("round");
export const buildArcReactor2 = () => buildReactor("triangle");
