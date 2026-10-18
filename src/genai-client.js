const GENAI_JOB_POLL_MS = 500;

function createGenAiClientId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `genai_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollGenAiJob(jobId, signal, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`/api/genai/job/${encodeURIComponent(jobId)}`, { signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `GenAI job poll failed (HTTP ${response.status})`);
  }
  return payload;
}

async function runGenAiJob({
  initialPayload,
  signal,
  generation,
  isCurrentGeneration,
  onActiveJob,
  onProgress,
  pollJob = pollGenAiJob,
  sleepFn = sleep,
  pollMs = GENAI_JOB_POLL_MS
}) {
  const jobId = initialPayload?.jobId;
  if (!jobId) {
    throw new Error("GenAI job payload missing jobId");
  }

  onActiveJob?.(generation, jobId);
  let nextPayload = initialPayload;

  while (true) {
    if (!isCurrentGeneration(generation)) {
      return false;
    }

    const progress = onProgress(nextPayload);
    if (progress.done) {
      return progress.ok;
    }

    await sleepFn(pollMs);
    if (!isCurrentGeneration(generation)) {
      return false;
    }

    nextPayload = await pollJob(jobId, signal);
  }
}

export {
  GENAI_JOB_POLL_MS,
  createGenAiClientId,
  pollGenAiJob,
  runGenAiJob,
  sleep
};
