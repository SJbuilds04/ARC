import { useEffect, useState } from "react";
import { CALIBRATION_POINTS } from "../../visor/GazeCalibration";
import { useArc } from "../../core/store";
import { arc, visor } from "../../core/services";
import { Icon } from "../Icons";

/** VISOR INITIALIZING — every line is a real check performed by the VisorManager. */
export function VisorBoot() {
  const v = useArc((s) => s.visor);
  if (v.phase !== "boot") return null;
  const done = v.boot.length >= 4;
  return (
    <div className="visor-boot" data-gaze-ignore>
      <div className="visor-boot__card">
        <div className="visor-boot__kicker">ARC // VISOR</div>
        <div className="visor-boot__title">{v.face === "TRACKING" ? "FACE LOCKED" : "SCANNING FACE…"}</div>
        <div className="visor-boot__lines">
          {v.boot.map((l) => (
            <div key={l.label} className={`boot__line is-${l.state}`}>
              <span>{l.label}</span>
              <span className="boot__dots" />
              <span className="boot__state">{l.state === "ok" ? l.note ?? "OK" : l.note}</span>
            </div>
          ))}
        </div>
        <div className={`visor-boot__active ${done ? "is-visible" : ""}`}>ARC VISOR ACTIVE</div>
      </div>
    </div>
  );
}

/** 9-point gaze calibration. Shared by VISOR and gaze-in-Playground. */
export function VisorCalibration() {
  const v = useArc((s) => s.visor);
  const [justDone, setJustDone] = useState(false);

  useEffect(() => {
    if (v.phase === "tracking" && v.calib.rms !== undefined) {
      setJustDone(true);
      const id = setTimeout(() => setJustDone(false), 1800);
      return () => clearTimeout(id);
    }
  }, [v.phase, v.calib.rms]);

  if (justDone)
    return (
      <div className="calib-done" data-gaze-ignore>
        <div>GAZE CALIBRATED</div>
        <span>
          <i className="dot dot--ok" /> TRACKING · ±{v.calib.rms}px
        </span>
      </div>
    );

  if (v.phase === "calibration-failed")
    return (
      <div className="calib" data-gaze-ignore>
        <div className="calib__head">
          <div className="calib__kicker">ARC // VISOR</div>
          <div className="calib__title">CALIBRATION FAILED</div>
          <p className="calib__text">{v.calib.reason}</p>
          <div className="calib__actions">
            <button className="btn" onClick={() => visor.startCalibration()}>
              RETRY
            </button>
            <button className="btn btn--deny" onClick={() => arc.send({ type: "ACTION_REQUEST", action: { action: "EXIT_VISOR" } })}>
              EXIT VISOR
            </button>
          </div>
          <p className="calib__hint">Tip: sit 40–70 cm from the camera, light on your face, keep your head still and follow the dot with your eyes.</p>
        </div>
      </div>
    );

  if (v.phase !== "calibrating") return null;
  const point = CALIBRATION_POINTS[Math.min(v.calib.index, CALIBRATION_POINTS.length - 1)];
  return (
    <div className="calib" data-gaze-ignore>
      <div className="calib__head">
        <div className="calib__kicker">ARC // VISOR</div>
        <div className="calib__title">GAZE CALIBRATION</div>
        <p className="calib__text">{v.calib.paused ? "LOOK AT THE CAMERA — face not visible" : "Look at the point. Keep your head still."}</p>
        <div className="calib__progress">
          {CALIBRATION_POINTS.map((_, i) => (
            <i key={i} className={i < v.calib.index ? "is-done" : i === v.calib.index ? "is-active" : ""} />
          ))}
        </div>
      </div>
      <div className={`calib__point ${v.calib.paused ? "is-paused" : ""}`} key={v.calib.index} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
        <i />
        <b />
      </div>
    </div>
  );
}

function Stepper({ label, value, onDec, onInc }: { label: string; value: string; onDec: () => void; onInc: () => void }) {
  return (
    <div className="visor-settings__row">
      <span>{label}</span>
      <button className="icon-btn" data-gaze-label={`${label} DOWN`} onClick={onDec}>
        −
      </button>
      <b>{value}</b>
      <button className="icon-btn" data-gaze-label={`${label} UP`} onClick={onInc}>
        +
      </button>
    </div>
  );
}

export function VisorSettings({ onClose }: { onClose: () => void }) {
  const s = useArc((x) => x.visor.settings);
  return (
    <div className="visor-settings">
      <div className="visor-settings__head">
        <span>VISOR SETTINGS</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close settings">
          <Icon.Close width={16} height={16} />
        </button>
      </div>
      <div className="visor-settings__row">
        <span>EYE-TRACKING CURSOR</span>
        <button className={`btn btn--small ${s.gazeEnabled ? "btn--confirm" : ""}`} onClick={() => visor.updateSettings({ gazeEnabled: !s.gazeEnabled })}>
          {s.gazeEnabled ? "ON" : "OFF"}
        </button>
      </div>
      {s.gazeEnabled ? (
        <>
          <Stepper label="SENSITIVITY" value={`${s.sensitivity.toFixed(1)}×`} onDec={() => visor.updateSettings({ sensitivity: s.sensitivity - 0.1 })} onInc={() => visor.updateSettings({ sensitivity: s.sensitivity + 0.1 })} />
          <Stepper label="SMOOTHING" value={`${Math.round(s.smoothing * 100)}%`} onDec={() => visor.updateSettings({ smoothing: s.smoothing - 0.1 })} onInc={() => visor.updateSettings({ smoothing: s.smoothing + 0.1 })} />
          <div className="visor-settings__row">
            <span>DWELL CLICK</span>
            <button className={`btn btn--small ${s.dwellEnabled ? "btn--confirm" : ""}`} onClick={() => visor.updateSettings({ dwellEnabled: !s.dwellEnabled })}>
              {s.dwellEnabled ? "ON" : "OFF"}
            </button>
          </div>
          {s.dwellEnabled && <Stepper label="DWELL TIME" value={`${s.dwellMs} ms`} onDec={() => visor.updateSettings({ dwellMs: s.dwellMs - 100 })} onInc={() => visor.updateSettings({ dwellMs: s.dwellMs + 100 })} />}
          <button className="btn btn--small" onClick={() => visor.startCalibration()}>
            RECALIBRATE GAZE
          </button>
        </>
      ) : (
        <p className="muted small">Your hand is the cursor: point to aim, pinch to click. Turn this on to steer with your eyes instead (needs a short calibration).</p>
      )}
    </div>
  );
}
