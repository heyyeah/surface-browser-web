import { AsyncResource } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { clampNumber, firstString, parseNonNegativeInteger, parsePositiveInteger } from "./env.js";
import { GenAiSourceTooLargeError, ProviderConfigError, RequestPolicyError, sendPolicyError } from "./errors.js";
import { providerBillingContext } from "./net-policy.js";
import { genAiQueryLogDetails, logApiQuery } from "./query-log.js";
import {
  DEFAULT_LIMIT,
  getBooleanSetting,
  getGenAiProvider,
  getGenAiVaryModifierMode,
  getGenAiVaryModifierPayload,
  getGenAiVaryModifierStyle,
  getGenAiVarySeedMode,
  getIntegerSetting,
  getNumberSetting,
  getOptionalIntegerSetting,
  getOptionalNumberSetting,
  getStringSetting,
  isMuseumSafeTextBlocked,
  withMuseumSafeNegativePrompt
} from "./settings.js";
import { normalizeSearchQuery } from "./search.js";
import { genAiImageStore, getGenAiImageCacheTtlMs, getStoredGenAiImage, storeGenAiImageSource } from "./genai-store.js";
import {
  createGenAiSeed,
  generateImagesViaCustomEndpoint,
  generateImagesViaFal,
  generateImagesViaSdApi,
  getVariationStrengthRamp,
  varyImagesViaFal,
  varyImagesViaSdApi
} from "./genai-providers.js";
import {
  GENAI_POOL_GROW_DAILY_CAP,
  POOL_GROW_SPEND_KEY,
  completeGenAiBatchFromPool,
  genAiPoolLogDetails,
  growGenAiPool,
  planGenAiPoolBatch,
  poolOnlyGenAiBatch,
  storePooledGenAiItem
} from "./genai-pool-runtime.js";

const GENAI_QUEUE_MAX_PENDING = parseNonNegativeInteger(process.env.GENAI_QUEUE_MAX_PENDING, 2);
// Text length ceilings (the search one is in search.js). Both truncate rather
// than reject: a clipped prompt still produces images, where a 400 mid-session
// does not.
const GENAI_PROMPT_MAX_CHARS = parsePositiveInteger(process.env.GENAI_PROMPT_MAX_CHARS, 1000);
// Bounds genAiProgressJobs: TTL alone is not a bound, and polling extends its
// own TTL.
const GENAI_PROGRESS_JOBS_MAX = parseNonNegativeInteger(process.env.GENAI_PROGRESS_JOBS_MAX, 500);

export const genAiResultCache = new Map();
export const genAiProgressJobs = new Map();
const genAiQueue = {
  active: new Set(),
  pending: []
};

// index.js state, handed over by initGenAiJobs() once it exists.
let killSwitch;
let spendGuard;
let getSpendClientKey;
let genAiPromptCache;

export function initGenAiJobs(deps) {
  ({ killSwitch, spendGuard, getSpendClientKey, genAiPromptCache } = deps);
}

export function handleGenAiJob(req, res) {
  const job = getGenAiProgressJob(req.params.id);
  if (!job) {
    res.status(410).json({ error: "GenAI job expired or not found" });
    return;
  }
  res.json(buildGenAiProgressJobResponse(job));
}

export function handleCancelGenAiJob(req, res) {
  const job = getGenAiProgressJob(req.params.id);
  if (!job) {
    res.status(410).json({ error: "GenAI job expired or not found" });
    return;
  }
  cancelGenAiProgressJob(job);
  res.json(buildGenAiProgressJobResponse(job));
}

export async function handleGenAi(req, res) {
  const routeStartedAt = Date.now();
  if (killSwitch.isEngaged()) {
    res.status(503).json({ error: "disabled" });
    return;
  }
  const wantsAsync = req.body?.async === true || req.query.async === "1";
  const clientKey = getGenAiClientKey(req);
  if (wantsAsync) {
    cancelActiveGenAiProgressJobs(clientKey);
  }
  const requestedPrompt = normalizeGenAiPrompt(req.body?.prompt);
  const requestedCacheKey = normalizeGenAiCacheKey(req.body?.cacheKey);
  const replay = getCachedGenAiResult(requestedCacheKey);
  if (
    replay
    && (!requestedPrompt || replay.prompt === requestedPrompt)
    && !isMuseumSafeTextBlocked(replay.prompt)
  ) {
    logApiQuery("genai.cached", {
      ...genAiQueryLogDetails({
        provider: replay.provider,
        prompt: replay.prompt,
        count: replay.items.length
      }),
      async: wantsAsync,
      durationMs: Date.now() - routeStartedAt
    });
    if (wantsAsync) {
      const job = createCompletedGenAiProgressJob({
        prompt: replay.prompt,
        selected: replay,
        cacheKey: requestedCacheKey,
        cached: true
      });
      res.status(202).json(buildGenAiProgressJobResponse(job));
      return;
    }
    res.json(buildGenAiResponse({
      prompt: replay.prompt,
      count: replay.items.length,
      selected: replay,
      cacheKey: requestedCacheKey,
      cached: true
    }));
    return;
  }

  const source = normalizeGenAiSource(req.body?.source);
  const sourceRecord = source?.id ? getStoredGenAiImage(source.id) : null;
  if (source?.id && !sourceRecord) {
    res.status(410).json({ error: "Generated image source expired or not found" });
    return;
  }

  const prompt = requestedPrompt || sourceRecord?.genai?.prompt || "";
  if (!prompt) {
    res.status(400).json({ error: "Missing GenAI prompt" });
    return;
  }
  if (isMuseumSafeTextBlocked(prompt)) {
    res.status(400).json({ error: "This request is not available in museum-safe mode" });
    return;
  }

  const negativePrompt = normalizeGenAiPrompt(req.body?.negativePrompt);
  let count = clampNumber(req.body?.count, 1, DEFAULT_LIMIT, getIntegerSetting("GENAI_COUNT"));
  const provider = getGenAiProvider();
  const requestLogDetails = genAiQueryLogDetails({
    provider,
    prompt,
    count,
    sourceRecord
  });
  let seed = null;
  try {
    seed = normalizeGenAiSeed(req.body?.seed);
  } catch (err) {
    sendPolicyError(res, err, "Invalid GenAI seed");
    return;
  }
  const seededCacheKey = seed === null
    ? ""
    : buildSeededGenAiCacheKey({
      provider: getGenAiProvider(),
      prompt,
      negativePrompt,
      count,
      sourceRecord,
      seed
    });
  const seededReplay = getCachedGenAiResult(seededCacheKey);
  if (seededReplay) {
    logApiQuery("genai.cached", {
      ...requestLogDetails,
      async: wantsAsync,
      durationMs: Date.now() - routeStartedAt
    });
    if (wantsAsync) {
      const job = createCompletedGenAiProgressJob({
        prompt,
        selected: seededReplay,
        cacheKey: seededCacheKey,
        cached: true
      });
      res.status(202).json(buildGenAiProgressJobResponse(job));
      return;
    }
    res.json(buildGenAiResponse({
      prompt,
      count,
      selected: seededReplay,
      cacheKey: seededCacheKey,
      cached: true
    }));
    return;
  }

  // Draw before you pay. The pool is consulted after the museum-safe check and
  // before the reservation, so a warm batch reserves (and can be refused for) only
  // the images it will buy. Both cache replays above return earlier and stay free.
  // The batch seed is minted here because the planner must choose each slot's
  // modifier with the seed the generator will then use.
  const batchSeed = seed ?? createGenAiSeed();
  let poolBatch = planGenAiPoolBatch({ prompt, negativePrompt, count, sourceRecord, batchSeed });
  let billableCount = poolBatch ? poolBatch.freshCount : count;
  Object.assign(requestLogDetails, genAiPoolLogDetails(poolBatch));

  const promptCacheKey = buildGenAiPromptCacheKey({ prompt, negativePrompt, count, sourceRecord, seed, poolBatch });
  const promptReplay = await restoreGenAiPromptBatch(promptCacheKey, prompt);
  if (promptReplay) {
    const cacheKey = storeGenAiResultCache(createGenAiResultCacheKey(), { prompt, selected: promptReplay });
    logApiQuery("genai.cached", {
      ...requestLogDetails,
      async: wantsAsync,
      promptCache: true,
      durationMs: Date.now() - routeStartedAt
    });
    if (wantsAsync) {
      const job = createCompletedGenAiProgressJob({ prompt, selected: promptReplay, cacheKey, cached: true });
      res.status(202).json(buildGenAiProgressJobResponse(job));
      return;
    }
    res.json(buildGenAiResponse({ prompt, count, selected: promptReplay, cacheKey, cached: true }));
    return;
  }

  // Reserve the whole billable batch before the provider is touched (one call can
  // be 15 images); released below for whatever is not delivered.
  const growsPool = Boolean(poolBatch?.growing) && GENAI_POOL_GROW_DAILY_CAP > 0;
  let spendReservation = spendGuard.reserve("genai", growsPool
    ? { key: POOL_GROW_SPEND_KEY, amount: billableCount, ipLimit: GENAI_POOL_GROW_DAILY_CAP }
    : { key: getSpendClientKey(req), amount: billableCount });
  if (!spendReservation.ok && poolBatch?.pooledCount > 0) {
    // Over budget, but the pool already holds images for this: show those.
    logApiQuery("genai.pool_only", { ...requestLogDetails, scope: spendReservation.reason });
    poolBatch = poolOnlyGenAiBatch(poolBatch);
    count = poolBatch.slots.length;
    billableCount = 0;
    Object.assign(requestLogDetails, { count }, genAiPoolLogDetails(poolBatch));
    spendReservation = spendGuard.reserve("genai", { amount: 0 });
  }
  if (!spendReservation.ok) {
    logApiQuery("genai.budget", {
      ...requestLogDetails,
      async: wantsAsync,
      scope: spendReservation.reason,
      durationMs: Date.now() - routeStartedAt
    });
    res.status(429).json({ error: "budget", scope: spendReservation.reason });
    return;
  }

  const job = createGenAiProgressJob({
    clientKey,
    prompt,
    count,
    provider,
    initialItems: sourceRecord ? buildGenAiLineageItems(sourceRecord) : [],
    sync: !wantsAsync
  });
  const jobParams = {
    prompt,
    negativePrompt,
    count,
    sourceRecord,
    seed,
    seededCacheKey,
    promptCacheKey,
    spendReservation,
    batchSeed,
    poolBatch,
    billableCount
  };
  if (wantsAsync) {
    logApiQuery("genai.accepted", {
      ...requestLogDetails,
      async: true,
      jobId: job.id,
      durationMs: Date.now() - routeStartedAt
    });
    startGenAiProgressJob(job, jobParams);
    res.status(202).json(buildGenAiProgressJobResponse(job));
    return;
  }

  // The sync route runs the same job, so spend release, caching, pool fallback
  // and logging are settled in one place (startGenAiProgressJob).
  const err = await startGenAiProgressJob(job, jobParams);
  if (job.status === "complete") {
    res.json(buildGenAiResponse({ prompt, selected: job, cacheKey: job.cacheKey, cached: false }));
    return;
  }
  if (sendPolicyError(res, err)) {
    return;
  }
  const status = err instanceof ProviderConfigError
    ? 501
    : err instanceof GenAiBusyError
      ? 503
      : err instanceof GenAiAbortError
        ? 409
        : err instanceof GenAiSourceTooLargeError
          ? 413
        : 502;
  res.status(status).json({ error: `GenAI failed: ${err.message}` });
}

class GenAiBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GenAiBusyError";
  }
}

class GenAiAbortError extends Error {
  constructor(message) {
    super(message);
    this.name = "GenAiAbortError";
  }
}

function getGenAiClientKey(req) {
  return String(req.get("x-genai-client-id") || req.ip || req.socket.remoteAddress || "unknown");
}

function enqueueGenAiJob(clientKey, run) {
  abortPendingGenAiJobs(clientKey);

  // A job queued behind an active one runs later, off that other job's
  // continuation (see startNextGenAiJob), so plain AsyncLocalStorage propagation
  // would hand readJsonResponse() the wrong request's providerBilling. Bind so
  // `run` re-enters the context live when the job was enqueued.
  const boundRun = AsyncResource.bind(run);

  return new Promise((resolve, reject) => {
    const job = {
      clientKey,
      run: boundRun,
      resolve,
      reject,
      aborted: false
    };

    if (!isGenAiQueueFull()) {
      startGenAiJob(job);
      return;
    }

    if (genAiQueue.pending.length >= GENAI_QUEUE_MAX_PENDING) {
      reject(new GenAiBusyError("Generator busy"));
      return;
    }

    genAiQueue.pending.push(job);
  });
}

// A batch the pool fills entirely buys nothing, so it never waits behind a
// paid one.
function enqueueGenAiBatch(clientKey, poolBatch, run) {
  if (poolBatch?.freshCount === 0) {
    abortPendingGenAiJobs(clientKey);
    return Promise.resolve().then(run);
  }
  return enqueueGenAiJob(clientKey, run);
}

function abortPendingGenAiJobs(clientKey) {
  if (!clientKey || genAiQueue.pending.length === 0) {
    return;
  }

  const pending = [];
  for (const job of genAiQueue.pending) {
    if (job.clientKey === clientKey) {
      job.aborted = true;
      job.reject(new GenAiAbortError("GenAI request superseded"));
    } else {
      pending.push(job);
    }
  }
  genAiQueue.pending = pending;
}

// fal runs requests in parallel and bills per image, so only the daily caps
// bound it; a local GPU (Draw Things, A1111) or an unknown endpoint gets one.
function getGenAiParallelJobs() {
  const fallback = getGenAiProvider() === "fal" ? 3 : 1;
  return parsePositiveInteger(process.env.GENAI_PARALLEL_JOBS, fallback);
}

export function isGenAiQueueFull() {
  return genAiQueue.active.size >= getGenAiParallelJobs();
}

function startGenAiJob(job) {
  genAiQueue.active.add(job);
  Promise.resolve()
    .then(() => {
      if (job.aborted) {
        throw new GenAiAbortError("GenAI request superseded");
      }
      return job.run();
    })
    .then(job.resolve, job.reject)
    .finally(() => {
      genAiQueue.active.delete(job);
      startNextGenAiJob();
    });
}

function startNextGenAiJob() {
  while (!isGenAiQueueFull() && genAiQueue.pending.length > 0) {
    const next = genAiQueue.pending.shift();
    if (next.aborted) {
      continue;
    }
    startGenAiJob(next);
    break;
  }
}

function createGenAiProgressJob({
  clientKey = "unknown",
  prompt,
  count,
  provider,
  expected = null,
  initialItems = [],
  sync = false
}) {
  pruneGenAiProgressJobs();
  const now = Date.now();
  const job = {
    id: `gj_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    clientKey,
    prompt,
    count,
    expected: expected ?? (initialItems.length + count),
    provider,
    warnings: [],
    items: cloneGenAiItems(initialItems),
    status: "queued",
    cacheKey: null,
    cached: false,
    error: null,
    cancelled: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + getGenAiResultCacheTtlMs(),
    sync
  };
  // A sync request's job is never listed: nothing polls it, and a later prompt
  // from the same client must not cancel it mid-flight.
  if (!sync) {
    genAiProgressJobs.set(job.id, job);
    enforceGenAiProgressJobsCap();
  }
  return job;
}

// TTL pruning alone is not a bound: every poll extends a job's own TTL, so a
// polling client keeps entries alive and could inflate the map for free. Past
// GENAI_PROGRESS_JOBS_MAX, evict oldest-first in order of what is cheapest to
// lose: cached replays (free to make, so the way to flood the map), then other
// finished jobs, and a live one only if nothing else is left. Oldest-first alone
// let a stream of free replays expire other visitors' running jobs. An evicted
// poll 410s, which the client treats as "expired".
const GENAI_JOB_EVICTION_TIERS = [
  (job) => job.cached && job.status === "complete",
  (job) => job.status === "complete" || job.status === "failed" || job.status === "cancelled",
  () => true
];

function enforceGenAiProgressJobsCap() {
  if (!GENAI_PROGRESS_JOBS_MAX) {
    return;
  }
  for (const evictable of GENAI_JOB_EVICTION_TIERS) {
    for (const [id, job] of genAiProgressJobs) {
      if (genAiProgressJobs.size <= GENAI_PROGRESS_JOBS_MAX) {
        return;
      }
      if (evictable(job)) {
        genAiProgressJobs.delete(id);
      }
    }
  }
}

function createCompletedGenAiProgressJob({ prompt, selected, cacheKey, cached }) {
  const job = createGenAiProgressJob({
    prompt,
    count: selected.items?.length || 0,
    provider: selected.provider,
    expected: selected.items?.length || 0,
    initialItems: selected.items || []
  });
  job.status = "complete";
  job.warnings = [...(selected.warnings || [])];
  job.cacheKey = cacheKey || null;
  job.cached = Boolean(cached);
  job.updatedAt = Date.now();
  return job;
}

function getGenAiProgressJob(id) {
  pruneGenAiProgressJobs();
  const job = genAiProgressJobs.get(String(id || ""));
  if (!job) {
    return null;
  }
  job.expiresAt = Date.now() + getGenAiResultCacheTtlMs();
  return job;
}

function pruneGenAiProgressJobs(now = Date.now()) {
  for (const [jobId, job] of genAiProgressJobs) {
    if (now >= job.expiresAt) {
      genAiProgressJobs.delete(jobId);
    }
  }
}

function touchGenAiProgressJob(job) {
  const now = Date.now();
  job.updatedAt = now;
  job.expiresAt = now + getGenAiResultCacheTtlMs();
}

function appendGenAiProgressItems(job, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const knownIds = new Set(job.items.map((item) => item.genai?.id).filter(Boolean));
  for (const item of cloneGenAiItems(items)) {
    const id = item.genai?.id;
    if (id && knownIds.has(id)) {
      continue;
    }
    if (id) {
      knownIds.add(id);
    }
    job.items.push(item);
  }
  touchGenAiProgressJob(job);
}

function cancelGenAiProgressJob(job) {
  if (job.status === "complete" || job.status === "failed" || job.status === "cancelled") {
    return;
  }
  job.cancelled = true;
  job.status = "cancelled";
  job.error = "GenAI job cancelled";
  touchGenAiProgressJob(job);
  logApiQuery("genai.cancelled", {
    ...genAiQueryLogDetails({
      provider: job.provider,
      prompt: job.prompt,
      count: job.count
    }),
    async: true,
    jobId: job.id,
    durationMs: Date.now() - job.createdAt
  });
}

function cancelActiveGenAiProgressJobs(clientKey) {
  if (!clientKey) {
    return;
  }
  for (const job of genAiProgressJobs.values()) {
    if (job.clientKey === clientKey) {
      cancelGenAiProgressJob(job);
    }
  }
}

// Both /api/genai paths settle here. Resolves to the error the run failed with,
// or null; job.status says whether the batch still completed (from the pool).
function startGenAiProgressJob(job, params) {
  // What this job has generated, which is not what it has delivered: a pooled slot
  // arrives as an item but was never bought, so counting job.items would charge
  // for the pack.
  const progress = { slots: 0, generated: 0, billedEmpty: 0 };
  // Lineage items are seeded before generation starts, so an empty batch is this
  // baseline, not zero.
  const initialItemCount = job.items.length;
  // Same billed-failure trap as the search route (see
  // providerBillingContext), except this job generates one image per provider
  // round-trip (count:1), so at most one image can be billed-but-undelivered: the
  // call in flight. onItems resets `billed` once an image is appended to
  // job.items, since from then the billed work is the delivered count; only a
  // failure on the next call should suppress a refund.
  const providerBilling = { billed: false };
  const releaseUndelivered = (extraBilled = 0) => {
    spendGuard.release(
      params.spendReservation,
      Math.max(0, params.billableCount - progress.generated - progress.billedEmpty - extraBilled)
    );
  };
  // A job that will wait in the queue shows its pooled images now rather than an
  // empty tunnel. They go first and stay first: the client reads items by index.
  if (params.poolBatch?.freshCount > 0 && isGenAiQueueFull()) {
    for (const slot of params.poolBatch.slots) {
      if (slot.pooled) {
        slot.preDelivered = storePooledGenAiItem(slot, { prompt: params.prompt, sourceRecord: params.sourceRecord });
        appendGenAiProgressItems(job, [slot.preDelivered]);
      }
    }
  }
  return providerBillingContext.run(providerBilling, () => enqueueGenAiBatch(job.clientKey, params.poolBatch, async () => {
    if (job.cancelled) {
      throw new GenAiAbortError("GenAI job cancelled");
    }
    const startedAt = Date.now();
    job.status = "running";
    touchGenAiProgressJob(job);
    logApiQuery("genai.started", {
      ...genAiQueryLogDetails({
        provider: job.provider,
        prompt: params.prompt,
        count: params.count,
        sourceRecord: params.sourceRecord
      }),
      async: !job.sync,
      jobId: job.id
    });
    const selected = await generateImagesProgressive({
      ...params,
      poolSlots: params.poolBatch?.slots || null,
      shouldCancel: () => job.cancelled,
      onItems: (items, index) => {
        appendGenAiProgressItems(job, items);
        progress.slots = index + 1;
        if (!params.poolBatch?.slots[index]?.pooled) {
          progress.generated += items.length;
          // A 2xx that yields no image (safety-filtered, unstorable) was still
          // billed. Kept apart from `generated`, which the pool fallback reads as
          // images actually delivered.
          if (items.length === 0 && providerBilling.billed) {
            progress.billedEmpty += 1;
          }
        }
        providerBilling.billed = false;
      }
    });
    if (job.cancelled) {
      throw new GenAiAbortError("GenAI job cancelled");
    }
    job.provider = selected.provider;
    job.warnings = [...(selected.warnings || [])];
    job.items = cloneGenAiItems(selected.items);
    job.cacheKey = storeGenAiResultCache(params.seededCacheKey || createGenAiResultCacheKey(), {
      prompt: params.prompt,
      selected
    });
    rememberGenAiPromptBatch(params.promptCacheKey, selected, params.count);
    job.cached = false;
    job.status = "complete";
    releaseUndelivered();
    touchGenAiProgressJob(job);
    logApiQuery("genai.complete", {
      ...genAiQueryLogDetails({
        provider: selected.provider,
        prompt: params.prompt,
        count: params.count,
        sourceRecord: params.sourceRecord
      }),
      ...genAiPoolLogDetails(params.poolBatch),
      async: !job.sync,
      jobId: job.id,
      items: selected.items.length,
      cached: false,
      durationMs: Date.now() - startedAt,
      totalDurationMs: Date.now() - job.createdAt
    });
    return selected;
  })).then(() => null, (err) => {
    if (job.cancelled || err instanceof GenAiAbortError) {
      job.cancelled = true;
      job.status = "cancelled";
    } else {
      job.status = "failed";
    }
    // Fill the slots the provider never delivered from the pool, so an outage ends
    // as a fully-cached sphere rather than a failed job. Not for a cancel: the
    // client cancels on every new prompt.
    const poolFilled = params.poolBatch && job.status === "failed"
      ? completeGenAiBatchFromPool({
        poolBatch: params.poolBatch,
        fromIndex: progress.slots,
        delivered: progress.generated,
        prompt: params.prompt,
        sourceRecord: params.sourceRecord
      })
      : [];
    if (poolFilled.length) {
      appendGenAiProgressItems(job, poolFilled);
    }
    // A batch with images in it is a batch, however it was assembled.
    const recovered = Boolean(params.poolBatch) && job.status === "failed" && job.items.length > initialItemCount;
    if (recovered) {
      job.status = "complete";
      job.expected = job.items.length;
      job.cacheKey = storeGenAiResultCache(params.seededCacheKey || createGenAiResultCacheKey(), {
        prompt: params.prompt,
        selected: { provider: job.provider, warnings: [], items: job.items }
      });
      job.cached = false;
    }
    // Give back only the images that never arrived and were never billed. A cancel
    // at image 3 of 4 still spent 3, so crediting the full batch would make the cap
    // avoidable. If the in-flight call already got a 2xx (providerBilling.billed),
    // that image is billed too even though it never reached job.items.
    //
    // An abort counts as billed, as on the search route: the outcome is unknown, and
    // the body read has its own deadline, so an AbortError can fire after the
    // provider returned 2xx. A user cancel raises GenAiAbortError instead, not
    // AbortError, and must not be charged.
    const abortedMidFlight = err?.name === "AbortError";
    releaseUndelivered(providerBilling.billed || abortedMidFlight ? 1 : 0);
    const message = err instanceof Error ? err.message : String(err);
    // A pool-filled job completed; `error` would surface an outage the visitor
    // was deliberately shielded from. The query log still carries it.
    job.error = recovered ? null : message;
    touchGenAiProgressJob(job);
    logApiQuery(recovered ? "genai.pooled" : "genai.failed", {
      ...genAiQueryLogDetails({
        provider: job.provider,
        prompt: params.prompt,
        count: params.count,
        sourceRecord: params.sourceRecord
      }),
      ...genAiPoolLogDetails(params.poolBatch),
      async: !job.sync,
      jobId: job.id,
      status: job.status,
      filled: poolFilled.length,
      durationMs: Date.now() - job.createdAt,
      error: message
    });
    return err;
  });
}

function buildGenAiProgressJobResponse(job) {
  const received = job.items.length;
  const expected = Math.max(Number(job.expected || 0), received);
  const done = job.status === "complete" && received >= expected;
  return {
    ok: job.status !== "failed" && job.status !== "cancelled",
    jobId: job.id,
    status: job.status,
    count: job.count,
    received,
    expected,
    done,
    sourceUrl: `genai:${job.prompt}`,
    title: `GenAI: ${job.prompt}`,
    items: cloneGenAiItems(job.items),
    error: job.error,
    meta: {
      method: `genai_${job.provider}`,
      warnings: [...(job.warnings || [])],
      genaiCacheKey: job.cacheKey || null,
      cached: Boolean(job.cached),
      complete: done
    }
  };
}

function buildGenAiResponse({ prompt, selected, cacheKey, cached }) {
  return {
    sourceUrl: `genai:${prompt}`,
    title: `GenAI: ${prompt}`,
    items: cloneGenAiItems(selected.items),
    meta: {
      method: `genai_${selected.provider}`,
      warnings: [...(selected.warnings || [])],
      genaiCacheKey: cacheKey || null,
      cached: Boolean(cached)
    }
  };
}

function normalizeGenAiCacheKey(raw) {
  const value = String(raw || "").trim();
  if (!/^(gr|gd)_[a-zA-Z0-9_-]{8,160}$/.test(value)) {
    return "";
  }
  return value;
}

function createGenAiResultCacheKey() {
  return `gr_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function buildSeededGenAiCacheKey({ provider, prompt, negativePrompt, count, sourceRecord, seed }) {
  const payload = {
    provider,
    prompt,
    negativePrompt,
    count,
    seed,
    sourceId: sourceRecord?.id || null,
    width: sourceRecord?.width || getIntegerSetting("GENAI_WIDTH"),
    height: sourceRecord?.height || getIntegerSetting("GENAI_HEIGHT"),
    steps: getOptionalIntegerSetting("GENAI_STEPS"),
    cfgScale: getOptionalNumberSetting("GENAI_CFG_SCALE"),
    drawThingsGuidanceEmbed: provider === "drawthings" ? getOptionalNumberSetting("GENAI_DRAWTHINGS_GUIDANCE_EMBED") : null,
    museumSafe: getBooleanSetting("GENAI_MUSEUM_SAFE"),
    variationStrengthMin: sourceRecord ? getNumberSetting("GENAI_VARIATION_STRENGTH_MIN") : null,
    variationStrengthMax: sourceRecord ? getNumberSetting("GENAI_VARIATION_STRENGTH_MAX") : null,
    varySeedMode: sourceRecord ? getGenAiVarySeedMode() : null,
    varyModifiers: sourceRecord ? getStringSetting("GENAI_VARY_MODIFIERS") : null,
    varyModifierTexts: sourceRecord ? getStringSetting("GENAI_VARY_MODIFIER_TEXTS") : null,
    varyModifierMode: sourceRecord ? getGenAiVaryModifierMode() : null,
    varyModifierStyle: sourceRecord ? getGenAiVaryModifierStyle() : null,
    varyModifierPayload: sourceRecord ? getGenAiVaryModifierPayload() : null
  };
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("base64url").slice(0, 32);
  return `gd_${digest}`;
}

// The day-long prompt cache covers plain text prompts only. A variation is
// meant to differ each time, a seeded request has its own replay above, and a
// prompt the pool serves or is still growing is better left to the pool, which
// mixes its draw and keeps buying one or two fresh images.
function buildGenAiPromptCacheKey({ prompt, negativePrompt, count, sourceRecord, seed, poolBatch }) {
  if (!genAiPromptCache.enabled || sourceRecord || seed !== null) {
    return "";
  }
  if (poolBatch?.slots.some((slot) => slot.pooled || slot.grow)) {
    return "";
  }
  return buildSeededGenAiCacheKey({
    provider: getGenAiProvider(),
    prompt,
    negativePrompt,
    count,
    sourceRecord: null,
    seed: "prompt-cache"
  });
}

async function restoreGenAiPromptBatch(key, prompt) {
  const batch = key ? await genAiPromptCache.get(key) : null;
  if (!batch) {
    return null;
  }
  return {
    provider: batch.provider || getGenAiProvider(),
    warnings: [],
    items: batch.images.map((image) => storeGenAiImageSource({
      source: { buffer: image.buffer, contentType: image.contentType },
      context: {
        prompt,
        seed: image.seed ?? null,
        strength: null,
        parentId: null,
        provider: batch.provider || getGenAiProvider(),
        width: image.width,
        height: image.height,
        origin: "prompt-cache",
        saveToDisk: false
      }
    }))
  };
}

// Only a full batch the provider did not flag is worth serving to the next
// visitor; a short or flagged one is generated again.
function rememberGenAiPromptBatch(key, selected, count) {
  if (!key || selected.items.length !== count) {
    return;
  }
  const records = selected.items.map((item) => genAiImageStore.get(item.genai?.id));
  if (records.some((record) => !record || record.providerFlagged || record.origin)) {
    return;
  }
  void genAiPromptCache.set(key, {
    provider: selected.provider,
    images: records.map((record) => ({
      buffer: record.buffer,
      contentType: record.contentType,
      seed: record.genai?.seed ?? null,
      width: record.width,
      height: record.height
    }))
  });
}

function getCachedGenAiResult(cacheKey) {
  if (!cacheKey) {
    return null;
  }

  const now = Date.now();
  pruneGenAiResultCache(now);
  const entry = genAiResultCache.get(cacheKey);
  if (!entry || now >= entry.expiresAt || !canServeCachedGenAiItems(entry.items)) {
    genAiResultCache.delete(cacheKey);
    return null;
  }

  genAiResultCache.delete(cacheKey);
  genAiResultCache.set(cacheKey, entry);
  return {
    provider: entry.provider,
    warnings: [...entry.warnings],
    prompt: entry.prompt,
    items: cloneGenAiItems(entry.items)
  };
}

function storeGenAiResultCache(cacheKey, { prompt, selected }) {
  if (!cacheKey) {
    return null;
  }

  const now = Date.now();
  genAiResultCache.set(cacheKey, {
    provider: selected.provider,
    warnings: [...(selected.warnings || [])],
    prompt,
    items: cloneGenAiItems(selected.items),
    createdAt: now,
    expiresAt: now + getGenAiResultCacheTtlMs()
  });
  pruneGenAiResultCache(now);
  return cacheKey;
}

function canServeCachedGenAiItems(items) {
  return items.every((item) => item.genai?.id && getStoredGenAiImage(item.genai.id));
}

function pruneGenAiResultCache(now = Date.now()) {
  for (const [cacheKey, entry] of genAiResultCache) {
    if (now >= entry.expiresAt || !canServeCachedGenAiItems(entry.items)) {
      genAiResultCache.delete(cacheKey);
    }
  }
  while (genAiResultCache.size > getGenAiResultCacheMax()) {
    const oldestKey = genAiResultCache.keys().next().value;
    genAiResultCache.delete(oldestKey);
  }
}

function cloneGenAiItems(items) {
  return (items || []).map((item) => ({
    ...item,
    genai: item.genai
      ? {
        ...item.genai,
        modifier: item.genai.modifier
          ? {
            ...item.genai.modifier,
            stack: Array.isArray(item.genai.modifier.stack) ? [...item.genai.modifier.stack] : undefined
          }
          : undefined
      }
      : null
  }));
}

function buildGenAiItemFromStoredRecord(record) {
  return {
    imageUrl: `/api/genai/image/${record.id}`,
    linkUrl: null,
    width: record.width || null,
    height: record.height || null,
    genai: record.genai ? { ...record.genai } : null
  };
}

function buildGenAiLineageItems(record) {
  const lineage = [];
  const seen = new Set();
  let current = record;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    lineage.push(current);
    const parentId = current.genai?.parentId;
    current = parentId ? getStoredGenAiImage(parentId) : null;
  }

  return lineage.reverse().map(buildGenAiItemFromStoredRecord);
}

function normalizeGenAiSeed(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RequestPolicyError("Invalid GenAI seed");
  }
  return parsed;
}


function getGenAiResultCacheMax() {
  return parsePositiveInteger(process.env.GENAI_RESULT_CACHE_MAX, 50);
}

function getGenAiResultCacheTtlMs() {
  return parsePositiveInteger(process.env.GENAI_RESULT_CACHE_TTL_MS, getGenAiImageCacheTtlMs());
}

// GenAI prompts get their own (larger) ceiling: a search query is a handful of
// words, a prompt legitimately is not. Truncation, never a 400.
function normalizeGenAiPrompt(raw) {
  return normalizeSearchQuery(raw, GENAI_PROMPT_MAX_CHARS);
}

export async function generateImages({ prompt, negativePrompt, count, sourceRecord = null, seed = null }) {
  const provider = getGenAiProvider();
  if (provider === "disabled") {
    throw new ProviderConfigError("GENAI_ENDPOINT is not configured");
  }
  const effectiveNegativePrompt = withMuseumSafeNegativePrompt(negativePrompt);
  let selected;

  if (provider === "drawthings" || provider === "a1111") {
    selected = {
      provider,
      warnings: [],
      items: sourceRecord ? await varyImagesViaSdApi({
        provider,
        prompt,
        negativePrompt: effectiveNegativePrompt,
        count,
        sourceRecord,
        seed,
        modifierSeed: seed,
        modifierIndexBase: 0
      }) : await generateImagesViaSdApi({
        provider,
        prompt,
        negativePrompt: effectiveNegativePrompt,
        count,
        seed
      })
    };
  } else if (provider === "fal") {
    selected = {
      provider,
      warnings: [],
      items: sourceRecord ? await varyImagesViaFal({
        prompt,
        count,
        sourceRecord,
        seed,
        modifierSeed: seed,
        modifierIndexBase: 0
      }) : await generateImagesViaFal({
        prompt,
        count,
        seed
      })
    };
  } else if (provider === "custom" || provider === "relay") {
    selected = {
      provider,
      warnings: [],
      items: await generateImagesViaCustomEndpoint({
        provider,
        prompt,
        negativePrompt: effectiveNegativePrompt,
        count,
        sourceRecord,
        seed
      })
    };
  } else {
    throw new ProviderConfigError(`Unsupported GENAI_PROVIDER: ${provider}`);
  }

  return sourceRecord
    ? { ...selected, items: [...buildGenAiLineageItems(sourceRecord), ...selected.items] }
    : selected;
}

// `count` is the BATCH size, always, even when the pool covers most of it:
// `poolSlots[index] === null` is the only thing that decides whether slot index
// is generated. The loop index therefore still drives the modifier salt and the
// strength ramp, which is what keeps a generated image aligned with the pool key
// its slot was drawn against.
async function generateImagesProgressive({
  prompt,
  negativePrompt,
  count,
  sourceRecord = null,
  seed = null,
  shouldCancel = null,
  onItems = null,
  batchSeed = null,
  poolSlots = null
}) {
  const provider = getGenAiProvider();
  if (provider === "disabled") {
    throw new ProviderConfigError("GENAI_ENDPOINT is not configured");
  }

  const effectiveNegativePrompt = withMuseumSafeNegativePrompt(negativePrompt);
  const selected = {
    provider,
    warnings: [],
    items: [
      ...(sourceRecord ? buildGenAiLineageItems(sourceRecord) : []),
      ...(poolSlots || []).filter((slot) => slot.preDelivered).map((slot) => slot.preDelivered)
    ]
  };
  // The pool planner had to choose each slot's modifier before this ran, so it
  // hands the seed it used back in rather than letting a second one be minted.
  const baseSeed = batchSeed ?? seed ?? createGenAiSeed();
  const strengths = sourceRecord ? getVariationStrengthRamp(count) : [];

  for (let index = 0; index < count; index += 1) {
    if (typeof shouldCancel === "function" && shouldCancel()) {
      throw new GenAiAbortError("GenAI job cancelled");
    }
    if (poolSlots?.[index]?.preDelivered) {
      onItems?.([], index);
      continue;
    }
    let nextItems;
    const nextSeed = sourceRecord && getGenAiVarySeedMode() === "fixed"
      ? baseSeed
      : baseSeed + index;
    const pooledSlot = poolSlots?.[index]?.pooled ? poolSlots[index] : null;
    if (pooledSlot) {
      nextItems = [storePooledGenAiItem(pooledSlot, { prompt, sourceRecord })];
    } else if (provider === "drawthings" || provider === "a1111") {
      nextItems = sourceRecord
        ? await varyImagesViaSdApi({
          provider,
          prompt,
          negativePrompt: effectiveNegativePrompt,
          count: 1,
          sourceRecord,
          seed: nextSeed,
          strengths: [strengths[index]],
          modifierSeed: baseSeed,
          modifierIndexBase: index
        })
        : await generateImagesViaSdApi({
          provider,
          prompt,
          negativePrompt: effectiveNegativePrompt,
          count: 1,
          seed: nextSeed
        });
    } else if (provider === "fal") {
      nextItems = sourceRecord
        ? await varyImagesViaFal({
          prompt,
          count: 1,
          sourceRecord,
          seed: nextSeed,
          strengths: [strengths[index]],
          modifierSeed: baseSeed,
          modifierIndexBase: index
        })
        : await generateImagesViaFal({
          prompt,
          count: 1,
          seed: nextSeed
        });
    } else if (provider === "custom" || provider === "relay") {
      nextItems = await generateImagesViaCustomEndpoint({
        provider,
        prompt,
        negativePrompt: effectiveNegativePrompt,
        count: 1,
        sourceRecord,
        seed: nextSeed
      });
    } else {
      throw new ProviderConfigError(`Unsupported GENAI_PROVIDER: ${provider}`);
    }
    if (!pooledSlot && poolSlots?.[index]?.grow) {
      growGenAiPool(poolSlots[index], nextItems);
    }

    selected.items.push(...nextItems);
    if (typeof onItems === "function") {
      onItems(nextItems, index);
    }
  }

  return selected;
}

function normalizeGenAiSource(rawSource) {
  if (!rawSource || typeof rawSource !== "object") {
    return null;
  }
  const id = firstString(rawSource.id);
  return id ? { id } : null;
}
