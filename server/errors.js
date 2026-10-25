export class RequestPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequestPolicyError";
  }
}

export class ProviderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

export function sendPolicyError(res, err, fallbackMessage = null) {
  if (err instanceof RequestPolicyError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (fallbackMessage && err) {
    res.status(400).json({ error: fallbackMessage });
    return true;
  }
  return false;
}

// Raised when a vary source image is too large to inline into the hosted
// (fal) img2img request. Surfaces as a 413-style GenAI error.
export class GenAiSourceTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "GenAiSourceTooLargeError";
  }
}
