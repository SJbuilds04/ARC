import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionStage, Attachment, ExecutionRecord } from "@shared/types";
import { useArc, setLocal } from "../core/store";
import { savePref } from "../core/device";
import { arc, engage, voiceIn, voiceOut } from "../core/services";
import { HoldButton, Waveform } from "./primitives";
import { Icon } from "./Icons";

/** JARVIS REQUEST / ⚠ CONFIRM ACTION — the gesture-confirmable decision panel. */
export function ConfirmPanel({ large = false, hint }: { large?: boolean; hint?: string }) {
  const pending = useArc((s) => s.state?.pending ?? null);
  const flash = useArc((s) => s.confirmFlash);
  const [remaining, setRemaining] = useState(0);

  const expiresAt = pending?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);

  const respond = useCallback(
    (approved: boolean) => pending && arc.send({ type: "CONFIRM_RESPONSE", id: pending.id, approved, via: "touch" }),
    [pending],
  );
  const confirm = useCallback(() => respond(true), [respond]);

  if (flash && !pending)
    return (
      <div className={`confirm confirm--flash ${flash.approved ? "is-approved" : "is-denied"} ${large ? "is-large" : ""}`}>
        <div className="confirm__flash">{flash.approved ? "CONFIRMED" : "CANCELLED"}</div>
      </div>
    );
  if (!pending) return null;

  const high = pending.risk === "HIGH";
  return (
    <div className={`confirm risk-${pending.risk.toLowerCase()} ${large ? "is-large" : ""}`} role="alertdialog" aria-label={pending.title}>
      <div className="confirm__head">
        {high || pending.risk === "MEDIUM" ? (
          <span className="confirm__kicker is-warn">
            <Icon.Warning width={15} height={15} /> CONFIRM ACTION · {pending.risk} RISK
          </span>
        ) : (
          <span className="confirm__kicker">JARVIS REQUEST</span>
        )}
        <span className="confirm__timer">{remaining}s</span>
      </div>
      <div className="confirm__title">{pending.title}</div>
      {pending.detail && <div className="confirm__detail">{pending.detail}</div>}
      <div className="confirm__buttons">
        {high ? (
          <>
            <button className="btn btn--deny" onClick={() => respond(false)}>
              CANCEL
            </button>
            <HoldButton holdMs={pending.holdMs} onConfirm={confirm} className="btn btn--confirm btn--hold">
              HOLD TO CONFIRM
            </HoldButton>
          </>
        ) : (
          <>
            <button className="btn btn--confirm" onClick={confirm}>
              YES
            </button>
            <button className="btn btn--deny" onClick={() => respond(false)}>
              NO
            </button>
          </>
        )}
      </div>
      <div className="confirm__hint">{high ? "Pinch and hold CONFIRM · open palm to cancel" : hint ?? "Point and pinch to choose · open palm to cancel"}</div>
    </div>
  );
}

const STAGES: { key: ActionStage; label: string }[] = [
  { key: "REQUEST", label: "REQUEST" },
  { key: "ANALYZING", label: "ANALYZING" },
  { key: "AUTHORIZED", label: "AUTHORIZED" },
  { key: "EXECUTING", label: "EXECUTING" },
  { key: "COMPLETE", label: "COMPLETE" },
];
const ORDER: ActionStage[] = ["REQUEST", "ANALYZING", "AWAITING_CONFIRMATION", "AUTHORIZED", "EXECUTING", "COMPLETE"];

export function ExecutionTimeline({ record }: { record: ExecutionRecord }) {
  const idx = ORDER.indexOf(record.stage);
  const failed = record.stage === "FAILED" || record.stage === "CANCELLED";
  return (
    <div className={`timeline ${failed ? "is-failed" : ""}`}>
      <div className="timeline__title">
        <span>{record.title}</span>
        <span className={`risk-tag risk-${record.risk.toLowerCase()}`}>{record.risk}</span>
      </div>
      <div className="timeline__steps">
        {STAGES.map((s) => {
          const si = ORDER.indexOf(s.key);
          const state = failed ? (si <= Math.max(1, idx) ? "done" : "idle") : si < idx ? "done" : si === idx ? "active" : record.stage === "AWAITING_CONFIRMATION" && s.key === "AUTHORIZED" ? "wait" : "idle";
          return (
            <div key={s.key} className={`timeline__step is-${state}`}>
              <i />
              <span>{s.key === "AUTHORIZED" && record.stage === "AWAITING_CONFIRMATION" ? "AWAITING" : s.label}</span>
            </div>
          );
        })}
      </div>
      {failed && <div className="timeline__error">{record.stage === "CANCELLED" ? "CANCELLED" : record.detail ?? "FAILED"}</div>}
    </div>
  );
}

export function LatestExecution() {
  const record = useArc((s) => s.state?.executions[0]);
  const [visible, setVisible] = useState(true);
  // Keyed on id + stage: every STATE broadcast is a new object, which must not restart the timer.
  const key = record ? `${record.id}:${record.stage}` : "";
  useEffect(() => {
    setVisible(true);
    if (!record || !["COMPLETE", "FAILED", "CANCELLED"].includes(record.stage)) return;
    const id = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(id);
  }, [key]);
  if (!record || !visible) return null;
  return <ExecutionTimeline record={record} />;
}

export function Attachments({ items }: { items: Attachment[] }) {
  return (
    <div className="attachments">
      {items.map((a, i) =>
        a.kind === "files" ? (
          <div key={i} className="attach-files">
            {a.items.map((f) => (
              <button key={f.path} className="attach-file" onClick={() => arc.send({ type: "ACTION_REQUEST", action: { action: "OPEN_FILE", path: f.path } })} title={f.path}>
                <Icon.File width={16} height={16} />
                <span className="attach-file__name">{f.name}</span>
                <span className="attach-file__path">{f.path}</span>
              </button>
            ))}
          </div>
        ) : (
          <div key={i} className="attach-kv">
            {a.items.map((kv) => (
              <div key={kv.label} className="attach-kv__row">
                <span>{kv.label}</span>
                <b>{kv.value}</b>
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

/** Latest JARVIS reply + what was heard. */
export function ResponseBubble({ compact = false }: { compact?: boolean }) {
  const response = useArc((s) => s.response);
  const transcript = useArc((s) => s.transcript);
  const activity = useArc((s) => s.state?.jarvis.activity ?? "IDLE");
  const showTranscript = transcript && (!response || transcript.at > response.at - 50);
  return (
    <div className={`response ${compact ? "is-compact" : ""}`}>
      {showTranscript && (
        <div className={`response__heard ${transcript!.accepted ? "" : "is-ignored"}`}>
          <span>{transcript!.accepted ? "HEARD" : "IGNORED · NO WAKE WORD"}</span> “{transcript!.text}”
        </div>
      )}
      {activity === "THINKING" ? (
        <div className="response__text is-thinking">
          <i />
          <i />
          <i />
        </div>
      ) : response ? (
        <div className="response__text" key={response.id}>
          {response.text}
        </div>
      ) : (
        <div className="response__text is-placeholder">Say “JARVIS…”, boss.</div>
      )}
      {response?.attachments && !compact && <Attachments items={response.attachments} />}
    </div>
  );
}

/** Mic (tap to talk / hold), hands-free toggle and text input. */
export function CommandBar({ placeholder = "Say a command, boss…" }: { placeholder?: string }) {
  const local = useArc((s) => s.local);
  const engaged = useArc((s) => s.engaged);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const recordingRef = useRef(false);
  const level = useCallback(() => (local.speaking && voiceOut.analyser ? analyserData() : voiceIn.level), [local.speaking]);

  const ensure = async () => {
    if (!engaged || local.mic === "off") await engage();
  };

  const toggleTalk = async () => {
    await ensure();
    if (local.speaking) {
      voiceOut.stop();
      arc.send({ type: "CANCEL" });
    }
    if (recordingRef.current) {
      recordingRef.current = false;
      voiceIn.end();
    } else {
      recordingRef.current = true;
      voiceIn.begin();
    }
  };

  useEffect(() => {
    if (local.mic !== "recording") recordingRef.current = false;
  }, [local.mic]);

  const toggleHandsFree = async () => {
    await ensure();
    const next = !local.handsFree;
    setLocal({ handsFree: next });
    savePref("handsFree", next);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    void ensure();
    arc.send({ type: "UTTERANCE", text: t, origin: "text" });
    setText("");
  };

  useEffect(() => {
    if (typing) inputRef.current?.focus();
  }, [typing]);

  const recording = local.mic === "recording";
  return (
    <div className="command-bar arc-ui-block">
      <button className={`mic-btn ${recording ? "is-recording" : ""} ${local.mic === "sending" ? "is-sending" : ""}`} onClick={toggleTalk} aria-label={recording ? "Stop and send" : "Speak"}>
        <Icon.Mic width={26} height={26} />
      </button>
      {typing ? (
        <form className="command-bar__form" onSubmit={submit}>
          <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} enterKeyHint="send" />
          <button type="submit" className="icon-btn" aria-label="Send">
            <Icon.Send width={18} height={18} />
          </button>
        </form>
      ) : (
        <div className="command-bar__wave" onClick={() => setTyping(true)}>
          <Waveform source={level} bars={34} />
          <span className="command-bar__label">
            {local.mic === "error" ? local.micError : recording ? "Listening… tap mic to send" : local.mic === "sending" ? "Processing…" : local.handsFree ? "Hands-free · say “JARVIS…”" : placeholder}
          </span>
        </div>
      )}
      <button className={`icon-btn ${local.handsFree ? "is-on" : ""}`} onClick={toggleHandsFree} title="Hands-free listening (wake word “JARVIS”)" aria-pressed={local.handsFree}>
        <Icon.Ear width={18} height={18} />
      </button>
      <button className={`icon-btn ${typing ? "is-on" : ""}`} onClick={() => setTyping((v) => !v)} title="Type a command" aria-pressed={typing}>
        <Icon.Keyboard width={18} height={18} />
      </button>
    </div>
  );
}

const freq = new Uint8Array(128);
function analyserData(): Uint8Array {
  voiceOut.analyser?.getByteFrequencyData(freq);
  return freq;
}
