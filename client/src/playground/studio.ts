import * as THREE from "three";

/**
 * Product-photography lighting for physically based models (armour, metal, glass).
 *
 * The environment is a dark studio with soft boxes and strip lights rendered once into a
 * PMREM cube map: clear coats and polished metal pick up the long crisp highlights that make
 * car paint read as car paint. `studioRig()` adds the direct lights (key with shadows, two
 * cool rims, a soft fill) used for Deep Dive.
 */

function panel(w: number, h: number, intensity: number, color = 0xffffff): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
  );
  return m;
}

/** Dark studio + soft boxes → prefiltered environment map. */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  // Room: vertical gradient (dark floor, dim horizon band, darker ceiling).
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(30, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `varying vec3 vP;
        void main(){
          float y = normalize(vP).y;
          vec3 floorC = vec3(0.012, 0.013, 0.016);
          vec3 horizon = vec3(0.075, 0.08, 0.09);
          vec3 ceil = vec3(0.03, 0.032, 0.038);
          vec3 c = y < 0.0 ? mix(horizon, floorC, smoothstep(0.0, 0.35, -y)) : mix(horizon, ceil, smoothstep(0.0, 0.6, y));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  scene.add(room);

  const add = (m: THREE.Mesh, x: number, y: number, z: number) => {
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  // Key: big soft box high front-left.
  add(panel(7, 5, 5.5, 0xfff3e6), -8, 10, 9);
  // Overhead strip.
  add(panel(14, 1.6, 3.2), 0, 14, 0);
  // Rim strips: tall and thin, behind left and right (cool).
  add(panel(1.3, 13, 6.5, 0xdde9ff), -11, 2, -8);
  add(panel(1.3, 13, 6.5, 0xdde9ff), 11, 2, -8);
  // Front fill: wide, low, gentle.
  add(panel(16, 3, 1.4, 0xf2f4ff), 0, 1, 15);
  // Side kicker (right, warm) for a second highlight line on curved plates.
  add(panel(2.2, 8, 2.4, 0xffe6cc), 14, 4, 4);
  // Floor bounce.
  const floor = panel(30, 30, 0.12, 0xb8b0a8);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -6;
  scene.add(floor);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.015).texture;
  pmrem.dispose();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    (mesh.material as THREE.Material | undefined)?.dispose?.();
  });
  return tex;
}

export interface StudioRig {
  group: THREE.Group;
  key: THREE.DirectionalLight;
}

/** Direct lights for the studio: key (shadows), two rims, fill. */
export function studioRig(): StudioRig {
  const group = new THREE.Group();
  group.add(new THREE.HemisphereLight(0xe4ecff, 0x1a1612, 0.42));
  const key = new THREE.DirectionalLight(0xfff1e2, 1.7);
  key.position.set(-3.2, 5.5, 4.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -3;
  key.shadow.camera.right = key.shadow.camera.top = 3;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 20;
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  group.add(key);
  const rimL = new THREE.DirectionalLight(0xcfe0ff, 1.1);
  rimL.position.set(-4.5, 2.6, -4.2);
  group.add(rimL);
  const rimR = new THREE.DirectionalLight(0xd8e6ff, 1.35);
  rimR.position.set(4.8, 3.2, -3.8);
  group.add(rimR);
  const fill = new THREE.DirectionalLight(0xffe8d6, 0.55);
  fill.position.set(4, 1.2, 5);
  group.add(fill);
  return { group, key };
}
