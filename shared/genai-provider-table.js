// GenAI provider tables shared by the settings panel (src/settings.js) and the
// server (server/settings.js). "relay" is server-only: no panel option, and it
// reads the custom endpoint.

export const GENAI_PROVIDERS = Object.freeze([
  { value: "", label: "Not configured" },
  { value: "drawthings", label: "Draw Things (local)" },
  { value: "a1111", label: "A1111 server" },
  { value: "fal", label: "Hosted (fal.ai)" },
  { value: "custom", label: "Custom endpoint" }
]);

export const GENAI_DEFAULT_ENDPOINTS = Object.freeze({
  drawthings: "http://127.0.0.1:7860",
  a1111: "http://127.0.0.1:8022",
  custom: ""
});

export const GENAI_PROVIDER_ENDPOINT_KEYS = Object.freeze({
  drawthings: "GENAI_DRAWTHINGS_ENDPOINT",
  a1111: "GENAI_A1111_ENDPOINT",
  custom: "GENAI_CUSTOM_ENDPOINT"
});
