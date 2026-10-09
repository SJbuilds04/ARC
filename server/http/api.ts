import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DATA_DIR, config } from "../config";
import type { ModelLibrary } from "../library/ModelLibrary";
import { safeFileName } from "../library/ModelLibrary";
import type { PairingRegistry } from "../security/pairing";
import type { DeviceRole } from "../../shared/types";
import { allowedOrigin, isLoopback } from "./origin";

const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_THUMB = 2 * 1024 * 1024;

const MODEL_MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".obj": "text/plain; charset=utf-8",
  ".stl": "model/stl",
  ".fbx": "application/octet-stream",
};

export interface Received {
  name: string;
  size: number;
  kind: "model" | "file";
  path: string;
  modelId?: string;
}

interface ApiDeps {
  library: ModelLibrary;
  pairing: PairingRegistry;
  onReceived(info: Received, from: DeviceRole): void;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

/**
 * ARC's small HTTP API next to the WebSocket: file uploads from the phone (or drag-and-drop on
 * the PC), model files for the 3D engine, and model thumbnails. Returns false for other paths.
 */
export function createApi(deps: ApiDeps) {
  const tmpDir = path.join(DATA_DIR, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  /** Who is calling: the PC console (this machine) or a paired phone. Null = not allowed. */
  const caller = (req: IncomingMessage): DeviceRole | null => {
    if (!allowedOrigin(req.headers.origin)) return null;
    const local = isLoopback(req.socket.remoteAddress);
    const token = String(req.headers["x-arc-token"] ?? "");
    if (token && deps.pairing.authenticate(token)) return "PHONE";
    if (local) return req.headers["x-arc-role"] === "PHONE" ? "PHONE" : "PC";
    return null;
  };

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "https://arc.local").pathname);
    } catch {
      return false;
    }
    if (!pathname.startsWith("/api/")) return false;

    // Thumbnails: small preview images, readable by any ARC page on the LAN.
    const thumb = pathname.match(/^\/api\/thumbs\/([a-z0-9_-]+)\.png$/i);
    if (thumb && req.method === "GET") {
      const file = deps.library.thumbPath(thumb[1]);
      if (!file) {
        res.writeHead(404).end();
        return true;
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
      fs.createReadStream(file).pipe(res);
      return true;
    }

    // Model files: only the PC's 3D engine loads them (this machine, or a paired computer).
    const model = pathname.match(/^\/api\/models\/([^/]+)$/);
    if (model && req.method === "GET") {
      const token = new URL(req.url ?? "/", "https://arc.local").searchParams.get("token") ?? "";
      if (!isLoopback(req.socket.remoteAddress) && !(token && deps.pairing.authenticate(token))) {
        res.writeHead(403).end();
        return true;
      }
      const file = path.join(deps.library.dir, path.basename(model[1]));
      if (!file.startsWith(deps.library.dir) || !fs.existsSync(file)) {
        res.writeHead(404).end();
        return true;
      }
      res.writeHead(200, {
        "Content-Type": MODEL_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": fs.statSync(file).size,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      fs.createReadStream(file).pipe(res);
      return true;
    }

    // Thumbnail upload: the PC renders thumbnails after loading a model.
    const putThumb = pathname.match(/^\/api\/thumb\/([a-z0-9_-]+)$/i);
    if (putThumb && req.method === "POST") {
      if (caller(req) !== "PC") return json(res, 403, { ok: false }), true;
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_THUMB) req.destroy();
        else chunks.push(c);
      });
      req.on("end", () => {
        const png = Buffer.concat(chunks);
        if (png.subarray(1, 4).toString() !== "PNG") return json(res, 400, { ok: false });
        deps.library.setThumb(putThumb[1], png);
        json(res, 200, { ok: true });
      });
      return true;
    }

    // Upload: a 3D model goes to the library, anything else to the inbox folder.
    if (pathname === "/api/upload" && req.method === "POST") {
      const from = caller(req);
      if (!from) return json(res, 403, { ok: false, error: "Not paired" }), true;
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_UPLOAD) return json(res, 413, { ok: false, error: "File is larger than 200 MB" }), true;
      const rawName = decodeURIComponent(String(req.headers["x-file-name"] ?? "upload.bin"));
      const name = safeFileName(rawName);
      const tmp = path.join(tmpDir, `${randomUUID()}.part`);
      const out = fs.createWriteStream(tmp);
      let size = 0;
      let aborted = false;
      const fail = (status: number, error: string) => {
        aborted = true;
        out.destroy();
        fs.rm(tmp, { force: true }, () => undefined);
        if (!res.headersSent) json(res, status, { ok: false, error });
      };
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_UPLOAD) {
          fail(413, "File is larger than 200 MB");
          req.destroy();
        }
      });
      req.on("aborted", () => fail(400, "Upload interrupted"));
      req.pipe(out);
      out.on("finish", () => {
        if (aborted) return;
        try {
          let info: Received;
          if (deps.library.isModelFile(name)) {
            const m = deps.library.add(name, tmp);
            info = { name: m.name, size, kind: "model", path: path.join(deps.library.dir, m.file), modelId: m.id };
          } else {
            fs.mkdirSync(config.inboxDir, { recursive: true });
            let target = path.join(config.inboxDir, name);
            for (let i = 2; fs.existsSync(target); i++) target = path.join(config.inboxDir, `${path.basename(name, path.extname(name))} (${i})${path.extname(name)}`);
            fs.renameSync(tmp, target);
            info = { name: path.basename(target), size, kind: "file", path: target };
          }
          json(res, 200, { ok: true, ...info });
          deps.onReceived(info, from);
        } catch (err) {
          fail(500, (err as Error).message);
        }
      });
      out.on("error", (err) => fail(500, err.message));
      return true;
    }

    json(res, 404, { ok: false });
    return true;
  };
}
