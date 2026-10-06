import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import selfsigned from "selfsigned";
import { DATA_DIR, lanAddresses } from "../config";

/**
 * Phones only grant camera + microphone to secure origins, so ARC serves HTTPS on
 * the LAN with a self-signed certificate covering localhost and every LAN IP.
 * The cert is regenerated when the machine's LAN addresses change.
 */
export async function loadOrCreateCertificate(): Promise<{ key: string; cert: string }> {
  const dir = path.join(DATA_DIR, "certs");
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  const metaFile = path.join(dir, "meta.json");
  const ips = ["127.0.0.1", ...lanAddresses()].sort();

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    const covered = ips.every((ip) => meta.ips.includes(ip));
    if (covered && meta.expires > Date.now() + 7 * 864e5) {
      return { key: fs.readFileSync(keyFile, "utf8"), cert: fs.readFileSync(certFile, "utf8") };
    }
  } catch {
    // no cert yet
  }

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 2);

  const pems = await selfsigned.generate([{ name: "commonName", value: "ARC Local" }], {
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 2, value: os.hostname() },
          ...ips.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({ ips, expires: notAfter.getTime() }));
  console.log(`[certs] generated self-signed certificate for ${ips.join(", ")}`);
  return { key: pems.private, cert: pems.cert };
}
