import { useEffect, useState, type FormEvent } from "react";
import type { VoiceInfo } from "@shared/types";
import { useArc } from "../core/store";
import { arc, voiceOut } from "../core/services";
import { Panel } from "./primitives";
import { Icon } from "./Icons";
import { LiveSlider } from "./deepdive";
import { VOICE_DEFAULTS } from "@shared/voice";

const SAMPLES_PAGE = "https://rhasspy.github.io/piper-samples/";

const setVoice = (patch: { voice?: string; speed?: number; pitch?: number; fx?: number }) =>
  arc.send({ type: "ACTION_REQUEST", action: { action: "SET_VOICE", ...patch } });

/** Hear a voice on this device (the tap also unlocks audio on phones). */
function preview(voice?: string): void {
  voiceOut.unlock();
  arc.send({ type: "VOICE_PREVIEW", voice });
}

/** Two taps to delete, like models. */
function DeleteVoice({ voice }: { voice: VoiceInfo }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  return armed ? (
    <button className="voice-row__btn voice-row__btn--confirm" onClick={() => arc.send({ type: "VOICE_DELETE", voice: voice.id })}>
      DELETE?
    </button>
  ) : (
    <button className="voice-row__btn voice-row__btn--icon" onClick={() => setArmed(true)} aria-label={`Delete ${voice.name}`} title={`Delete ${voice.name}`}>
      <Icon.Trash width={15} height={15} />
    </button>
  );
}

/**
 * JARVIS VOICE — pick the voice, hear it, add more from Hugging Face, and shape it:
 * speed, pitch and the JARVIS effect. The same panel on the PC (System) and the phone (Settings).
 */
export function VoicePanel({ className = "" }: { className?: string }) {
  const v = useArc((s) => s.state?.voice);
  const service = useArc((s) => s.state?.services.voice);
  const [source, setSource] = useState("");
  if (!v) return null;
  const busy = Boolean(v.download && !v.download.error);
  const add = (e: FormEvent) => {
    e.preventDefault();
    const s = source.trim();
    if (!s || busy) return;
    arc.send({ type: "VOICE_ADD", source: s });
    setSource("");
  };
  const speaking =
    service?.engine === "PIPER" ? service.voiceName?.toUpperCase() ?? "PIPER" : service?.engine === "LOCAL" ? "WINDOWS VOICE (BACKUP)" : service?.engine === "GROQ" ? "GROQ" : "BROWSER VOICE (BACKUP)";
  return (
    <Panel title="JARVIS VOICE" className={`voice-panel ${className}`}>
      <div className="voice-now">
        <div>
          <span className="voice-now__label">SPEAKING WITH</span>
          <b className="voice-now__name">{speaking}</b>
        </div>
        <button className="btn voice-now__test" onClick={() => preview()}>
          <Icon.Play width={15} height={15} /> TEST
        </button>
      </div>

      <div className="voice-list">
        {v.voices.map((x) => {
          const on = x.id === v.id;
          return (
            <div key={x.id} className={`voice-row ${on ? "is-on" : ""}`}>
              <button className="voice-row__play" onClick={() => preview(x.id)} aria-label={`Hear ${x.name}`} title={`Hear ${x.name}`}>
                <Icon.Play width={14} height={14} />
              </button>
              <div className="voice-row__info">
                <b>{x.name}</b>
                <span>
                  {x.language} · {x.quality}
                  {x.speakers > 1 ? ` · ${x.speakers} speakers` : ""}
                </span>
              </div>
              {on ? (
                <span className="voice-row__tag">ACTIVE</span>
              ) : (
                <>
                  <button className="voice-row__btn" onClick={() => setVoice({ voice: x.id })}>
                    USE
                  </button>
                  <DeleteVoice voice={x} />
                </>
              )}
            </div>
          );
        })}
        {!v.voices.length && <div className="muted small">{v.engineReady ? "No voices yet. Add one below." : "Installing JARVIS's voice…"}</div>}
      </div>

      <form className="voice-add" onSubmit={add}>
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Paste a Piper voice link or name" aria-label="Voice link or name" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        <button className="btn" type="submit" disabled={!source.trim() || busy}>
          ADD
        </button>
      </form>
      {v.download &&
        (v.download.error ? (
          <div className="voice-dl is-error">
            <Icon.Warning width={14} height={14} /> {v.download.error}
          </div>
        ) : (
          <div className="voice-dl">
            <span>DOWNLOADING {v.download.label.toUpperCase()}</span>
            <b>{Math.round(v.download.progress * 100)}%</b>
            <i style={{ width: `${Math.round(v.download.progress * 100)}%` }} />
          </div>
        ))}
      <p className="voice-hint muted small">
        Pick one on the{" "}
        <a href={SAMPLES_PAGE} target="_blank" rel="noreferrer">
          Piper samples page
        </a>{" "}
        and paste its link (Hugging Face links and names like <code>en_GB-alan-medium</code> work too).
      </p>

      <div className="voice-sliders">
        <LiveSlider label="SPEED" value={v.speed} min={0.7} max={1.4} step={0.05} onCommit={(x) => setVoice({ speed: x })} format={(x) => `${x.toFixed(2)}×`} />
        <LiveSlider label="PITCH" value={v.pitch} min={-4} max={4} step={0.5} onCommit={(x) => setVoice({ pitch: x })} format={(x) => (x === 0 ? "0" : `${x > 0 ? "+" : "−"}${Math.abs(x)}`)} />
        <LiveSlider label="EFFECT" value={v.fx} min={0} max={1} step={0.05} onCommit={(x) => setVoice({ fx: x })} format={(x) => (x === 0 ? "OFF" : `${Math.round(x * 100)}%`)} />
        {(v.speed !== VOICE_DEFAULTS.speed || v.pitch !== VOICE_DEFAULTS.pitch) && (
          <button className="voice-reset" onClick={() => setVoice({ speed: VOICE_DEFAULTS.speed, pitch: VOICE_DEFAULTS.pitch })}>
            <Icon.Reset width={13} height={13} /> DEFAULT SPEED & PITCH
          </button>
        )}
      </div>
    </Panel>
  );
}

/** "PIPER · BRYCE" for the status rows. */
export function voiceEngineLabel(engine: string | undefined, voiceName?: string): string {
  if (engine === "PIPER") return voiceName ? `PIPER · ${voiceName.toUpperCase()}` : "PIPER";
  if (engine === "GROQ") return "GROQ ORPHEUS";
  if (engine === "LOCAL") return "WINDOWS · BACKUP";
  return "BROWSER · BACKUP";
}
