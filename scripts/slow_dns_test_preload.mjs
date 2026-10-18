// Test-only DNS delay, loaded into the REAL server process via
// `NODE_OPTIONS="--import <this file>"` (see the SCRAPE_CONCURRENCY_MAX test in
// contract_hardening.test.mjs). It makes node:dns/promises.lookup() take
// SLOW_DNS_DELAY_MS before rejecting for exactly one hostname, so a test can hold
// a request inside assertTargetUrlAllowed() for a controlled duration. The
// extract, proxy-image and GenAI import routes cannot reach a loopback mock
// server by design, so there is no other way to make them observably slow.
import dnsPromises from "node:dns/promises";

const TEST_HOST = process.env.SLOW_DNS_TEST_HOST;
const DELAY_MS = Number(process.env.SLOW_DNS_DELAY_MS || 0);

if (TEST_HOST && DELAY_MS > 0) {
  const origLookup = dnsPromises.lookup.bind(dnsPromises);
  dnsPromises.lookup = async (hostname, options) => {
    if (hostname === TEST_HOST) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      throw Object.assign(new Error(`test: ${TEST_HOST} intentionally never resolves`), { code: "ENOTFOUND" });
    }
    return origLookup(hostname, options);
  };
}
