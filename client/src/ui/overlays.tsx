import { useEffect, useState } from "react";
import { useArc, dismiss } from "../core/store";
import { arc, vision } from "../core/services";
import { ArcLogo } from "./primitives";
import { Icon } from "./Icons";

type Check = { label: string; state: "pending" | "ok" | "warn" | "fail"; note?: string };

/**
 * Startup sequence. Every line reflects a real check (camera API, hand model,
 * server link, Groq reachability, desktop link, pairing) — nothing is faked.
 * Runs once per page load; reconnects never replay it.
 */
export function BootSequence() {
  const role = useArc((s) => s.role);
  const [lines, setLines] = useState<Check[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    const waitFor = <T,>(get: () => T | undefined | null | false, ms: number) =>
      new Promise<T | null>((resolve) => {
        const tick = () => {
          const v = get();
          if (v) return resolve(v as T);
          if (performance.now() - started > ms) return resolve(null);
          setTimeout(tick, 80);
        };
        tick();
      });

    const run = async () => {
      const results: Check[] = [];
      const push = async (c: Check) => {
        results.push(c);
        if (!cancelled) setLines([...results]);
        await new Promise((r) => setTimeout(r, 190));
      };

      const camOk = Boolean(navigator.mediaDevices?.getUserMedia);
      await push({ label: "VISION", state: camOk ? "ok" : "fail", note: camOk ? undefined : window.isSecureContext ? "NO CAMERA API" : "HTTPS REQUIRED" });

      const tracker = await waitFor(() => useArc.getState().local.trackerReady || vision.tracker.error, 2600);
      await push({ label: "GESTURES", state: tracker === true ? "ok" : vision.tracker.error ? "fail" : "warn", note: tracker === true ? undefined : vision.tracker.error ? "MODEL FAILED" : "LOADING" });

      const state = await waitFor(() => useArc.getState().state, 3500);
      await push({ label: "JARVIS", state: state ? "ok" : "fail", note: state ? undefined : "CORE OFFLINE" });

      const ai = state?.services.ai.status;
      await push({ label: "GROQ", state: ai === "ONLINE" ? "ok" : ai === "UNCONFIGURED" || ai === "OFFLINE" ? "fail" : "warn", note: ai === "ONLINE" ? undefined : ai ?? "UNKNOWN" });

      const desktop = role === "PC" ? state?.services.desktop.status === "ONLINE" : Boolean(state?.devices.PC.connected);
      await push({ label: "DESKTOP", state: desktop ? "ok" : "warn", note: desktop ? undefined : "NOT CONNECTED" });

      const phone = state?.devices.PHONE.connected;
      await push({ label: "DEVICE", state: phone ? "ok" : role === "PHONE" ? (state ? "ok" : "fail") : "warn", note: phone || role === "PHONE" ? undefined : "AWAITING PAIR" });

      await new Promise((r) => setTimeout(r, 450));
      if (!cancelled) setDone(true);
      setTimeout(() => !cancelled && useArc.setState({ bootDone: true }), 700);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [role]);

  return (
    <div className={`boot ${done ? "is-done" : ""}`}>
      <div className="boot__frame">
        <ArcLogo />
        <div className="boot__init">INITIALIZING ARC…</div>
        <div className="boot__lines">
          {lines.map((l) => (
            <div key={l.label} className={`boot__line is-${l.state}`}>
              <span>{l.label}</span>
              <span className="boot__dots" />
              <span className="boot__state">{l.state === "ok" ? "OK" : l.note}</span>
            </div>
          ))}
        </div>
        <div className={`boot__online ${done ? "is-visible" : ""}`}>ARC ONLINE</div>
      </div>
    </div>
  );
}

/** "VISION HANDOFF" overlay — a layer over the running UI, never a reload. */
export function Handoff() {
  const transition = useArc((s) => s.transition);
  const role = useArc((s) => s.role);
  const visorDevice = useArc((s) => s.state?.visor.device);
  const [step, setStep] = useState<number>(-1);

  useEffect(() => {
    if (!transition) return;
    const seq = transition.kind === "mode" && transition.visionFrom !== transition.visionTo ? [3, 2, 1, 0] : [0];
    const timers: number[] = [];
    seq.forEach((n, i) => timers.push(window.setTimeout(() => setStep(n), 120 + i * 520)));
    timers.push(window.setTimeout(() => setStep(-1), 120 + seq.length * 520 + 1100));
    timers.push(window.setTimeout(() => useArc.setState((s) => (s.transition?.key === transition.key ? { transition: null } : {})), 120 + seq.length * 520 + 1500));
    setStep(seq[0] === 0 ? 0 : 3);
    return () => timers.forEach(clearTimeout);
  }, [transition]);

  if (!transition) return null;
  // On the visor device the VISOR boot sequence is the transition.
  if (transition.to === "VISOR" && visorDevice === role) return null;
  const toPlayground = transition.to === "PLAYGROUND";
  const label = (d: string) => (d === "PHONE" ? "PHONE" : "PC");
  const modeName = transition.kind === "camera" ? "VISION SOURCE" : toPlayground ? "PLAYGROUND MODE" : transition.to === "VISOR" ? "ARC VISOR" : "COMMAND MODE";

  return (
    <div className={`handoff ${step === -1 ? "is-leaving" : ""}`}>
      {step > 0 ? (
        <div className="handoff__card">
          <div className="handoff__title">VISION HANDOFF</div>
          <div className="handoff__route">
            <span>{label(transition.visionFrom)}</span>
            <i className="handoff__arrow" />
            <span>{label(transition.visionTo)}</span>
          </div>
          <div className="handoff__count" key={step}>
            {step}
          </div>
        </div>
      ) : (
        <div className="handoff__card is-result">
          <div className="handoff__mode">{modeName}</div>
          <div className="handoff__vision">VISION · {label(transition.visionTo)} CAMERA</div>
          <div className="handoff__status">
            <i className="dot dot--ok" /> CONNECTED
          </div>
        </div>
      )}
    </div>
  );
}

/** Notifications, with recovery actions for vision-source failures. */
export function Notices() {
  const notices = useArc((s) => s.notices);
  const role = useArc((s) => s.role);
  const activeSource = useArc((s) => s.state?.vision.activeSource);
  if (!notices.length) return null;
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`notice is-${n.level}`} role="status">
          <div className="notice__head">
            <Icon.Warning width={16} height={16} />
            <span>{n.title}</span>
            <button className="notice__close" onClick={() => dismiss(n.id)} aria-label="Dismiss">
              <Icon.Close width={14} height={14} />
            </button>
          </div>
          <div className="notice__text">{n.text}</div>
          {(n.code === "VISION_LOST" || n.code === "CAMERA") && (
            <div className="notice__actions">
              {activeSource === role && (
                <button
                  className="btn btn--small"
                  onClick={() => {
                    dismiss(n.id);
                    vision.retry();
                  }}
                >
                  RECONNECT
                </button>
              )}
              {activeSource !== "PC" && (
                <button
                  className="btn btn--small"
                  onClick={() => {
                    dismiss(n.id);
                    arc.send({ type: "ACTION_REQUEST", action: { action: "SWITCH_CAMERA", to: "PC" } });
                  }}
                >
                  SWITCH TO PC
                </button>
              )}
              {activeSource !== "PHONE" && (
                <button
                  className="btn btn--small"
                  onClick={() => {
                    dismiss(n.id);
                    arc.send({ type: "ACTION_REQUEST", action: { action: "SWITCH_CAMERA", to: "PHONE" } });
                  }}
                >
                  SWITCH TO PHONE
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Connection problems that need the user (pairing, superseded tab). The UI underneath stays mounted. */
export function ConnectionGate() {
  const conn = useArc((s) => s.conn);
  if (conn.status !== "rejected" && conn.status !== "superseded") return null;
  return (
    <div className="gate">
      <div className="gate__card">
        <ArcLogo compact />
        <div className="gate__title">{conn.status === "superseded" ? "SESSION MOVED" : "PAIR DEVICE"}</div>
        <p className="gate__text">{conn.error?.message}</p>
        {conn.status === "superseded" ? (
          <button className="btn" onClick={() => arc.reclaim()}>
            USE ARC HERE
          </button>
        ) : (
          <p className="gate__hint">Open ARC on the PC and scan the QR code shown under DEVICES.</p>
        )}
      </div>
    </div>
  );
}

export function ConnectionBadge() {
  const conn = useArc((s) => s.conn);
  if (conn.status === "online") return null;
  return (
    <div className="conn-badge">
      <i className="dot dot--warn" /> {conn.status === "connecting" ? "CONNECTING TO ARC CORE…" : "RECONNECTING… SESSION PRESERVED"}
    </div>
  );
}
