import type { HistoryEntry } from "@shared/types";
import { useArc } from "../../core/store";
import { arc } from "../../core/services";
import { Panel, StatusRow, toneFor } from "../primitives";
import { Icon } from "../Icons";

export function PairingCard() {
  const pairing = useArc((s) => s.pairing);
  const phone = useArc((s) => s.state?.devices.PHONE);
  if (phone?.connected) {
    return (
      <Panel title="PHONE" className="pair-card is-connected">
        <div className="pair-card__connected">
          <Icon.Phone width={30} height={30} />
          <div>
            <div className="pair-card__name">{phone.name ?? "Phone"}</div>
            <div className="pair-card__status">
              <i className="dot dot--ok" /> CONNECTED{phone.latencyMs !== undefined ? ` · ${phone.latencyMs} ms` : ""}
            </div>
          </div>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="PAIR DEVICE" className="pair-card">
      {pairing ? (
        <>
          <div className="pair-card__qr" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
          <div className="pair-card__hint">Scan with your phone camera. Same Wi‑Fi network.</div>
          <div className="pair-card__url">{pairing.url.split("?")[0]}</div>
        </>
      ) : (
        <div className="pair-card__hint">Generating pairing code…</div>
      )}
    </Panel>
  );
}

export function DevicesPanel() {
  const pairing = useArc((s) => s.pairing);
  return (
    <div className="stack">
      <PairingCard />
      <Panel title="PAIRED DEVICES">
        {!pairing?.devices.length && <div className="muted">No phones paired yet.</div>}
        {pairing?.devices.map((d) => (
          <div key={d.id} className="device-row">
            <Icon.Phone width={18} height={18} />
            <div className="device-row__main">
              <div>{d.name}</div>
              <div className="muted">
                {d.connected ? "Connected" : `Last seen ${new Date(d.lastSeen).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}
              </div>
            </div>
            <button className="btn btn--small btn--deny" onClick={() => arc.send({ type: "UNPAIR", deviceId: d.id })}>
              UNPAIR
            </button>
          </div>
        ))}
      </Panel>
      <Panel title="FIRST CONNECTION">
        <p className="muted small">
          ARC uses a local HTTPS certificate so phones can use the camera and microphone. On first scan your phone warns that the certificate isn't trusted — choose “Advanced → Proceed”. Allow Node.js through Windows Firewall on private networks if the phone can't reach the PC.
        </p>
        {pairing && pairing.addresses.length > 1 && <p className="muted small">Other addresses: {pairing.addresses.slice(1).join(", ")}</p>}
      </Panel>
    </div>
  );
}

function Gauge({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <div className="gauge">
      <svg viewBox="0 0 84 84">
        <circle cx="42" cy="42" r={r} className="gauge__track" />
        <circle cx="42" cy="42" r={r} className="gauge__value" strokeDasharray={`${(v / 100) * c} ${c}`} />
      </svg>
      <div className="gauge__num">{value === null ? "—" : `${v}%`}</div>
      <div className="gauge__label">{label}</div>
    </div>
  );
}

export function SystemPanel() {
  const t = useArc((s) => s.telemetry);
  const s = useArc((x) => x.state);
  if (!s) return null;
  const h = t ? Math.floor(t.uptime / 3600) : 0;
  const m = t ? Math.floor((t.uptime % 3600) / 60) : 0;
  return (
    <div className="stack">
      <Panel title="SYSTEM">
        <div className="gauges">
          <Gauge label="CPU" value={t?.cpu ?? null} />
          <Gauge label="MEMORY" value={t?.memory ?? null} />
        </div>
        <StatusRow label="UPTIME" value={t ? `${h}h ${m}m` : "—"} />
        <StatusRow label="PLATFORM" value={s.services.desktop.platform.toUpperCase()} />
      </Panel>
      <Panel title="SERVICES">
        <StatusRow label="GROQ" value={s.services.ai.status} tone={toneFor(s.services.ai.status)} />
        <StatusRow label="MODEL" value={s.services.ai.model ?? "—"} />
        <StatusRow label="SPEECH-TO-TEXT" value={s.services.stt.status} tone={toneFor(s.services.stt.status)} />
        <StatusRow label="VOICE" value={s.services.voice.engine === "GROQ" ? "GROQ ORPHEUS" : s.services.voice.engine === "LOCAL" ? "WINDOWS · GEORGE" : "BROWSER FALLBACK"} tone={toneFor(s.services.voice.status)} />
        {s.services.voice.detail && <div className="muted small">{s.services.voice.detail}</div>}
        {s.services.ai.detail && s.services.ai.status !== "ONLINE" && <div className="muted small">{s.services.ai.detail}</div>}
        <StatusRow label="LOW-RISK AUTO RUN" value={s.settings.autoExecuteLowRisk ? "ON" : "OFF · ASK FIRST"} />
      </Panel>
    </div>
  );
}

// Stable fallback: a fresh [] inside a selector would re-render forever (zustand v5).
const NO_HISTORY: HistoryEntry[] = [];

export function HistoryPanel({ limit }: { limit?: number }) {
  const history = useArc((s) => s.state?.history ?? NO_HISTORY);
  const items = limit ? history.slice(-limit) : history;
  return (
    <Panel title="COMMAND HISTORY" className="history-panel">
      <div className="history">
        {!items.length && <div className="muted">No commands yet.</div>}
        {[...items].reverse().map((h) => (
          <div key={h.id} className={`history__item is-${h.role} ${h.error ? "is-error" : ""}`}>
            <span className="history__who">{h.role === "user" ? (h.device === "PHONE" ? "YOU · PHONE" : "YOU") : "JARVIS"}</span>
            <span className="history__time">{new Date(h.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            <div className="history__text">{h.text}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
