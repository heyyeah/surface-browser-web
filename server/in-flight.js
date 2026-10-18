// Identical requests that arrive while one is in flight wait for it and replay
// its response, instead of fetching (and resizing, or paying for) the same thing
// again: one link opened by a room at once is one upstream fetch. Followers are
// checked ahead of the slot pools, so waiting takes no slot. A leader registers
// only once nothing visitor-specific can refuse it (slots, spend), so a reply is
// the same for anyone.
const REPLAY_HEADERS = ["content-type", "cache-control", "content-security-policy", "vary"];

export function createInFlightRequests() {
  const inFlight = new Map();
  return {
    async follow(key, res) {
      const pending = key ? inFlight.get(key) : null;
      const reply = pending ? await pending : null;
      if (!reply || res.headersSent) {
        return false;
      }
      for (const [name, value] of Object.entries(reply.headers)) {
        res.setHeader(name, value);
      }
      res.status(reply.status).send(reply.body);
      return true;
    },
    lead(key, res) {
      if (!key || inFlight.has(key)) {
        return;
      }
      let settle;
      const pending = new Promise((resolve) => {
        settle = resolve;
      });
      inFlight.set(key, pending);
      let settled = false;
      const done = (reply) => {
        if (settled) {
          return;
        }
        settled = true;
        if (inFlight.get(key) === pending) {
          inFlight.delete(key);
        }
        settle(reply);
      };
      const send = res.send.bind(res);
      res.send = (body) => {
        const headers = {};
        for (const name of REPLAY_HEADERS) {
          if (res.hasHeader(name)) {
            headers[name] = res.getHeader(name);
          }
        }
        done({ status: res.statusCode, headers, body });
        return send(body);
      };
      // A leader that ends without a body (disconnect, crash) lets its followers
      // run the request themselves.
      res.once("close", () => done(null));
    }
  };
}
