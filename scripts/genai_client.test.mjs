import { test } from "node:test";
import assert from "node:assert/strict";
import { runGenAiJob } from "../src/genai-client.js";

test("GenAI poller drops completed payloads when a newer generation wins", async () => {
  let currentGeneration = 1;
  const progressStatuses = [];
  const polledJobs = [];

  const ok = await runGenAiJob({
    initialPayload: { jobId: "gj_old", status: "running", items: [], count: 1 },
    signal: undefined,
    generation: 1,
    isCurrentGeneration: (generation) => generation === currentGeneration,
    onProgress: (payload) => {
      progressStatuses.push(payload.status);
      return { done: false, ok: false };
    },
    sleepFn: async () => {},
    pollJob: async (jobId) => {
      polledJobs.push(jobId);
      currentGeneration = 2;
      return {
        jobId,
        status: "complete",
        ok: true,
        items: [{ imageUrl: "/stale.png" }]
      };
    }
  });

  assert.equal(ok, false);
  assert.deepEqual(polledJobs, ["gj_old"]);
  assert.deepEqual(progressStatuses, ["running"], "stale complete payload was never applied");
});

test("GenAI poller passes generation ownership back to api.js", async () => {
  const activeJobs = [];

  const ok = await runGenAiJob({
    initialPayload: { jobId: "gj_new", status: "complete", ok: true, items: [{ imageUrl: "/ok.png" }] },
    signal: undefined,
    generation: 7,
    isCurrentGeneration: (generation) => generation === 7,
    onActiveJob: (generation, jobId) => activeJobs.push({ generation, jobId }),
    onProgress: () => ({ done: true, ok: true })
  });

  assert.equal(ok, true);
  assert.deepEqual(activeJobs, [{ generation: 7, jobId: "gj_new" }]);
});

// A real provider failure (e.g. img2img HTTP 422) must not leave the client
// polling as though the job were still in flight. api.js's onProgress throws on
// an explicit `failed`/`ok:false` poll payload (see applyGenAiProgressPayload);
// this guards the contract at the poller layer: the throw must reject
// runGenAiJob's promise immediately, not get swallowed, retried, or looped on.
test("GenAI poller rejects (not loops) once a poll reports a failed job", async () => {
  let pollCount = 0;

  await assert.rejects(
    runGenAiJob({
      initialPayload: { jobId: "gj_fail", status: "running", items: [], count: 4 },
      signal: undefined,
      generation: 1,
      isCurrentGeneration: () => true,
      onProgress: (payload) => {
        if (payload.status === "failed") {
          // Mirrors applyGenAiProgressPayload's real failure branch.
          throw new Error(payload.error || "GenAI job failed");
        }
        return { done: false, ok: false };
      },
      sleepFn: async () => {},
      pollJob: async (jobId) => {
        pollCount += 1;
        return {
          jobId,
          status: "failed",
          ok: false,
          error: "Draw Things img2img returned HTTP 422: init_images height doesn't match 268 from the parameter 346"
        };
      }
    }),
    /HTTP 422/
  );

  assert.equal(pollCount, 1, "must not keep polling a job that already reported failure");
});

// A network error mid-poll (pollJob rejecting, e.g. fetch throwing or a non-OK
// response) must propagate the same way as an explicit `failed` status — both
// land in api.js's single catch block, which clears the async progress latch.
test("GenAI poller rejects when the poll request itself fails (network error)", async () => {
  let pollCount = 0;

  await assert.rejects(
    runGenAiJob({
      initialPayload: { jobId: "gj_net", status: "running", items: [] },
      signal: undefined,
      generation: 1,
      isCurrentGeneration: () => true,
      onProgress: () => ({ done: false, ok: false }),
      sleepFn: async () => {},
      pollJob: async () => {
        pollCount += 1;
        throw new Error("GenAI job poll failed (HTTP 502)");
      }
    }),
    /HTTP 502/
  );

  assert.equal(pollCount, 1);
});
