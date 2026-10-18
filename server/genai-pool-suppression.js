// The mutable half of the curated pool: which baked members are hidden.
//
// Not stored in the pack: a release is immutable and re-pushed without
// --delete, so a list inside it would be overwritten (resurrecting deletions),
// and removing bytes would break the baker's resume. The pack stays
// byte-identical and this file, beside it, decides what is served.
//
// Members are identified by content address, not path or key, so the same bytes
// stay hidden under another name, key or release.
//
// A corrupt store is not an empty one: reading returns the parse error, and
// writing while it stands is refused, so one bad byte cannot discard every
// deletion.

import fs from "node:fs";
import path from "node:path";

export const SUPPRESSION_VERSION = 1;

// Beside the pack, never inside it: the pack directory is replaced wholesale by
// a re-push.
export function defaultSuppressionPath(packDir) {
  const dir = String(packDir || "").trim();
  return dir ? `${path.resolve(dir)}.suppressed.json` : "";
}

export function readSuppression(filePath) {
  const file = String(filePath || "").trim();
  const empty = { path: file, records: new Map(), ids: new Set(), error: "" };
  if (!file || !fs.existsSync(file)) {
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { ...empty, error: `${file}: ${err.message}` };
  }
  if (parsed?.version !== SUPPRESSION_VERSION) {
    return { ...empty, error: `${file} is suppression v${parsed?.version}; this server reads v${SUPPRESSION_VERSION}` };
  }
  const suppressed = parsed.suppressed;
  if (!suppressed || typeof suppressed !== "object") {
    return empty;
  }
  const records = new Map();
  for (const [id, record] of Object.entries(suppressed)) {
    if (!id) {
      continue;
    }
    records.set(id, {
      at: typeof record?.at === "string" ? record.at : "",
      file: typeof record?.file === "string" ? record.file : "",
      reason: typeof record?.reason === "string" ? record.reason : ""
    });
  }
  return { path: file, records, ids: new Set(records.keys()), error: "" };
}

export function writeSuppression(filePath, records) {
  const file = String(filePath || "").trim();
  if (!file) {
    throw new Error("no suppression store path");
  }
  const suppressed = {};
  for (const [id, record] of [...records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    suppressed[id] = { at: record?.at || "", file: record?.file || "", reason: record?.reason || "" };
  }
  const payload = {
    version: SUPPRESSION_VERSION,
    updatedAt: new Date().toISOString(),
    suppressed
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
