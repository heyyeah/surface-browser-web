import { createGenAiClientId } from "./genai-client.js";

// One per page load, held in memory only. Sent as x-session-id so /admin/live
// can group a visitor's requests; a reload is a new visitor.
export const SESSION_ID = createGenAiClientId();

// The site that linked here, host only, for /admin/live's referrer counts.
function referrerHost() {
  try {
    const ref = new URL(document.referrer);
    return ref.host && ref.host !== location.host ? ref.hostname : "";
  } catch {
    return "";
  }
}

const REFERRER = referrerHost();
export const SESSION_HEADERS = Object.freeze(REFERRER
  ? { "x-session-id": SESSION_ID, "x-referrer": REFERRER }
  : { "x-session-id": SESSION_ID });
