import { createGenAiClientId } from "./genai-client.js";

// One per page load, held in memory only. Sent as x-session-id so /admin/live
// can group a visitor's requests; a reload is a new visitor.
export const SESSION_ID = createGenAiClientId();
export const SESSION_HEADERS = Object.freeze({ "x-session-id": SESSION_ID });
