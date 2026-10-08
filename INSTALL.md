# Installing ARC

This guide takes a brand-new PC to a running ARC in about 15 minutes. You'll install one official program (Node.js), download ARC, and run five commands. There is no installer, batch file or `.exe` from us, so there's nothing you have to trust blindly. Every step below is visible and explained.

> ARC is built and tested on **Windows 10 and 11**. It also runs on macOS and Linux, but controlling the desktop (opening apps, media keys, the backup Windows voice) is made for Windows.

## What you need

| | |
|---|---|
| A PC | Windows 10/11, 8 GB RAM recommended, about **500 MB** of free disk space |
| Internet | For the install, and for JARVIS's conversation (Groq) |
| A free Groq account | Gives JARVIS its intelligence. Sign up at [console.groq.com](https://console.groq.com) |
| Optional: a webcam | Hand tracking in the Playground |
| Optional: a phone | On the same Wi-Fi, as a remote, camera and visor (iPhone: Safari; Android: Chrome) |

---

## 1. Install Node.js

ARC runs on Node.js, a free, open-source runtime used by millions of developers.

1. Go to **[nodejs.org](https://nodejs.org)** and download the **LTS** version (the left button). The installer is signed by the OpenJS Foundation.
2. Run it and keep the default options. You don't need the "tools for native modules" option.
3. Check it worked: open a terminal (press <kbd>Win</kbd>, type `terminal`, press <kbd>Enter</kbd>) and type:

   ```
   node -v
   ```

   You should see `v22.12.0` or newer.

## 2. Download ARC

**Option A (easiest):** on the [ARC GitHub page](https://github.com/SJbuilds04/ARC), click the green **Code** button, then **Download ZIP**. Right-click the ZIP, choose **Extract All…**, and put the folder somewhere permanent, for example `Documents\ARC`.

**Option B (if you use Git):**

```
git clone https://github.com/SJbuilds04/ARC.git
```

## 3. Open a terminal in the ARC folder

- **Windows 11:** open the ARC folder in File Explorer, right-click an empty spot and choose **Open in Terminal**.
- **Windows 10:** hold <kbd>Shift</kbd>, right-click an empty spot in the folder, and choose **Open PowerShell window here**.
- **macOS:** right-click the folder, then **Services → New Terminal at Folder**.

All the commands below are typed in this terminal.

> **"running scripts is disabled on this system"?** Windows PowerShell blocks `npm` on some new PCs. Type the same commands with `npm.cmd` instead of `npm` (for example `npm.cmd ci`), or use **Command Prompt** instead of PowerShell. There's no need to change any security setting.

## 4. Install ARC's parts

```
npm ci
```

This downloads the libraries ARC is built from (three.js, React and others) from the official npm registry. It uses the exact versions listed in `package-lock.json`, and npm checks every download against its recorded checksum. It takes 1–3 minutes and needs no administrator rights.

## 5. Download the models, textures and JARVIS's voice

```
npm run setup
```

This fetches the files ARC serves locally, so it works without any CDN afterwards:

| What | From | Size |
|---|---|---|
| Hand and face tracking models | Google MediaPipe (`storage.googleapis.com`) | ~12 MB |
| Planet and Earth textures | Solar System Scope, three.js on GitHub | ~15 MB |
| Country outlines | Natural Earth on GitHub | <1 MB |
| JARVIS's voice engine (Piper) | `github.com/rhasspy/piper` (official release) | ~20 MB |
| JARVIS's voice "Bryce" | `huggingface.co/rhasspy/piper-voices` | ~64 MB |

It's safe to run again. Files you already have are kept.

## 6. Connect JARVIS to Groq

1. Sign in at **[console.groq.com](https://console.groq.com)**, open **API Keys**, then **Create API Key**, and copy it (it starts with `gsk_`).
2. Run:

   ```
   npm run configure
   ```

3. Paste the key when asked. ARC checks it with Groq and saves it in a file called `.env` inside the ARC folder. That file stays on your PC and is never uploaded anywhere.

No key yet? Press <kbd>Enter</kbd> to skip. Local commands, the 3D Playground and the visor still work, and you can run `npm run configure` later.

## 7. Build and start

```
npm run build
npm start
```

Keep this terminal open while you use ARC. To stop ARC, press <kbd>Ctrl</kbd>+<kbd>C</kbd> in it.

## 8. Open ARC

1. In Edge or Chrome on the PC, go to **https://localhost:7777**.
2. The browser warns "Your connection isn't private". This is expected: ARC creates its own security certificate on your PC so your phone can use its camera and microphone over Wi-Fi, and browsers don't recognise home-made certificates. Click **Advanced**, then **Continue to localhost**. You only do this once.
3. The first time, Windows asks whether Node.js may use the network. Tick **Private networks** only and click **Allow**. This lets your phone reach ARC on your home Wi-Fi. If you'll never use a phone, you can cancel it.

## 9. Connect your phone (optional)

1. On the PC, open **DEVICES** in the left menu. A QR code appears.
2. Scan it with the phone's camera (same Wi-Fi as the PC) and accept the certificate warning the same way as above.
3. Tap **ENGAGE ARC**. Say **"JARVIS, open VS Code"** and confirm on screen.

## Check everything at any time

```
npm run doctor
```

It checks Node.js, the downloads, the voice, your Groq key, the network port and the phone address, and tells you exactly how to fix anything that's missing. It never changes anything.

## Every time after this

Open a terminal in the ARC folder and run `npm start`, then open https://localhost:7777.

## Updating ARC

1. Get the new version: `git pull` (Option B), or download the new ZIP and copy these from your old folder into the new one: `.env`, `.arc`, `models`, `voices` and `vendor`. They hold your settings, paired devices, 3D models and voices.
2. Then run:

   ```
   npm ci
   npm run setup
   npm run build
   ```

---

## Is it safe?

- **Nothing to trust blindly.** The only program you install is Node.js from its official site. Every ARC library comes from the npm registry at the exact version pinned in `package-lock.json`, checked by checksum. Every ARC file is readable source code in this folder.
- **No administrator rights.** ARC runs as your normal user. It doesn't install services, doesn't start with Windows, and doesn't change system settings.
- **What it touches.**
  - **The ARC folder.**
  - **`Documents\ARC`:** files you ask JARVIS to create.
  - **`Downloads\ARC`:** files you send from your phone.
  - **Search scope:** JARVIS only opens, searches and deletes files inside Desktop, Documents and Downloads. Deleting always needs a held confirmation on screen.
- **Who can connect.** The PC console only opens on the PC itself. A phone must scan the pairing QR code shown on the PC before it can connect, and you can unpair it any time under DEVICES.
- **What goes online.**
  - **Groq:** your commands go to Groq so JARVIS can answer, using your own key.
  - **Downloads:** the files in step 5 at setup time, the interface fonts from Google Fonts, and any voices you add yourself from Hugging Face.
  - **Nothing else:** no analytics, no tracking. JARVIS's voice runs offline on your PC.
- **Risky actions ask first.** Opening apps or websites asks for confirmation unless you turn that off. Closing apps, creating files and typing always ask. Deleting needs a held confirmation. ARC never runs shell commands.

## Uninstalling

1. Stop ARC (<kbd>Ctrl</kbd>+<kbd>C</kbd> in its terminal).
2. Delete the ARC folder. That removes everything: settings, paired devices, downloads and voices.
3. Optional:
   - delete `Documents\ARC` and `Downloads\ARC`;
   - remove **Node.js JavaScript Runtime** from *Windows Security → Firewall & network protection → Allow an app through firewall*;
   - uninstall Node.js from *Settings → Apps* if nothing else uses it.

## Something not working?

Run `npm run doctor` first. Then see **Troubleshooting** in the [README](README.md#troubleshooting).
