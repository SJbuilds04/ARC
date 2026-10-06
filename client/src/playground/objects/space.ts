import * as THREE from "three";
import type { CountryInfo } from "@shared/catalog";
import type { BuiltObject } from "./types";
import { canvasTexture, glowSprite, holoTime, proceduralTexture, texture } from "../holo";

const D = Math.PI / 180;

/** Latitude/longitude → point on a sphere, matching three.js SphereGeometry UVs. */
export function latLonToVec3(lat: number, lon: number, r: number): THREE.Vector3 {
  const phi = (90 - lat) * D;
  const theta = (lon + 180) * D;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

/** Root rotation that turns (lat, lon) toward a viewer on +Z with north up. */
export function facingRotation(lat: number, lon: number): THREE.Euler {
  return new THREE.Euler(lat * D, (-90 - lon) * D, 0, "XYZ");
}

// ─── Country outlines (Natural Earth 110m, served locally) ───

type Ring = [number, number][];
let countriesPromise: Promise<Map<string, Ring[]>> | null = null;

function loadCountries(): Promise<Map<string, Ring[]>> {
  countriesPromise ??= fetch("/geo/countries.geojson")
    .then((r) => (r.ok ? r.json() : { features: [] }))
    .then((geo: { features: { properties: { name: string }; geometry: { type: string; coordinates: unknown } }[] }) => {
      const map = new Map<string, Ring[]>();
      for (const f of geo.features) {
        const polys = (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as Ring[][];
        map.set(f.properties.name, polys.flatMap((p) => p));
      }
      return map;
    })
    .catch(() => new Map());
  return countriesPromise;
}

function ringsToSegments(rings: Ring[], r: number): THREE.BufferGeometry {
  const pts: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = latLonToVec3(ring[i][1], ring[i][0], r);
      const b = latLonToVec3(ring[i + 1][1], ring[i + 1][0], r);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function blueFallback() {
  return proceduralTexture(512, 256, 3, (_u, v, n) => {
    const land = n > 0.55;
    const lat = Math.abs(v - 0.5) * 2;
    if (lat > 0.88) return [225, 235, 245];
    return land ? [40 + n * 80, 90 + n * 60, 50] : [10, 40 + n * 40, 90 + n * 60];
  });
}
const black = () => {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  return c;
};

const EARTH_VERT = /* glsl */ `
  varying vec2 vUv; varying vec3 vNormalW; varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const EARTH_FRAG = /* glsl */ `
  uniform sampler2D dayMap; uniform sampler2D nightMap; uniform sampler2D specMap; uniform vec3 sunDir;
  varying vec2 vUv; varying vec3 vNormalW; varying vec3 vPosW;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 L = normalize(sunDir);
    float ndl = dot(n, L);
    float dayMix = smoothstep(-0.2, 0.3, ndl);
    vec3 day = texture2D(dayMap, vUv).rgb * (0.2 + 1.0 * max(ndl, 0.0));
    vec3 night = texture2D(nightMap, vUv).rgb * vec3(1.0, 0.82, 0.55) * 1.8 + vec3(0.004, 0.012, 0.03);
    vec3 col = mix(night, day, dayMix);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 H = normalize(L + V);
    col += vec3(0.55, 0.7, 1.0) * pow(max(dot(n, H), 0.0), 36.0) * texture2D(specMap, vUv).r * dayMix * 0.7;
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    col += vec3(0.2, 0.55, 1.0) * fres * 0.55;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/**
 * Atmospheric limb glow. Rendered on the back faces of a slightly larger sphere:
 * brightest just outside the planet's silhouette, fading to zero at the outer edge.
 * `planetRadius / radius` sets where the limb sits.
 */
function atmosphere(radius: number, planetRadius: number, color: THREE.ColorRepresentation, strength = 1) {
  const limb = Math.sqrt(1 - (planetRadius / radius) ** 2);
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 64, 48),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength }, uLimb: { value: limb } },
      vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uStrength; uniform float uLimb; varying vec3 vN; varying vec3 vV;
        void main(){
          float d = clamp(-dot(normalize(vN), normalize(vV)), 0.0, 1.0);
          float i = pow(smoothstep(0.0, uLimb, d), 2.4) * uStrength;
          gl_FragColor = vec4(uColor * i, i);
        }`,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

export function buildEarth(): BuiltObject {
  const R = 1.1;
  const group = new THREE.Group();
  const sunDir = new THREE.Vector3(-1, 0.35, 0.8).normalize();

  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(R, 128, 96),
    new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: texture("/textures/earth_day.jpg", blueFallback) },
        nightMap: { value: texture("/textures/earth_lights.png", black) },
        specMap: { value: texture("/textures/earth_specular.jpg", black, false) },
        sunDir: { value: sunDir },
      },
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
    }),
  );
  globe.castShadow = true;

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.012, 96, 64),
    new THREE.MeshLambertMaterial({ map: texture("/textures/earth_clouds.png", black), color: 0xb8c4d0, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  clouds.userData.noPick = true;
  const atmo = atmosphere(R * 1.12, R, 0x4aa8ff, 0.75);
  atmo.userData.noPick = true;

  const borders = new THREE.Group();
  borders.userData.noPick = true;
  const highlight = new THREE.Group();
  highlight.userData.noPick = true;
  group.add(globe, clouds, atmo, borders, highlight);

  void loadCountries().then((countries) => {
    if (!countries.size) return;
    const all = new THREE.LineSegments(
      ringsToSegments([...countries.values()].flat(), R * 1.003),
      new THREE.LineBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    borders.add(all);
  });

  let pulse: THREE.Mesh | null = null;

  return {
    content: group,
    radius: R * 1.15,
    props: { atmosphere: true, clouds: true, labels: true },
    setProperty(prop, value) {
      if (prop === "atmosphere") atmo.visible = value;
      else if (prop === "clouds") clouds.visible = value;
      else if (prop === "labels") borders.visible = value;
      else if (prop === "wireframe") (globe.material as THREE.ShaderMaterial).wireframe = value;
      else return false;
      return true;
    },
    async showLocation(country: CountryInfo) {
      highlight.clear();
      const countries = await loadCountries();
      const rings = countries.get(country.ne);
      if (rings) {
        const line = new THREE.LineSegments(
          ringsToSegments(rings, R * 1.006),
          new THREE.LineBasicMaterial({ color: 0xbff3ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        highlight.add(line);
      }
      // Marker: beam + pulsing ring at the country's centre.
      const p = latLonToVec3(country.lat, country.lon, R * 1.01);
      const normal = p.clone().normalize();
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.35, 8), new THREE.MeshBasicMaterial({ color: 0x9fe9ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
      beam.position.copy(p.clone().add(normal.clone().multiplyScalar(0.175)));
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      pulse = new THREE.Mesh(
        new THREE.RingGeometry(0.03, 0.045, 48),
        new THREE.MeshBasicMaterial({ color: 0x9fe9ff, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      pulse.position.copy(p);
      pulse.lookAt(p.clone().multiplyScalar(2));
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      dot.position.copy(p);
      highlight.add(beam, pulse, dot);
      return facingRotation(country.lat, country.lon);
    },
    update(dt, t) {
      clouds.rotation.y += dt * 0.012;
      if (pulse) {
        const k = (t * 0.8) % 1;
        pulse.scale.setScalar(1 + k * 3);
        (pulse.material as THREE.MeshBasicMaterial).opacity = 1 - k;
      }
    },
  };
}

// ─── Real planet textures (© Solar System Scope, CC BY 4.0) with procedural fallbacks ───

const grey = (seed: number) => () => proceduralTexture(512, 256, seed, (_u, _v, n) => [110 + n * 100, 110 + n * 100, 115 + n * 100]);
const tinted = (seed: number, base: [number, number, number]) => () =>
  proceduralTexture(512, 256, seed, (_u, v, n) => {
    const band = Math.sin(v * 30 + n * 4) * 0.5 + 0.5;
    return [base[0] * (0.7 + band * 0.4), base[1] * (0.7 + band * 0.4), base[2] * (0.7 + band * 0.4)];
  });

function planetMaterial(url: string, fallback: () => HTMLCanvasElement, opts: { roughness?: number; bump?: number } = {}) {
  const map = texture(url, fallback);
  return new THREE.MeshStandardMaterial({
    map,
    bumpMap: opts.bump ? map : undefined,
    bumpScale: opts.bump ?? 0,
    roughness: opts.roughness ?? 0.95,
    metalness: 0,
    envMapIntensity: 0.12,
  });
}

export function buildMoon(): BuiltObject {
  const R = 0.85;
  const group = new THREE.Group();
  const moon = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), planetMaterial("/textures/2k_moon.jpg", grey(9), { bump: 0.04 }));
  moon.castShadow = true;
  moon.receiveShadow = true;
  group.add(moon);
  return { content: group, radius: R, update: (dt) => void (moon.rotation.y += dt * 0.03) };
}

export function buildMars(): BuiltObject {
  const R = 0.95;
  const group = new THREE.Group();
  const mars = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), planetMaterial("/textures/2k_mars.jpg", tinted(21, [190, 90, 50]), { bump: 0.05 }));
  mars.castShadow = true;
  const atmo = atmosphere(R * 1.06, R, 0xff9a6a, 0.45);
  atmo.userData.noPick = true;
  group.add(mars, atmo);
  return {
    content: group,
    radius: R * 1.06,
    props: { atmosphere: true },
    setProperty(prop, value) {
      if (prop !== "atmosphere") return false;
      atmo.visible = value;
      return true;
    },
    update: (dt) => void (mars.rotation.y += dt * 0.05),
  };
}

function ringTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 8;
  const ctx = c.getContext("2d")!;
  for (let x = 0; x < 512; x++) {
    const r = x / 512;
    const gap = r > 0.58 && r < 0.63;
    const a = gap ? 0.05 : 0.35 + 0.5 * Math.abs(Math.sin(r * 47) * Math.sin(r * 13)) * (1 - r * 0.4);
    const shade = 180 + Math.sin(r * 90) * 30;
    ctx.fillStyle = `rgba(${shade},${shade * 0.9},${shade * 0.75},${a})`;
    ctx.fillRect(x, 0, 1, 8);
  }
  return canvasTexture(c);
}

function saturnRings(inner: number, outer: number) {
  const geo = new THREE.RingGeometry(inner, outer, 192, 1);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    uv.setXY(i, (v.length() - inner) / (outer - inner), 0.5);
  }
  const map = texture("/textures/2k_saturn_ring_alpha.png", () => (ringTexture().image as HTMLCanvasElement));
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map, alphaMap: undefined, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 0.85, envMapIntensity: 0.1 }),
  );
  mesh.receiveShadow = true;
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

export function buildSaturn(): BuiltObject {
  const R = 0.72;
  const group = new THREE.Group();
  const planet = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), planetMaterial("/textures/2k_saturn.jpg", tinted(5, [215, 185, 130])));
  planet.castShadow = true;
  const rings = saturnRings(R * 1.22, R * 2.3);
  rings.userData.noPick = true;
  const tilt = new THREE.Group();
  tilt.rotation.z = 26.7 * D;
  tilt.add(planet, rings);
  group.add(tilt);
  return {
    content: group,
    radius: R * 2.3,
    props: { rings: true },
    setProperty(prop, value) {
      if (prop !== "rings") return false;
      rings.visible = value;
      return true;
    },
    update: (dt) => void (planet.rotation.y += dt * 0.12),
  };
}

/** Sun: real photosphere texture, slowly churning, bright enough to bloom. */
function sunMaterial() {
  const map = texture("/textures/2k_sun.jpg", tinted(3, [255, 160, 60]));
  map.wrapS = map.wrapT = THREE.RepeatWrapping; // second, scaled sample must tile without a seam
  return new THREE.ShaderMaterial({
    uniforms: { uTime: holoTime, uMap: { value: map } },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: /* glsl */ `uniform float uTime; uniform sampler2D uMap; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        vec2 w = vec2(sin(vUv.y * 40.0 + uTime * 0.6), cos(vUv.x * 50.0 - uTime * 0.5)) * 0.0025;
        vec3 a = texture2D(uMap, vUv + w + vec2(uTime * 0.004, 0.0)).rgb;
        vec3 b = texture2D(uMap, vUv * 1.7 - w * 2.0 - vec2(uTime * 0.006, 0.0)).rgb;
        vec3 col = mix(a, b, 0.35);
        float limb = pow(max(dot(normalize(vN), normalize(vV)), 0.0), 0.45);
        gl_FragColor = vec4(col * vec3(1.15, 0.82, 0.52) * (0.42 + limb * 0.62), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

export function buildSun(): BuiltObject {
  const R = 0.9;
  const group = new THREE.Group();
  const sun = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), sunMaterial());
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSprite("rgba(255,170,60,1)"), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  corona.scale.setScalar(R * 3.4);
  corona.userData.noPick = true;
  const light = new THREE.PointLight(0xffb060, 6, 9, 1.6);
  group.add(sun, corona, light);
  return { content: group, radius: R * 1.2, update: (dt) => void (sun.rotation.y += dt * 0.03) };
}

const PLANETS = [
  { name: "Mercury", r: 0.05, orbit: 0.62, tex: "mercury", color: [150, 140, 130] as const, period: 0.24 },
  { name: "Venus", r: 0.08, orbit: 0.85, tex: "venus_atmosphere", color: [220, 180, 120] as const, period: 0.62 },
  { name: "Earth", r: 0.085, orbit: 1.1, tex: "", color: [60, 120, 210] as const, period: 1 },
  { name: "Mars", r: 0.065, orbit: 1.36, tex: "mars", color: [190, 90, 50] as const, period: 1.88 },
  { name: "Jupiter", r: 0.19, orbit: 1.78, tex: "jupiter", color: [210, 170, 125] as const, period: 11.9 },
  { name: "Saturn", r: 0.16, orbit: 2.22, tex: "saturn", color: [225, 195, 140] as const, period: 29.4, ring: true },
  { name: "Uranus", r: 0.11, orbit: 2.58, tex: "uranus", color: [140, 210, 225] as const, period: 84 },
  { name: "Neptune", r: 0.105, orbit: 2.9, tex: "neptune", color: [70, 100, 220] as const, period: 165 },
];

export function buildSolarSystem(): BuiltObject {
  const group = new THREE.Group();
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.32, 64, 48), sunMaterial());
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSprite("rgba(255,170,60,1)"), blending: THREE.AdditiveBlending, depthWrite: false }));
  corona.scale.setScalar(1.5);
  corona.userData.noPick = true;
  group.add(sun, corona, new THREE.PointLight(0xffc080, 8, 10, 1.3));

  const orbits = new THREE.Group();
  orbits.userData.noPick = true;
  group.add(orbits);
  const planets = PLANETS.map((p, i) => {
    const pivot = new THREE.Group();
    pivot.rotation.y = i * 1.7;
    const url = p.tex ? `/textures/2k_${p.tex}.jpg` : "/textures/earth_day.jpg";
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(p.r, 48, 32), planetMaterial(url, tinted(i + 30, [p.color[0], p.color[1], p.color[2]]), { roughness: 0.9 }));
    mesh.position.x = p.orbit;
    if (p.ring) {
      const ring = saturnRings(p.r * 1.25, p.r * 2.3);
      ring.rotation.x = -Math.PI / 2 + 0.45;
      mesh.add(ring);
    }
    pivot.add(mesh);
    group.add(pivot);
    const curve = new THREE.EllipseCurve(0, 0, p.orbit, p.orbit, 0, Math.PI * 2);
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(128).map((v) => new THREE.Vector3(v.x, 0, v.y))),
      new THREE.LineBasicMaterial({ color: 0x5fd8ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    orbits.add(line);
    return { pivot, mesh, line, base: p.orbit, speed: 0.6 / Math.sqrt(p.period) };
  });

  return {
    content: group,
    radius: 3,
    props: { orbits: true },
    setProperty(prop, value) {
      if (prop !== "orbits") return false;
      orbits.visible = value;
      return true;
    },
    explode(amount) {
      const spread = 1 + amount * 0.7;
      for (const p of planets) {
        p.mesh.position.x = p.base * spread;
        p.line.scale.setScalar(spread);
      }
    },
    update(dt) {
      for (const p of planets) {
        p.pivot.rotation.y += dt * p.speed;
        p.mesh.rotation.y += dt * 1.5;
      }
    },
  };
}
