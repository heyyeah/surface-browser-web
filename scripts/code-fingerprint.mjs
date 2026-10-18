// Prints one hash per source file of its code with comments and whitespace
// removed, so a comment-only change can be proven to have changed no code:
//
//   node scripts/code-fingerprint.mjs > before.txt
//   ...edit comments...
//   node scripts/code-fingerprint.mjs | diff before.txt -
//
// Any line in the diff is a file whose code changed.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = process.argv.length > 2 ? process.argv.slice(2) : ["src", "server", "shared"];

for (const dir of DIRS) {
  const names = fs.readdirSync(path.join(ROOT, dir)).filter((name) => /\.m?js$/.test(name)).sort();
  for (const name of names) {
    const source = fs.readFileSync(path.join(ROOT, dir, name), "utf8");
    const { code } = await transform(source, { minify: true, legalComments: "none", format: "esm" });
    console.log(`${createHash("sha256").update(code).digest("hex").slice(0, 16)}  ${dir}/${name}`);
  }
}
