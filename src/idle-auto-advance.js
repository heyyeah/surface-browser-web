// Cost control: auto-advance has no natural end. After SPHERE_DWELL_SECONDS of
// no interaction the sphere advances to the linked image (transitions.js), and
// for GenAI panels that re-runs the paid image-to-image path, producing another
// GenAI sphere. An unattended tab would generate indefinitely, so auto-advance
// suspends after the idle timeout and any input resumes it.
//
// Pure — no DOM, no state import, no clock of its own — so the edges (which make
// the status message fire once, not every frame) are testable offline. `nowMs`
// is a monotonic performance.now() reading from the call site.

// Five minutes: longer than several dwell cycles, short enough that a forgotten
// tab costs one batch rather than a day's quota.
export const AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS = 300_000;

// An hour, for a hop that spends nothing (ordinary web pages): a leash, not a
// budget.
export const AUTO_ADVANCE_FREE_IDLE_TIMEOUT_DEFAULT_MS = 3_600_000;

// 0 means never suspend (attended-kiosk `?auto=` gallery mode).
export function normalizeIdleTimeoutMs(value, fallback = AUTO_ADVANCE_IDLE_TIMEOUT_DEFAULT_MS) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function stepAutoAdvanceIdle({ nowMs, lastInputMs, timeoutMs, suspended = false } = {}) {
  const timeout = Number(timeoutMs);
  const wasSuspended = Boolean(suspended);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    // Disabled. Still reports the resume edge so turning the timeout off at runtime
    // cannot strand a suspended sphere with a stale status line.
    return { suspended: false, justSuspended: false, justResumed: wasSuspended, idleMs: 0 };
  }

  const now = Number(nowMs);
  const last = Number(lastInputMs);
  if (!Number.isFinite(now) || !Number.isFinite(last)) {
    // No usable clock reading: treat as "just interacted". Failing towards "keep
    // going" is safe because the server-side caps still apply.
    return { suspended: false, justSuspended: false, justResumed: wasSuspended, idleMs: 0 };
  }

  // A lastInput in the FUTURE reads as no idle at all, never as a huge one:
  // the frame that marks input can land after `now` was sampled.
  const idleMs = Math.max(0, now - last);
  const nextSuspended = idleMs >= timeout;
  return {
    suspended: nextSuspended,
    justSuspended: nextSuspended && !wasSuspended,
    justResumed: !nextSuspended && wasSuspended,
    idleMs
  };
}
