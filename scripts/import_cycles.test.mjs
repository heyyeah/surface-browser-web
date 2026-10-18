// No NEW import cycles between src/ modules.
//
// WHY THIS EXISTS. A cycle such as `ui -> vrpanel -> ui` passes `npm test` and
// `vite build` (rollup hoists a cycle's declarations into one scope), but the DEV
// SERVER hands the browser the real modules, which evaluate in the new order and
// can die at load with
//
//     Cannot access 'BookmarkKind' before initialization
//
// Nothing else in the suite notices an evaluation-order hazard: every other check
// reads source text or imports a leaf module. This does.
//
// THE ALLOWLIST IS A LIST OF DEBTS, NOT A LIST OF PERMISSIONS. The app tolerates
// those cycles; the point is that the set cannot GROW without someone deciding to
// grow it. If you are about to add an entry, the alternative is almost always to
// publish the value on `state` and let the other module read it, the way
// vrpanel.js hands the footer `state.vrPanelBottomOffset`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// Each is recorded as the pair that closes it, so a longer route through the
// same pair is not counted twice.
const KNOWN_CYCLE_EDGES = new Set([
  "api.js->transitions.js",
  "api.js->tunnel.js",
  "api.js->ui.js",
  "sphere.js->tunnel.js",
  "sphere.js->ui.js",
  "transitions.js->api.js",
  "transitions.js->sphere.js",
  "transitions.js->tunnel.js",
  "transitions.js->ui.js",
  "tunnel.js->ui.js",
  "ui.js->api.js"
]);

function importGraph() {
  const graph = new Map();
  for (const file of fs.readdirSync(SRC)) {
    if (!file.endsWith(".js")) {
      continue;
    }
    const source = fs.readFileSync(path.join(SRC, file), "utf8");
    const deps = new Set();
    // `[^;]*?` spans newlines on purpose: a multi-line import list would hide an
    // edge from a one-line match.
    for (const match of source.matchAll(/^\s*import[^;]*?from\s+"\.\/([\w.-]+)"/gm)) {
      deps.add(match[1]);
    }
    graph.set(file, deps);
  }
  return graph;
}

function findCycles(graph) {
  const cycles = new Set();
  const walk = (node, trail, seen) => {
    for (const dep of graph.get(node) || []) {
      const at = trail.indexOf(dep);
      if (at !== -1) {
        cycles.add(trail.slice(at).concat(dep).join(" -> "));
      } else if (!seen.has(dep)) {
        seen.add(dep);
        walk(dep, trail.concat(dep), seen);
      }
    }
  };
  for (const node of [...graph.keys()].sort()) {
    walk(node, [node], new Set([node]));
  }
  return [...cycles];
}

test("no import cycle outside the known set", () => {
  const cycles = findCycles(importGraph());
  const offenders = [];
  for (const cycle of cycles) {
    const nodes = cycle.split(" -> ");
    // A cycle is "known" only if EVERY edge in it is. One new edge is enough to
    // report it, which is what makes an old cycle unable to hide a new one.
    const edges = nodes.slice(0, -1).map((from, i) => `${from}->${nodes[i + 1]}`);
    const novel = edges.filter((edge) => !KNOWN_CYCLE_EDGES.has(edge));
    if (novel.length) {
      offenders.push(`${cycle}\n      new edge: ${novel.join(", ")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "New import cycle. The bundle will hide it and the dev server will not:\n    "
      + offenders.join("\n    ")
      + "\n  Publish the value on `state` instead — see state.vrPanelBottomOffset."
  );
});

// The allowlist must not outlive what it describes, or it quietly licenses
// cycles nobody meant to keep.
test("every known-cycle edge is still a real import", () => {
  const graph = importGraph();
  for (const edge of KNOWN_CYCLE_EDGES) {
    const [from, to] = edge.split("->");
    assert.ok(graph.has(from), `${from} no longer exists — drop "${edge}"`);
    assert.ok(
      graph.get(from).has(to),
      `${from} no longer imports ${to} — drop "${edge}" from KNOWN_CYCLE_EDGES`
    );
  }
});
