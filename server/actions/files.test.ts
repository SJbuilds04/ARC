import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { isBlocked, resolveInside, sanitizeFileName } from "./files";
import { siteUrl } from "./ActionExecutor";

test("paths outside the sandbox are rejected", () => {
  assert.equal(resolveInside("C:\\Windows\\System32\\drivers\\etc\\hosts"), null);
  assert.equal(resolveInside(path.join(os.homedir(), "Documents", "..", "..")), null);
  assert.equal(resolveInside("../../../Windows/win.ini"), null);
});

test("executables and scripts can never be opened", () => {
  for (const f of ["setup.exe", "run.BAT", "x.ps1", "a.lnk", "evil.vbs", "y.msi", "page.hta"]) assert.ok(isBlocked(f), f);
  for (const f of ["notes.txt", "photo.jpg", "report.pdf", "index.html"]) assert.ok(!isBlocked(f), f);
});

test("created file names are sanitized", () => {
  assert.equal(sanitizeFileName("../../evil.exe"), "evil.exe.txt");
  assert.equal(sanitizeFileName("shopping list"), "shopping list.txt");
  assert.equal(sanitizeFileName('bad<>:"|?*name.md'), "badname.md");
});

test("website targets must be http(s)", () => {
  assert.equal(siteUrl("youtube"), "https://www.youtube.com");
  assert.equal(siteUrl("example.com"), "https://example.com/");
  assert.equal(siteUrl("javascript:alert(1)"), null);
  assert.equal(siteUrl("file:///C:/Windows"), null);
  assert.equal(siteUrl("not a site"), null);
});
