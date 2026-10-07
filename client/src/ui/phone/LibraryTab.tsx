import { useRef, useState } from "react";
import { OBJECT_CATALOG } from "@shared/catalog";
import { useArc, notify } from "../../core/store";
import { arc, uploadFile } from "../../core/services";
import { Panel } from "../primitives";
import { Icon, ObjectGlyph } from "../Icons";

const EMPTY: never[] = [];

interface Item {
  id: string;
  name: string;
  sub: string;
  imported: boolean;
}

const formatSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Pick a file and upload it with progress. */
function useUpload() {
  const [progress, setProgress] = useState<{ name: string; p: number } | null>(null);
  const send = async (file: File) => {
    setProgress({ name: file.name, p: 0 });
    const r = await uploadFile(file, (p) => setProgress({ name: file.name, p }));
    setProgress(null);
    if (!r.ok) notify({ level: "error", title: "SEND FAILED", text: r.error ?? file.name }, 6000);
    else notify({ level: "info", title: r.kind === "model" ? "MODEL ADDED" : "SENT TO PC", text: r.name ?? file.name }, 3500);
  };
  return { progress, send };
}

function ModelSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const [name, setName] = useState(item.name);
  const [renaming, setRenaming] = useState(false);
  const run = (fn: () => void) => {
    fn();
    onClose();
  };
  return (
    <div className="sheet" onClick={onClose}>
      <div className="sheet__body" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <span>{item.name.toUpperCase()}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.Close width={18} height={18} />
          </button>
        </div>
        <div className="sheet__rows">
          <button className="btn" onClick={() => run(() => arc.send({ type: "ACTION_REQUEST", action: { action: "DEEP_DIVE", enabled: true, model: item.id } }))}>
            <Icon.Dive width={18} height={18} /> DEEP DIVE ON PC
          </button>
          <button className="btn btn--tool" onClick={() => run(() => arc.send({ type: "ACTION_REQUEST", action: { action: "SPAWN_OBJECT", object: item.id } }))}>
            <Icon.Cube width={18} height={18} /> SPAWN IN PLAYGROUND
          </button>
          {item.imported &&
            (renaming ? (
              <form
                className="ph-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) run(() => arc.send({ type: "MODEL_RENAME", model: item.id, name: name.trim() }));
                }}
              >
                <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                <button className="btn btn--small" type="submit">
                  SAVE
                </button>
              </form>
            ) : (
              <button className="btn btn--tool" onClick={() => setRenaming(true)}>
                RENAME
              </button>
            ))}
          {item.imported && (
            <button className="btn btn--deny" onClick={() => run(() => arc.send({ type: "MODEL_DELETE", model: item.id }))}>
              <Icon.Trash width={18} height={18} /> DELETE FROM LIBRARY
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SendToPc() {
  const fileInput = useRef<HTMLInputElement>(null);
  const { progress, send } = useUpload();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const paste = async () => {
    setNote(null);
    try {
      const t = await navigator.clipboard.readText();
      if (t) setText(t);
      else setNote("Your clipboard is empty");
    } catch {
      setNote("Paste into the box instead (long-press → Paste)");
    }
  };
  const sendText = () => {
    const t = text.trim();
    if (!t) return;
    arc.send({ type: "SEND_CLIPBOARD", text: t });
    setText("");
    setNote("Sent — it's on your PC clipboard");
  };
  return (
    <Panel title="SEND TO PC" className="ph-card">
      <button className="btn btn--tool ph-wide" onClick={() => fileInput.current?.click()} disabled={Boolean(progress)}>
        <Icon.Upload width={18} height={18} /> {progress ? `SENDING ${progress.name.slice(0, 18)} · ${Math.round(progress.p * 100)}%` : "SEND A FILE OR PHOTO"}
      </button>
      {progress && (
        <div className="ph-progress">
          <i style={{ width: `${Math.round(progress.p * 100)}%` }} />
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void send(f);
          e.target.value = "";
        }}
      />
      <p className="muted small">Files land in Downloads › ARC on the PC. 3D models go straight into your library.</p>
      <div className="ph-clip">
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Text for the PC clipboard…" rows={3} />
        <div className="ph-clip__row">
          <button className="btn btn--tool" onClick={paste}>
            <Icon.Clipboard width={16} height={16} /> PASTE
          </button>
          <button className="btn" onClick={sendText} disabled={!text.trim()}>
            <Icon.Send width={16} height={16} /> COPY TO PC
          </button>
        </div>
        {note && <p className="muted small">{note}</p>}
      </div>
    </Panel>
  );
}

export function LibraryTab() {
  const library = useArc((s) => s.state?.library ?? EMPTY);
  const thumbs = useArc((s) => s.state?.thumbs);
  const [open, setOpen] = useState<Item | null>(null);
  const [query, setQuery] = useState("");
  const modelInput = useRef<HTMLInputElement>(null);
  const { progress, send } = useUpload();

  const items: Item[] = [
    ...library.map((m) => ({ id: m.id, name: m.name, sub: `${m.format.toUpperCase()} · ${formatSize(m.size)}`, imported: true })),
    ...OBJECT_CATALOG.map((e) => ({ id: e.id, name: e.name, sub: e.category, imported: false })),
  ];
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => i.name.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q)) : items;

  return (
    <div className="ph-stack">
      <div className="ph-libhead">
        <input className="ph-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models" type="search" />
        <button className="btn ph-import" onClick={() => modelInput.current?.click()} disabled={Boolean(progress)}>
          <Icon.Upload width={18} height={18} /> {progress ? `${Math.round(progress.p * 100)}%` : "IMPORT"}
        </button>
        <input
          ref={modelInput}
          type="file"
          hidden
          accept=".glb,.gltf,.obj,.stl,.fbx,model/gltf-binary"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void send(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="ph-grid">
        {shown.map((i) => (
          <button key={i.id} className={`ph-model ${i.imported ? "is-imported" : ""}`} onClick={() => setOpen(i)}>
            <div className="ph-model__art">{thumbs?.[i.id] ? <img src={thumbs[i.id]} alt="" loading="lazy" /> : <ObjectGlyph kind={i.id} size={40} />}</div>
            <b>{i.name}</b>
            <span>{i.imported ? "YOUR MODEL" : i.sub.toUpperCase()}</span>
          </button>
        ))}
      </div>
      {!library.length && !q && <p className="muted small ph-center">Import a .glb, .gltf, .obj, .stl or .fbx — or drop files into the ARC/models folder on the PC.</p>}

      <SendToPc />
      {open && <ModelSheet item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
