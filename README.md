# ARC — Augmented Reality Command

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

## ARC VISOR — facial HUD with eye-tracking cursor

**EYES → cursor · HANDS → actions · VOICE → JARVIS**

VISOR is a third ARC mode. The device's front camera tracks your face and hands; ARC isolates your face (background blacked out, visor colour grade, always centred) and assembles an armoured helmet HUD over it — faceplate, glowing eye lenses that close when you blink, seams, mouth grille, holographic mesh, head-pose ring. **Point with your hand, pinch to click.**

The eye-tracking cursor is built in but **off by default** (VISOR → SETTINGS → EYE-TRACKING CURSOR). When on, you look to aim and pinch to click, after a short calibration.

* **Enter:** "JARVIS, activate visor", or the VISOR button (PC nav / phone mode bar). VISOR opens on the device you asked from (phone by default) and uses its front camera.
* **Exit:** "JARVIS, exit visor" (or EXIT VISOR) — returns to the mode you came from. ARC never restarts; JARVIS, the socket and history stay as they are.
* **Boot:** a short real-check sequence (FACE / HAND TRACKING / JARVIS). With the eye-tracking cursor enabled there's also a one-time **9-point gaze calibration** (stored per device; "recalibrate gaze" redoes it).
* **In the HUD:** system status (left), 3D models, context (what you're targeting), applications (right), JARVIS response (bottom). Look at **VS Code** → `TARGET ACQUIRED` → `TARGET LOCKED` → pinch → confirmation → look at **YES** → pinch → executed.
* **Into Playground:** "enter playground" from VISOR keeps the gaze cursor on the PC (PC webcam; calibrate once there). Look at a 3D object → `TARGET ACQUIRED · EARTH` → pinch to select, keep pinching and move your hand to drag, twist to rotate, fist to free-rotate, two hands to scale. "disable eye tracking" turns it off.
* **SETTINGS button:** eye-tracking cursor on/off; when on — sensitivity, smoothing, optional dwell-click, recalibrate.
* **Failures degrade gracefully:** `FACE LOST`, `GAZE CONFIDENCE LOW`, `MOVE CLOSER TO CAMERA`, `HAND TRACKING LOST` — the cursor holds still instead of jumping, and voice keeps working.

**How gaze works:** MediaPipe Face Landmarker (478 landmarks incl. irises, blink blendshapes, head pose) → iris position within each eye + head pose + face position → ridge regression fitted during calibration → moving average + One-Euro filter + fixation dead-zone + confidence-gated step limit → cursor. Interactive controls use magnetic snapping with hysteresis, because webcam gaze is accurate to a few degrees, not pixels — targets in VISOR are deliberately large.

**Performance:** hand + face models run in a Web Worker (falls back to the main thread where unsupported), so the UI, HUD and 3D stay at display refresh rate; the hand cursor and face HUD are interpolated between camera frames. The Playground adapts its render resolution to hold ~60 fps.

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
* **Hands-free:** toggle the ear icon. ARC detects speech locally and only acts on phrases that start with **"JARVIS"** (follow-ups like "make it bigger" work for a few seconds after a reply). JARVIS never listens to himself while speaking.
* Speech-to-text: Groq `whisper-large-v3-turbo`. Common commands are parsed locally (instant, offline-safe); everything else goes to Groq.

### Things to say

| Desktop | Playground | ARC |
|---|---|---|
| open VS Code / Chrome / Spotify / *any installed app* | spawn a 3D earth / saturn / car / engine / heart / brain / dna / atom / solar system | enter playground / command mode · activate / exit visor · recalibrate gaze |
| close Chrome · is Chrome open? | rotate it · spin it · stop rotating | switch to phone camera / PC camera |
| search for … · youtube … · open github.com | make it bigger / smaller · move it to the left | what time is it · what's 25 times 4 |
| find file *budget* · open file *notes.txt* · create file *ideas* | show India · hide the atmosphere · explode it | remember … · read my notes |
| delete file *old draft* (hold to confirm) | delete it · clear the scene · reset view | stop / cancel |
| system info · battery · volume up · next track · type *hello* | "put a car next to the earth and spin both" (Groq) | "explain … in detail" (long answer) |

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

> Groq's free tier limits `qwen3.8-27b` to ~7,000 input tokens/minute (≈5 open-ended questions per minute). ARC falls back to the gpt-oss models automatically; local commands don't use tokens at all.

## Scripts

| | |
|---|---|
| `npm run setup` | Fetch runtime assets into `client/public` (safe to re-run) |
| `npm run build` | Build the client |
| `npm start` | Run ARC |
| `npm run dev` | Rebuild client + restart server on change |
| `npm test` | Unit tests (intent parsing, LLM output validation, risk policy, file sandbox) |
| `npm run typecheck` | TypeScript check for server, client and shared code |

## Troubleshooting

* **Phone can't connect** — same Wi‑Fi? Allow Node.js in Windows Firewall (private). Use one of the LAN addresses printed at startup. Some guest/office networks block device-to-device traffic.
* **Camera / mic blocked on phone** — the page must be opened via `https://`; accept the certificate warning, then allow permissions. iOS: Safari only.
* **"ARC was opened in another tab"** — one console per role; press *USE ARC HERE* to take over.
* **JARVIS uses the browser voice** — accept the Orpheus terms (see above).
* **Hand tracking slow** — good light helps; MediaPipe uses the GPU when available and falls back to CPU.

## Extending

* **New desktop action:** add it to `DesktopActionSchema`, give it a risk in `security/risk.ts`, implement `prepare`/`execute` in `ActionExecutor`, mention it in `jarvis/prompt.ts`.
* **New 3D object:** add a builder in `client/src/playground/objects/` + an entry in `shared/catalog.ts`.
* **New AI / voice provider:** implement `AIProvider` / `VoiceProvider` and swap it in `server/index.ts`.
* **Hybrid mode:** add a mode whose `CameraManager.routes()` returns both routes.

## Credits

* Planet, Sun, Moon, ring and Milky Way textures: © [Solar System Scope](https://www.solarsystemscope.com/textures/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
* Earth textures: three.js examples (NASA imagery). Country outlines: Natural Earth (public domain).
* Hand / face tracking: Google MediaPipe Tasks (Apache 2.0).
