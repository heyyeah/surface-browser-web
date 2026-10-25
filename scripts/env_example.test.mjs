// Every environment variable the server reads is named in .env.example, so the
// public README's "lists every setting" stays true. Names only: defaults are
// not compared.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = new URL("../", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, APP), "utf8");
// Not settings: the runtime's own, and a test hook.
const NOT_SETTINGS = new Set(["NODE_ENV", "STT_BUILTIN_TEST_TRANSCRIPT"]);

function serverEnvNames() {
  const names = new Set();
  for (const dir of ["server", "shared"]) {
    for (const file of fs.readdirSync(new URL(dir, APP)).filter((name) => name.endsWith(".js"))) {
      for (const match of read(`${dir}/${file}`).matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\[\s*"([A-Z][A-Z0-9_]+)"\s*\])/g)) {
        names.add(match[1] || match[2]);
      }
    }
  }
  // Settings are read through process.env[key], so their keys count too.
  const source = read("server/index.js");
  const start = source.indexOf("const SETTING_DEFINITIONS");
  const block = source.slice(start, source.indexOf("\n};", start));
  for (const match of block.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)) {
    names.add(match[1]);
  }
  return names;
}

test(".env.example names every environment variable the server reads", () => {
  const listed = new Set([...read(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]));
  const names = serverEnvNames();
  assert.ok(names.size > 100, `scanner found ${names.size} names`);
  const missing = [...names].filter((name) => !listed.has(name) && !NOT_SETTINGS.has(name)).sort();
  assert.deepEqual(missing, [], `add to .env.example: ${missing.join(", ")}`);
});
