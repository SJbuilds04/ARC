import * as THREE from "three";

export interface CarouselItem {
  id: string;
  name: string;
  category: string;
}

interface Card {
  item: CarouselItem;
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  thumb: string | null;
}

const CARD_W = 1.15;
const CARD_H = 1.45;
const SPACING = 1.5;

/**
 * A ring of holographic model cards. Close your fist and move sideways to spin it (or drag,
 * swipe, arrow keys, phone); let go and it settles on the nearest card. The card in front is
 * the one "this one" / pinch / tap selects.
 */
export class Carousel {
  readonly group = new THREE.Group();
  private cards: Card[] = [];
  private key = "";
  private angle = 0;
  private target = 0;
  private dragging = false;
  radius = 3;

  get count(): number {
    return this.cards.length;
  }

  private get stepAngle(): number {
    return (Math.PI * 2) / Math.max(1, this.cards.length);
  }

  setItems(items: CarouselItem[], thumbs: Record<string, string>): void {
    const key = items.map((i) => `${i.id}:${i.name}`).join("|");
    if (key !== this.key) {
      this.key = key;
      for (const c of this.cards) {
        this.group.remove(c.mesh);
        c.texture.dispose();
        (c.mesh.material as THREE.Material).dispose();
        c.mesh.geometry.dispose();
      }
      this.cards = items.map((item) => this.makeCard(item));
      this.radius = Math.max(2.6, (this.cards.length * SPACING) / (Math.PI * 2));
    }
    for (const c of this.cards) {
      const url = thumbs[c.item.id] ?? null;
      if (url !== c.thumb) {
        c.thumb = url;
        this.paint(c);
      }
    }
  }

  private makeCard(item: CarouselItem): Card {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 404;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W, CARD_H),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.FrontSide, toneMapped: false }),
    );
    mesh.userData.noPick = true;
    this.group.add(mesh);
    const card: Card = { item, mesh, canvas, texture, thumb: null };
    this.paint(card);
    return card;
  }

  private paint(card: Card, img?: HTMLImageElement): void {
    const { canvas, item } = card;
    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // Glass card with a chamfered corner
    const cut = 26;
    ctx.beginPath();
    ctx.moveTo(cut, 2);
    ctx.lineTo(w - 2, 2);
    ctx.lineTo(w - 2, h - cut);
    ctx.lineTo(w - cut, h - 2);
    ctx.lineTo(2, h - 2);
    ctx.lineTo(2, cut);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "rgba(10,40,70,0.88)");
    g.addColorStop(1, "rgba(3,14,28,0.92)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(120,215,255,0.85)";
    ctx.stroke();

    const art = { x: 20, y: 20, w: w - 40, h: w - 40 };
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(art.x, art.y, art.w, art.h);
      ctx.clip();
      ctx.drawImage(img, art.x, art.y, art.w, art.h);
      ctx.restore();
    } else {
      // No thumbnail yet: a holographic monogram.
      const rg = ctx.createRadialGradient(w / 2, art.y + art.h / 2, 10, w / 2, art.y + art.h / 2, art.w / 2);
      rg.addColorStop(0, "rgba(95,216,255,0.35)");
      rg.addColorStop(1, "rgba(95,216,255,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(art.x, art.y, art.w, art.h);
      ctx.strokeStyle = "rgba(95,216,255,0.6)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w / 2, art.y + art.h / 2, art.w * 0.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(214,242,255,0.95)";
      ctx.font = "600 84px Michroma, Rajdhani, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(item.name.slice(0, 1).toUpperCase(), w / 2, art.y + art.h / 2 + 4);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(126,166,194,1)";
    ctx.font = "600 20px Rajdhani, sans-serif";
    ctx.fillText(item.category.toUpperCase(), 22, art.y + art.h + 32);
    ctx.fillStyle = "rgba(214,242,255,1)";
    ctx.font = "700 34px Rajdhani, sans-serif";
    let name = item.name.toUpperCase();
    while (ctx.measureText(name).width > w - 44 && name.length > 3) name = name.slice(0, -2) + "…";
    ctx.fillText(name, 22, art.y + art.h + 68);
    card.texture.needsUpdate = true;

    if (!img && card.thumb) {
      const im = new Image();
      im.onload = () => card.thumb && this.paint(card, im);
      im.src = card.thumb;
    }
  }

  // ─── Motion ───

  update(dt: number): void {
    if (!this.cards.length) return;
    this.angle += (this.target - this.angle) * (1 - Math.exp(-dt * (this.dragging ? 18 : 7)));
    const step = this.stepAngle;
    const front = this.frontIndex();
    this.cards.forEach((c, i) => {
      const theta = i * step - this.angle;
      c.mesh.position.set(Math.sin(theta) * this.radius, 0, Math.cos(theta) * this.radius);
      c.mesh.rotation.y = theta;
      const facing = Math.cos(theta);
      const isFront = i === front;
      const s = isFront ? 1.14 : 0.92;
      c.mesh.scale.lerp(new THREE.Vector3(s, s, s), 1 - Math.exp(-dt * 10));
      (c.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, facing) ** 1.5 * (isFront ? 1 : 0.7);
    });
  }

  drag(dx: number): void {
    this.dragging = true;
    this.target -= dx * this.stepAngle * 7;
  }

  release(): void {
    this.dragging = false;
    this.target = Math.round(this.target / this.stepAngle) * this.stepAngle;
  }

  step(n: number): void {
    this.target = (Math.round(this.target / this.stepAngle) + n) * this.stepAngle;
  }

  goTo(index: number): void {
    const step = this.stepAngle;
    const cur = Math.round(this.target / step);
    const n = this.cards.length;
    let delta = (((index - cur) % n) + n) % n;
    if (delta > n / 2) delta -= n;
    this.target = (cur + delta) * step;
  }

  frontIndex(): number {
    const n = this.cards.length;
    if (!n) return -1;
    return ((Math.round(this.angle / this.stepAngle) % n) + n) % n;
  }

  frontId(): string | null {
    return this.cards[this.frontIndex()]?.item.id ?? null;
  }

  pick(ray: THREE.Raycaster): number | null {
    const hits = ray.intersectObjects(this.cards.map((c) => c.mesh), false).filter((h) => (h.object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.opacity > 0.15);
    if (!hits.length) return null;
    return this.cards.findIndex((c) => c.mesh === hits[0].object);
  }
}
