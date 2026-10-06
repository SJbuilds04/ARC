import type { ArcMode, DeviceRole, VisionRoute, VisionSourceState } from "../../shared/types";

/**
 * CameraManager — owns which camera is the active vision source and where its
 * frames are consumed. Switching cameras changes this state only; nothing else
 * in ARC is torn down or reconnected.
 *
 * Routes are explicit (source → consumer) so a future HYBRID mode can simply
 * return two routes (e.g. PHONE → PHONE for the HUD and PC → PC for the playground)
 * without changing any consumer code.
 */
export class CameraManager {
  readonly available: DeviceRole[] = ["PHONE", "PC"];
  private active: DeviceRole;
  readonly sources: Record<DeviceRole, VisionSourceState> = {
    PHONE: { status: "OFFLINE" },
    PC: { status: "IDLE" },
  };

  constructor(initial: DeviceRole = "PHONE") {
    this.active = initial;
  }

  get activeSource(): DeviceRole {
    return this.active;
  }

  /** Default camera per mode. VISOR uses the visor device's front camera (decided by ArcCore). */
  static defaultSourceFor(mode: ArcMode): DeviceRole {
    return mode === "PLAYGROUND" ? "PC" : "PHONE";
  }

  /** Change the active vision source. Returns the transition, or null if nothing changed. */
  switchCamera(to: DeviceRole): { from: DeviceRole; to: DeviceRole } | null {
    if (to === this.active) return null;
    const from = this.active;
    this.active = to;
    return { from, to };
  }

  routes(primary: DeviceRole): VisionRoute[] {
    return [{ source: this.active, consumer: primary }];
  }

  setSourceStatus(source: DeviceRole, patch: VisionSourceState): VisionSourceState {
    const prev = this.sources[source];
    this.sources[source] = { ...patch };
    return prev;
  }
}
