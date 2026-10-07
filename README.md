# ARC — Augmented Reality Command Center

**JARVIS is the brain. ARC is the interface.**

ARC is a persistent spatial-computing system: your **phone** is a portable vision/control console, your **PC** is the execution machine and 3D playground, **your voice** gives commands, **your hands** interact, and **Groq** provides fast intelligence. One ARC Core session stays alive while modes, cameras and devices change around it.

---

## Quick start

```powershell
npm install
npm run setup        # downloads hand-tracking model, Earth textures, country outlines (served locally)
copy .env.example .env
# edit .env → GROQ_API_KEY=...
npm run build
npm start
```

1. On the PC, open **https://localhost:7777** → the browser warns about the local certificate → *Advanced → Proceed*.
2. Open **DEVICES** (left nav) and scan the QR code with your phone (same Wi‑Fi). Accept the certificate warning once.
3. On the phone, tap **ENGAGE ARC** (enables voice output + microphone).
4. Say or type: **"JARVIS, open VS Code"** → point at **YES** → pinch.

Windows will ask to allow Node.js through the firewall the first time — allow it on **private** networks so the phone can connect.

### Enable JARVIS's Groq voice (one-time)

JARVIS speaks with Groq's male *Orpheus* voice (`daniel`). Groq requires the org admin to accept the model terms once:
<https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english>
Until then ARC automatically uses the best male voice your browser offers (e.g. *Microsoft Ryan/Guy Natural*, *Google UK English Male*, *Daniel*). SYSTEM → VOICE shows which engine is active.

---

## The MVP flow

| Step | You | ARC |
|---|---|---|
| 1 | Open ARC on the phone | Boot sequence (real checks) → `JARVIS ● ONLINE` |
| 2 | Scan the PC's QR code | `DESKTOP ● CONNECTED` / `PHONE ● CONNECTED` |
| 3 | "JARVIS, open VS Code." | `JARVIS REQUEST — Open Visual Studio Code? [YES] [NO]` |
| 4–6 | Point at YES, pinch | `CONFIRMED → AUTHORIZED → EXECUTING → COMPLETE` |
| 7–8 | — | VS Code opens · *"Visual Studio Code is ready, boss."* |
| 9–10 | "JARVIS, enter playground." | `VISION HANDOFF  PHONE ↓ PC  3 2 1` → `PLAYGROUND MODE · PC CAMERA ● CONNECTED` |
| 11–13 | "Spawn a 3D Earth." | Earth materialises in the 3D workspace |
| 14 | Pinch / fist and move | Grab, move, rotate, scale it with your hands |
|  | "Show India." | Globe turns to India, border highlighted, info panel |

ARC never reloads, reconnects or resets during any of this — the handoff is a visual layer over the running UI.

---

## Phone + PC: two spaces, one bridge

The phone and the PC each have **their own space**. Working in the Playground on the PC doesn't drag the phone along, and opening the visor on the phone doesn't take over the PC. Anything you say or tap on the phone that affects the PC runs on the PC: say "JARVIS, open VS Code" on the phone while you work on the PC and it opens there.

* **Phone = touch-first remote + second screen.** It has five tabs:
  * **Command:** JARVIS, a live card showing what the PC is doing, confirmations and replies.
  * **Remote:** switch the PC between Console / Playground / Deep Dive. A touchpad turns the model (drag) and zooms (pinch). *Tilt to turn* uses the phone's motion sensor.
  * **Library:** every model (built-in + yours), import from the phone, **send any file** to the PC (it lands in `Downloads\ARC`), **copy text to the PC clipboard**.
  * **Visor:** opens the helmet HUD on the phone.
  * **Settings:** listening, phone hand tracking, status.
* **Phone hand tracking is off by default.** One hand holds the phone, so hand tracking runs on the PC webcam. The visor uses the phone's front camera for your face only, and you control it by touch. Switch phone hand tracking on in Settings if you want it.
* **Confirmations go to the device that asked:** full YES/NO there, a compact copy on the other screen.
* **JARVIS speaks** on the phone in its Command / Visor space and on the PC while the PC runs the Playground. **The phone mic listens** whenever the phone is connected.

## Deep Dive — one model, AR hologram, labelled parts

Playground shows every model with its normal look. **Deep Dive** puts one model alone on a studio stage:

* **Pick a model:** say "deep dive", press DEEP DIVE, or pick on the phone. A ring of holographic cards appears. **Close your fist and move sideways to spin it**, let go and it settles, then pinch the front card or say "this one". Drag, swipe, the ← → keys or the phone also spin it. You can jump straight in with "deep dive the heart" or "deep dive into my drone".
* **AR mode** ("turn on AR mode") turns the model into a blue hologram: dark translucent core, fresnel glow and edge lines, on a holographic turntable. Labels point out its parts:
  * zoomed out: the main parts
  * zoom in: every part
  * closer still: each part's function
  * labels sit in two columns beside the model with leader lines, dimmed when the part is behind the model
* **Focus a part:** click its label, tap it on the phone, or say "show me the left ventricle". The camera flies to it, highlights it and shows its function.
* **Make it yours:** background colour, hologram colour, label colour, solid / wireframe / x-ray, spin speed, label detail (zoom / main / all) and **exploded view**. Use the panel, the phone, or say "make the background black", "x-ray view", "explode it". Each model remembers its look.
* Built-in models come with labelled parts (heart, brain, engine, car, Earth, Saturn, Sun, solar system, atom, DNA).

## Your own 3D models

* **Import** `.glb` (best), `.gltf` (self-contained), `.obj`, `.stl` or `.fbx`, up to 200 MB:
  * drag files onto the PC window
  * press IMPORT on the Playground shelf or the phone's Library tab
  * or drop them into the `models/` folder (picked up automatically)
* ARC centres and scales the model, renders a thumbnail and adds it to the library. Spawn it by name ("spawn my drone") or Deep Dive into it.
* **Labels for your models:**
  * **Named parts** (e.g. `Left_Ventricle` → "Left Ventricle") become labels automatically, and JARVIS writes a one-line function for each.
  * **One-piece models** get labels from **PIN LABEL** in Deep Dive: click a spot on the model, type the name, and JARVIS fills in the function.
* Your laptop's Intel UHD handles models up to roughly 300–500k triangles smoothly.

## ARC VISOR — Iron Man helmet HUD

**FACE → HUD · HANDS → actions · VOICE → JARVIS**

VISOR is an optional third ARC mode; the Playground and JARVIS are the main features. It puts you inside the helmet. The front camera tracks your face and hands. ARC cuts out your real face along its contour, hairline included, with a soft feathered edge, blacks out the background and keeps the face framed. Around it sits the helmet interior: an eye reticle locked to your eye (it blinks with you), a TARGET LOCK callout with head yaw/pitch, a voice ring on your mouth, curved glass side panels (systems readout with a hologram suit whose arms light up when your hands are tracked; apps and 3D models), and a glowing console rim with blue flares. **Point with your hand, pinch to click.**

The eye-tracking cursor is built in but **off by default** (VISOR → SETTINGS → EYE-TRACKING CURSOR). When on, you look to aim and pinch to click, after a short calibration.

* **Enter:** "JARVIS, activate visor", the VISOR button in the PC nav, or the phone's **Visor** tab. **Phone-first:** if the phone is connected, VISOR always opens on the phone (landscape) and uses its front camera, wherever you asked from. The PC keeps its own space. On the phone the visor tracks your face only, and you tap to choose. Without a phone it runs on the PC webcam (point + pinch), at lower fps (see *Performance*).
* **Exit:** "JARVIS, exit visor" (or EXIT VISOR) — returns to the mode you came from. ARC never restarts; JARVIS, the socket and history stay as they are.
* **Boot:** a short real-check sequence (FACE / HAND TRACKING / JARVIS). With the eye-tracking cursor enabled there's also a one-time **9-point gaze calibration** (stored per device; "recalibrate gaze" redoes it).
* **In the HUD:** system status (left), 3D models, context (what you're targeting), applications (right), JARVIS response (bottom). Look at **VS Code** → `TARGET ACQUIRED` → `TARGET LOCKED` → pinch → confirmation → look at **YES** → pinch → executed.
* **Into Playground:** "enter playground" from VISOR keeps the gaze cursor on the PC (PC webcam; calibrate once there). Look at a 3D object → `TARGET ACQUIRED · EARTH` → pinch to select, keep pinching and move your hand to drag, twist to rotate, fist to free-rotate, two hands to scale. "disable eye tracking" turns it off.
* **SETTINGS button:** eye-tracking cursor on/off; when on — sensitivity, smoothing, optional dwell-click, recalibrate.
* **Failures degrade gracefully:** `FACE LOST`, `GAZE CONFIDENCE LOW`, `MOVE CLOSER TO CAMERA`, `HAND TRACKING LOST` — the cursor holds still instead of jumping, and voice keeps working.

**How gaze works:** MediaPipe Face Landmarker (478 landmarks incl. irises, blink blendshapes, head pose) → iris position within each eye + head pose + face position → ridge regression fitted during calibration → moving average + One-Euro filter + fixation dead-zone + confidence-gated step limit → cursor. Interactive controls use magnetic snapping with hysteresis, because webcam gaze is accurate to a few degrees, not pixels — targets in VISOR are deliberately large.

**Performance:** hands and face each run in their own Web Worker, in parallel. ARC picks GPU if it can, otherwise the main-thread GPU path, otherwise CPU. The camera frame and its landmarks are drawn together, so the HUD never trails your face. The hand cursor is One-Euro filtered and drawn at display refresh with short motion prediction. The Playground adapts its render resolution to hold ~60 fps, and on Intel / weak GPUs it starts at 1× resolution with cheaper shadows.

The VISOR status panel shows a live perf line: `CAM 30 · HANDS 30 (WORKER · GPU) · FACE 30 (WORKER · GPU)`. **Video can never be smoother than the camera.** Most laptop webcams top out at 30 fps (≈15 fps in dim light), so on the PC the face video moves at camera speed while the HUD and cursor stay at 60. Phones deliver 60 fps from the front camera, which is why VISOR prefers the phone. If the line shows `CPU`, the browser has no WebGL for MediaPipe: update the GPU driver and enable hardware acceleration in Chrome/Edge.

**Privacy:** face and eye tracking run entirely on the device that owns the camera. No video or gaze coordinates leave it; only a status summary (face/gaze/hands state, current target name) is sent to ARC Core.

**Expectations:** webcam/phone-camera gaze is coarse (typically 2–4° ≈ 2–5 cm on a laptop screen at arm's length). It works best with your face well lit, 40–70 cm from the camera, and the head fairly still.

---

## Architecture

```
ARC/
├── shared/            Protocol: zod schemas (validated server-side), state + message types, object/country catalog
├── server/            ARC Core (Node, HTTPS + one persistent WebSocket per device)
│   ├── core/          ArcCore — the single long-lived session (mode, vision, devices, history, scene)
│   ├── camera/        CameraManager — active vision source + source→consumer routes
│   ├── websocket/     DeviceHub — auth, origin check, heartbeat, routing, landmark relay
│   ├── jarvis/        JARVIS — local fast-path intents → Groq → validated structured actions
│   ├── ai/            AIProvider interface · GroqProvider (chat w/ model fallback, Whisper STT)
│   ├── voice/         VoiceProvider interface · GroqVoice (Orpheus, male)
│   ├── actions/       ActionExecutor — allowlisted desktop actions (apps, files, web, media, system)
│   ├── security/      Risk policy, device pairing, local HTTPS certificate
│   └── http/          Static server for the built client
└── client/src/        Browser app (same code on phone and PC; role decided by origin)
    ├── core/          ArcClient (persistent socket, auto-reconnect), store, services (created once)
    ├── camera/        CameraSource, VisionManager (follows routes; starts/stops camera live)
    ├── gestures/      HandTracker (MediaPipe), GestureManager, HandPointer (DOM), One-Euro filter
    ├── voice/         VoiceInput (PCM + VAD + wake word), VoiceOutput (server voice / male browser voice)
    ├── playground/    PlaygroundEngine (three.js), ObjectManager, PlaygroundInteraction, objects/*
    ├── visor/         VisorManager, FaceTracker, EyeTracker, GazeCalibration, GazeSmoother, GazeCursor, TargetingManager
    └── ui/            Desktop console, phone console, HUD, confirmation, boot, handoff
```

### Why ARC never restarts

* **Server:** every module (`ArcCore`, `CameraManager`, `Jarvis`, `DeviceHub`, executor) is constructed once in `server/index.ts`. Modes and cameras are *fields* on `ArcCore`; `setMode()` / `switchCamera()` mutate state and broadcast it.
* **Client:** services in `client/src/core/services.ts` are created once at page load, outside React. The device app is mounted once; boot, handoff and errors are overlays. The 3D engine is built once and only *paused* outside playground mode — its canvas is moved, never recreated.
* **Connection:** one WebSocket per device for the life of the session; if it drops, the client reconnects with backoff and the server resumes the same session (history, scene, mode persist in `.arc/session.json`, even across server restarts).

### Vision routing (hybrid-ready)

`CameraManager` publishes routes like `{ source: "PHONE", consumer: "PHONE" }`. A device runs its camera only when it is a route's **source**; if the consumer is another device it relays **landmarks** (~30 fps, a few KB/s — never video) over the existing socket. Command mode = `PHONE → PHONE`, Playground = `PC → PC`, and switching the phone camera on during playground gives `PHONE → PC` (already working). A future **Hybrid mode** is just two routes — no consumer code changes.

---

## Voice

* **Push-to-talk:** tap the mic, speak, tap again.
* **Hands-free (on by default):** toggle the ear icon. ARC detects speech locally and only acts on phrases that start with **"JARVIS"** (follow-ups like "make it bigger" work for a few seconds after a reply). JARVIS never listens to himself while speaking, on either device.
* **Which mic listens:** the phone's, whenever the phone is connected. Otherwise the PC's (click or press a key once so the browser allows audio). The command bar says where JARVIS is listening.
* **Cancelled actions say why:** the timeline shows *Cancelled by voice / touch / gesture*, *No answer — timed out*, or *Replaced by a newer request*, and the server logs it too. Open-hand palm only stops JARVIS talking. It no longer cancels a pending confirmation.
* Speech-to-text: Groq `whisper-large-v3-turbo`. Common commands are parsed locally (instant, offline-safe); everything else goes to Groq.
* **JARVIS's voice:** Groq Orpheus when its terms are accepted; otherwise the **Windows voice on the PC** (a British male voice, "George", when installed). Either way it's synthesised on the PC and streamed to the device that speaks. That works reliably on iPhone, where Safari's own speech engine is often silent. The browser voice is only the last fallback.

### Things to say

| Desktop | Playground | ARC |
|---|---|---|
| open VS Code / Chrome / Spotify / *any installed app* | spawn a 3D earth / saturn / car / engine / heart / brain / dna / atom / solar system | enter playground / command mode · activate / exit visor · recalibrate gaze |
| close Chrome · is Chrome open? | rotate it · spin it · stop rotating | switch to phone camera / PC camera |
| search for … · youtube … · open github.com | make it bigger / smaller · move it to the left | what time is it · what's 25 times 4 |
| find file *budget* · open file *notes.txt* · create file *ideas* | show India · hide the atmosphere · explode it | remember … · read my notes |
| delete file *old draft* (hold to confirm) | delete it · clear the scene · reset view | stop / cancel |
| system info · battery · volume up · next track · type *hello* | "put a car next to the earth and spin both" (Groq) | "explain … in detail" (long answer) |
| | **Deep Dive:** deep dive the heart · deep dive into my drone · this one / next | turn on AR mode · x-ray view · explode it · make the background black · show me the aorta · show all labels · exit deep dive |

---

## Gestures

| Gesture | Command mode (phone / DOM) | Playground (3D) |
|---|---|---|
| **Point** | Move the cursor, hover buttons | Hover objects |
| **Pinch** | Click / select (YES, NO, any button) | Grab + move; twist your hand to rotate |
| **Pinch & hold** | Confirm HIGH-risk actions (1.5 s) | — |
| **Fist** | — | Free-rotate the object |
| **Two-hand pinch** | — | Scale |
| **Open palm (hold)** | Cancel the pending request / stop speech | Release & stop motion |
| **Swipe** | — | Next / previous object |
| Pinch on empty space | — | Orbit the view |

Mouse/touch work everywhere too (drag to move, right/shift-drag to rotate, wheel to scale, double-click to reset view).

---

## Security model

* **No arbitrary execution.** The LLM can only emit actions from a fixed schema (`shared/schemas.ts`); invalid or unknown actions are dropped. The executor maps each action to a fixed implementation. No shell is ever spawned (`shell: false`); dynamic values reach PowerShell helpers only via environment variables.
* **Risk is ARC's decision**, never the model's (`server/security/risk.ts`):
  * informational (system info, find file, is X open, media keys, playground) → runs immediately
  * **LOW** (open app/website/file) → asks first; set `ARC_AUTO_EXECUTE_LOW_RISK=true` to run immediately
  * **MEDIUM** (close app, create file, type text) → always asks
  * **HIGH** (delete) → always asks, confirm must be **held**; voice "yes" is refused; files go to the **Recycle Bin**, never permanently deleted
* Targets are resolved *before* confirmation, so the panel shows the exact app or full file path.
* File access is sandboxed to `ARC_FILE_ROOTS` (default Desktop/Documents/Downloads; symlinks/junctions resolved first). Executables and scripts (`.exe .bat .ps1 .lnk .vbs .msi …`) are never opened.
* Closing apps is graceful (WM_CLOSE) so apps can prompt about unsaved work; system processes and ARC itself are protected.
* `GROQ_API_KEY` stays in `.env` on the server; the browser never sees it.
* WebSocket: origin-checked (other sites in your browser can't drive ARC), the PC role is accepted only from the machine itself, phones need a one-time QR token (single-use, 10 min) that's exchanged for a device token (only its hash is stored). Unpair from DEVICES.

---

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `GROQ_API_KEY` | — | required |
| `GROQ_MODEL` | `qwen/qwen3.8-27b` | primary brain (~0.3–0.8 s) |
| `GROQ_FALLBACK_MODELS` | `openai/gpt-oss-120b,openai/gpt-oss-20b` | used on capacity / rate-limit errors |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | |
| `GROQ_TTS_MODEL` / `GROQ_TTS_VOICE` | `canopylabs/orpheus-v1-english` / `daniel` | male voice (`troy`, `austin` also male) |
| `ARC_PORT` | `7777` | |
| `ARC_FILE_ROOTS` | Desktop;Documents;Downloads | `;`-separated |
| `ARC_AUTO_EXECUTE_LOW_RISK` | `false` | |
| `ARC_MODELS_DIR` | `ARC/models` | your 3D model library |
| `ARC_INBOX_DIR` | `Downloads\ARC` | where files sent from the phone land |
| `ARC_LOCAL_VOICE` | `George` | Windows voice used when Groq's isn't available (`off` to disable) |

> Groq's free tier limits `qwen3.8-27b` to ~7,000 input tokens/minute (≈5 open-ended questions per minute). ARC falls back to the gpt-oss models automatically; local commands don't use tokens at all.

## Scripts

| | |
|---|---|
| `npm run setup` | Fetch runtime assets into `client/public` (safe to re-run) |
| `npm run build` | Build the client |
| `npm start` | Run ARC |
| `npm run dev` | Rebuild client + restart server on change |
| `npm test` | Unit tests (intent parsing, Deep Dive commands, per-device spaces, LLM output validation, risk policy, file sandbox) |
| `npm run typecheck` | TypeScript check for server, client and shared code |

## Troubleshooting

* **JARVIS silent on the iPhone** — tap ENGAGE ARC once (iOS only allows audio after a tap), check the ring/silent switch, and look at Settings › VOICE: it should say WINDOWS · GEORGE or GROQ.
* **A model won't load** — prefer `.glb`. A `.gltf` that references separate `.bin`/texture files can't be uploaded as a single file; export it as `.glb` instead.
* **Phone can't connect** — same Wi‑Fi? Allow Node.js in Windows Firewall (private). Use one of the LAN addresses printed at startup. Some guest/office networks block device-to-device traffic.
* **Camera / mic blocked on phone** — the page must be opened via `https://`; accept the certificate warning, then allow permissions. iOS: Safari only.
* **"ARC was opened in another tab"** — one console per role; press *USE ARC HERE* to take over.
* **JARVIS uses the browser voice** — accept the Orpheus terms (see above).
* **Hand tracking slow** — good light helps; MediaPipe uses the GPU when available and falls back to CPU.
* **VISOR laggy on the PC** — check the perf line. `CAM 15` means the webcam is light-starved (more light helps). `CPU` means no GPU path. Low-end laptops (2-core CPUs with integrated graphics) are the real limit, so connect the phone and VISOR moves there.
* **ARC opens in Command mode** after every server start. That's deliberate.

## Extending

* **New desktop action:** add it to `DesktopActionSchema`, give it a risk in `security/risk.ts`, implement `prepare`/`execute` in `ActionExecutor`, mention it in `jarvis/prompt.ts`.
* **New 3D object:** add a builder in `client/src/playground/objects/` + an entry in `shared/catalog.ts`.
* **New AI / voice provider:** implement `AIProvider` / `VoiceProvider` and swap it in `server/index.ts`.
* **Hybrid mode:** add a mode whose `CameraManager.routes()` returns both routes.

## Credits

* Planet, Sun, Moon, ring and Milky Way textures: © [Solar System Scope](https://www.solarsystemscope.com/textures/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
* Earth textures: three.js examples (NASA imagery). Country outlines: Natural Earth (public domain).
* Hand / face tracking: Google MediaPipe Tasks (Apache 2.0).
