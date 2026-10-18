// Headless Chromium for the extract fallback, with Node doing all its networking.
//
// If Chromium resolved hosts itself, the route check and the connection could
// see different DNS answers (rebinding), and a request that lands on
// 127.0.0.1:PORT counts as local to the admin routes. So every http(s) request
// is fetched by Node through the pinned path and answered with route.fulfill(),
// and Chromium is launched unable to resolve any host, so whatever the route
// does not see fails instead of leaving the box.

export const CHROMIUM_LOCKDOWN_ARGS = [
  // Covers IP literals too. This is what stops redirect hops: in Playwright
  // 1.63 a hop after route.continue() or a fulfilled 3xx never reaches the route.
  "--host-resolver-rules=MAP * ~NOTFOUND",
  // WebRTC dials STUN/TURN IP literals without the resolver.
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
];

// Chromium runs whatever script the page a visitor named carries, so the
// browser's own sandbox stays on (Playwright turns it off unless asked) and the
// browser gets none of this process's environment, which holds the provider
// keys. On Ubuntu 24.04+ the sandbox needs deploy/apparmor/playwright-chromium.
const CHROMIUM_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "FONTCONFIG_PATH", "FONTCONFIG_FILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"];
const chromiumEnv = () => Object.fromEntries(
  CHROMIUM_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])
);

export const CHROMIUM_LAUNCH_OPTIONS = {
  headless: true,
  chromiumSandbox: true,
  env: chromiumEnv(),
  args: CHROMIUM_LOCKDOWN_ARGS,
  // Playwright's own SIGTERM/SIGHUP handlers close Chromium but leave Node
  // running. Its exit hook still kills Chromium on process.exit().
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false
};

// Service workers fetch outside page.route.
export const CONTEXT_LOCKDOWN_OPTIONS = { serviceWorkers: "block" };

// Hop-by-hop headers, plus the ones Node's fetch owns. Conditional headers are
// dropped so upstream never answers 304 with no body to fulfil.
const DROP_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding",
  "if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range"
]);

// The body arrives decoded and whole, so the original framing and encoding no
// longer describe it.
const DROP_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade", "content-encoding", "content-length"
]);

export function requestHeadersForUpstream(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (!DROP_REQUEST_HEADERS.has(key) && !key.startsWith(":")) {
      out[key] = value;
    }
  }
  return out;
}

// Accepts a fetch Headers or a plain object. Repeated Set-Cookie values are
// joined with "\n", which Playwright splits back into separate headers.
export function responseHeadersForFulfil(headers) {
  const out = {};
  const entries = typeof headers?.entries === "function" ? headers.entries() : Object.entries(headers || {});
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(key)) {
      continue;
    }
    out[key] = key in out ? `${out[key]}${key === "set-cookie" ? "\n" : ", "}${value}` : value;
  }
  return out;
}

function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= max) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function isMainFrameNavigation(request) {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    return false;
  }
}

// Ignores the fragment: Chromium requests a URL without it, but a Location
// header may carry one.
function sameUrl(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.href === right.href;
  } catch {
    return a === b;
  }
}

// fetchUpstream(url, { method, headers, body }) must validate and pin every hop
// itself and resolve to { url, status, headers, body: Buffer }, where url is the
// final URL after any redirects it followed.
//
// Redirects are followed in Node: Chromium would send a hop past the route. A
// top-level navigation that redirected is aborted with the result kept in
// `state.redirectTo`/`pending`, so the caller can goto() the final URL and the
// page gets the right base URL; the cached response then answers that goto.
export async function routeContextThroughNode(context, { fetchUpstream, maxInFlight = 6 }) {
  const state = {
    navigationError: null,
    redirectTo: null,
    pending: null,
    awaitingGoto: false,
    expectGoto() {
      this.awaitingGoto = true;
      this.redirectTo = null;
    }
  };
  const limit = createLimiter(maxInFlight);
  // Requests still queued when the context closes (deadline, or done) are
  // dropped rather than fetched for nobody.
  let closed = false;
  context.on?.("close", () => {
    closed = true;
  });

  // WebRTC can dial TURN over TCP to an IP literal, which neither the resolver
  // rule nor the UDP policy stops. Extraction never needs it.
  await context.addInitScript(() => {
    // Extraction runs in the page's own world, after the page's scripts, which
    // can make a title or alt hundreds of MB and patch String.prototype. This
    // clip is bound to the real intrinsics before any page script runs, and is
    // frozen in place, so extraction can bound what it returns to Node.
    const apply = Reflect.apply;
    const slice = String.prototype.slice;
    const clip = (value, max) => (typeof value === "string" ? (value.length > max ? apply(slice, value, [0, max]) : value) : "");
    try {
      Object.defineProperty(window, "__sbClip", { value: Object.freeze(clip), writable: false, configurable: false });
    } catch {
      // Already defined in this frame.
    }
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
      try {
        delete window[name];
      } catch {
        // Not configurable in this frame; nothing else to do.
      }
    }
  });

  const answer = async (route, fulfilment) => {
    try {
      await route.fulfill(fulfilment);
    } catch {
      // The page or context closed while Node was fetching.
    }
  };
  const refuse = async (route, reason) => {
    try {
      await route.abort(reason);
    } catch {
      // As above.
    }
  };

  // Unconnected and then closed, so the page never reaches a real server.
  await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: "blocked" }));

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    if (/^(data|blob):/i.test(url)) {
      await route.continue();
      return;
    }
    // GET/HEAD only: replaying a page's POSTs would make this server an
    // anonymous relay for whatever the page submits.
    if (!/^https?:/i.test(url) || !["GET", "HEAD"].includes(request.method())) {
      await refuse(route, "blockedbyclient");
      return;
    }

    const mainNav = isMainFrameNavigation(request);
    const forGoto = mainNav && state.awaitingGoto;
    if (forGoto) {
      state.awaitingGoto = false;
    }
    if (mainNav && state.pending && sameUrl(state.pending.url, url)) {
      const { fulfilment } = state.pending;
      state.pending = null;
      await answer(route, fulfilment);
      return;
    }

    let result;
    try {
      const headers = requestHeadersForUpstream(await request.allHeaders());
      const method = request.method();
      result = await limit(() => {
        if (closed) {
          throw new Error("Render context closed");
        }
        return fetchUpstream(url, { method, headers });
      });
    } catch (err) {
      if (mainNav && !state.navigationError) {
        state.navigationError = err;
      }
      await refuse(route, "blockedbyclient");
      return;
    }

    const fulfilment = {
      status: result.status,
      headers: responseHeadersForFulfil(result.headers),
      body: result.body
    };
    if (forGoto && result.url && !sameUrl(result.url, url)) {
      state.pending = { url: result.url, fulfilment };
      state.redirectTo = result.url;
      await refuse(route, "aborted");
      return;
    }
    await answer(route, fulfilment);
  });

  return state;
}

// One Chromium shared by every render, launched on first use and closed after
// idleMs with no render holding it. acquire() and release() must pair.
export function createSharedBrowser({ launch, idleMs = 60_000 }) {
  let browserPromise = null;
  let holders = 0;
  let idleTimer = null;

  const forget = (promise) => {
    if (browserPromise === promise) {
      browserPromise = null;
    }
  };

  async function closeBrowser() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const promise = browserPromise;
    browserPromise = null;
    const browser = await promise?.catch(() => null);
    await browser?.close().catch(() => {});
  }

  async function acquire() {
    clearTimeout(idleTimer);
    idleTimer = null;
    holders += 1;
    try {
      // Assigned before any await, so two renders racing here share one launch.
      if (!browserPromise) {
        const promise = Promise.resolve().then(launch).then((browser) => {
          browser.on("disconnected", () => forget(promise));
          return browser;
        });
        browserPromise = promise;
        promise.catch(() => forget(promise));
      }
      const promise = browserPromise;
      const browser = await promise;
      if (!browser.isConnected()) {
        forget(promise);
        throw new Error("Chromium disconnected");
      }
      return browser;
    } catch (err) {
      release();
      throw err;
    }
  }

  function release() {
    holders = Math.max(0, holders - 1);
    if (holders === 0 && browserPromise && !idleTimer) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (holders === 0) {
          closeBrowser();
        }
      }, idleMs);
      idleTimer.unref?.();
    }
  }

  return {
    acquire,
    release,
    close: closeBrowser,
    get running() {
      return Boolean(browserPromise);
    }
  };
}

export class RenderTimeoutError extends Error {}

// Runs work(deadline) against an overall time limit. On expiry onTimeout runs
// (close the context) and the call rejects; work can poll deadline.expired to
// clean up anything it creates after that point.
export async function withRenderDeadline(work, ms, onTimeout) {
  const deadline = { expired: false };
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      deadline.expired = true;
      Promise.resolve().then(onTimeout).catch(() => {});
      reject(new RenderTimeoutError(`Render timed out after ${ms} ms`));
    }, ms);
  });
  const running = Promise.resolve().then(() => work(deadline));
  running.catch(() => {});
  try {
    return await Promise.race([running, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
