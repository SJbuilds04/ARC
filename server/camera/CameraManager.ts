import type { ArcMode, DeviceRole, VisionRoute, VisionSourceState } from "../../shared/types";

/**
 * CameraManager — owns which cameras run and where their landmarks are consumed.
 * Switching cameras changes this state only; nothing else in ARC is torn down.
 *
 * Routes are explicit (source → consumer) and several can be live at once, because the
 * phone and the PC each have their own space: e.g. the phone's front camera running the
 * VISOR (PHONE → PHONE) while the PC webcam drives the Playground (PC → PC).
 */
export class CameraManager {
  readonly available: DeviceRole[] = ["PHONE", "PC"];
  /** Preferred camera for the PC Playground. */
  private active: DeviceRole;
  phoneHands = false;
  readonly sources: Record<DeviceRole, VisionSourceState> = {
    PHONE: { status: "OFFLINE" },
    PC: { status: "IDLE" },
  };

  constructor(initial: DeviceRole = "PC") {
    this.active = initial;
  }

  get activeSource(): DeviceRole {
    return this.active;
  }

  /** Change the Playground camera. Returns the transition, or null if nothing changed. */
  switchCamera(to: DeviceRole): { from: DeviceRole; to: DeviceRole } | null {
    if (to === this.active) return null;
    const from = this.active;
    this.active = to;
    return { from, to };
  }

  routes(spaces: Record<DeviceRole, ArcMode>, connected: Record<DeviceRole, boolean>): VisionRoute[] {
    const routes: VisionRoute[] = [];
    const phoneVisor = spaces.PHONE === "VISOR" && connected.PHONE;
    if (phoneVisor) routes.push({ source: "PHONE", consumer: "PHONE" });
    if (spaces.PC === "VISOR") routes.push({ source: "PC", consumer: "PC" });
    else if (spaces.PC === "PLAYGROUND") {
      const source: DeviceRole = this.active === "PHONE" && connected.PHONE && !phoneVisor ? "PHONE" : "PC";
      routes.push({ source, consumer: "PC" });
    }
    if (this.phoneHands && connected.PHONE && !routes.some((r) => r.source === "PHONE")) routes.push({ source: "PHONE", consumer: "PHONE" });
    return routes;
  }

  setSourceStatus(source: DeviceRole, patch: VisionSourceState): VisionSourceState {
    const prev = this.sources[source];
    this.sources[source] = { ...patch };
    return prev;
  }
}
