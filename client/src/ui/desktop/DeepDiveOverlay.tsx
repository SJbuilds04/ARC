import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useArc } from "../../core/store";
import { arc, deepDive } from "../../core/services";
import { Panel } from "../primitives";
import { Icon } from "../Icons";
import { CollectionTabs, DeepDiveControls, ModelActions, PartsList, ddAction, useDeepDiveTitle } from "../deepdive";

/** Hosts the persistent DOM label layer (created once by the Deep Dive engine). */
function LabelHost() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = deepDive?.labels.el;
    if (ref.current && el) ref.current.appendChild(el);
    return () => el?.remove();
  }, []);
  return <div className="dd-label-host" ref={ref} />;
}

/** Name the label you just pinned on the model. */
function PinPrompt() {
  const pin = useArc((s) => s.pinPrompt);
  const [name, setName] = useState("");
  if (!pin) return null;
  const close = () => {
    setName("");
    useArc.setState({ pinPrompt: null });
  };
  const save = () => {
    const n = name.trim();
    if (n) arc.send({ type: "LABEL_ADD", model: pin.model, name: n, pos: pin.pos });
    close();
  };
  return (
    <form
      className="dd-pin"
      style={{ left: Math.min(innerWidth - 300, pin.x + 14), top: Math.min(innerHeight - 120, pin.y - 20) }}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <span>NAME THIS PART</span>
      <input autoFocus value={name} maxLength={60} placeholder="e.g. Left ventricle" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && close()} />
      <div className="dd-pin__row">
        <button type="button" className="btn btn--small btn--deny" onClick={close}>
          CANCEL
        </button>
        <button type="submit" className="btn btn--small">
          SAVE LABEL
        </button>
      </div>
    </form>
  );
}

/** Slim arrows at the screen edges: nothing sits over the models (the front one says how to open it). */
function CarouselArrows() {
  const empty = useArc((s) => s.state?.deepDive.collection === "yours" && !s.state.library.length);
  if (empty) return null;
  return (
    <>
      <button className="dd-arrow dd-arrow--left arc-ui-block" onClick={() => deepDive?.step(-1)} aria-label="Previous model" title="Previous (←)">
        <Icon.Chevron width={22} height={22} style={{ transform: "scaleX(-1)" }} />
      </button>
      <button className="dd-arrow dd-arrow--right arc-ui-block" onClick={() => deepDive?.step(1)} aria-label="Next model" title="Next (→)">
        <Icon.Chevron width={22} height={22} />
      </button>
    </>
  );
}

/** "Your models" with nothing imported yet: say how to add one instead of showing an empty stage. */
function EmptyCollection() {
  const collection = useArc((s) => s.state?.deepDive.collection ?? null);
  const count = useArc((s) => s.state?.library.length ?? 0);
  if (collection !== "yours" || count > 0) return null;
  return (
    <div className="dd-empty arc-ui-block">
      <b>NO MODELS OF YOUR OWN YET</b>
      <span>Import a .glb, .gltf, .obj, .stl or .fbx from the Playground shelf, drop it in the models folder, or send it from your phone.</span>
    </div>
  );
}

/** Always on screen while diving (carousel or model). */
function ExitButton() {
  return (
    <button className="btn btn--deny dd-exit arc-ui-block" onClick={() => ddAction({ action: "DEEP_DIVE", enabled: false })} title="Leave Deep Dive (Esc)">
      <Icon.Close width={16} height={16} /> EXIT DEEP DIVE
    </button>
  );
}

/** Report the free space between the panels to the Deep Dive engine (labels + model live there). */
function useSafeArea(left: RefObject<HTMLElement | null>, right: RefObject<HTMLElement | null>, deps: unknown[]) {
  useLayoutEffect(() => {
    const measure = () => {
      const l = left.current?.getBoundingClientRect();
      const r = right.current?.getBoundingClientRect();
      deepDive?.setSafeArea(l ? l.right + 10 : 16, r ? r.left - 10 : innerWidth - 16);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (left.current) ro.observe(left.current);
    if (right.current) ro.observe(right.current);
    addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      removeEventListener("resize", measure);
      deepDive?.setSafeArea(16, innerWidth - 16);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function DeepDiveOverlay() {
  const title = useDeepDiveTitle();
  const ar = useArc((s) => s.state?.deepDive.settings.labels ?? s.state?.deepDive.settings.ar ?? false);
  const partCount = useArc((s) => s.state?.deepDive.parts.length ?? 0);
  // In AR the labels on screen ARE the parts list, so the list starts folded on smaller screens.
  const [partsOpen, setPartsOpen] = useState(() => innerWidth >= 1700);
  useEffect(() => {
    if (ar && innerWidth < 1700) setPartsOpen(false);
  }, [ar]);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  useSafeArea(leftRef, rightRef, [Boolean(title), partsOpen]);
  const modelId = useArc((s) => s.state?.deepDive.modelId ?? null);
  const [pinning, setPinning] = useState(false);
  const pinPrompt = useArc((s) => s.pinPrompt);
  const imported = Boolean(modelId?.startsWith("m-"));
  useEffect(() => setPinning(false), [modelId, pinPrompt]);

  return (
    <div className="dd-overlay">
      <LabelHost />
      <ExitButton />
      {title ? (
        <>
          <div className="dd-panel-wrap" ref={leftRef}>
          <Panel title="DEEP DIVE" className="dd-panel arc-ui-block">
            <div className="dd-panel__kicker">{title.category}</div>
            <div className="dd-panel__name">{title.name}</div>
            <ModelActions />
            <DeepDiveControls />
            <div className="dd-panel__actions">
              <button className="btn btn--tool" onClick={() => ddAction({ action: "DEEP_DIVE", enabled: true })}>
                <Icon.Library width={16} height={16} /> CHANGE MODEL
              </button>
              {imported && (
                <button
                  className={`btn btn--tool ${pinning ? "is-on" : ""}`}
                  onClick={() => {
                    if (!deepDive) return;
                    deepDive.pinMode = !pinning;
                    setPinning(!pinning);
                  }}
                >
                  <Icon.Pin width={16} height={16} /> {pinning ? "CLICK THE MODEL…" : "PIN LABEL"}
                </button>
              )}
            </div>
          </Panel>
          </div>
          <div className="dd-parts-wrap" ref={rightRef}>
            {partsOpen ? (
              <Panel
                title={`PARTS · ${partCount}`}
                className="dd-parts-panel arc-ui-block"
                right={
                  <button className="icon-btn" onClick={() => setPartsOpen(false)} aria-label="Fold parts list">
                    <Icon.Close width={14} height={14} />
                  </button>
                }
              >
                <PartsList />
              </Panel>
            ) : (
              <button className="btn btn--tool dd-parts-toggle arc-ui-block" onClick={() => setPartsOpen(true)}>
                <Icon.Library width={16} height={16} /> PARTS · {partCount}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="dd-cats-top arc-ui-block">
            <CollectionTabs />
          </div>
          <CarouselArrows />
          <EmptyCollection />
        </>
      )}
      <PinPrompt />
    </div>
  );
}
