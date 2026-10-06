import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Serves the built client (single page). Every route falls back to index.html. */
export function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  const root = config.clientDist;
  const index = path.join(root, "index.html");
  if (!fs.existsSync(index)) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ARC client is not built yet. Run: npm run build");
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "https://arc.local").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Unknown asset paths 404; everything else is the SPA.
    if (path.extname(pathname)) {
      res.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    file = index;
  }

  const ext = path.extname(file).toLowerCase();
  const immutable = pathname.startsWith("/assets/");
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": fs.statSync(file).size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}
