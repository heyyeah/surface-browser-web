// Test-only DNS rebinding simulator, loaded into the REAL server process via
// `NODE_OPTIONS="--import <this file>"` (see the "DNS rebinding" test in
// contract_hardening.test.mjs). It patches Node's two DNS entry points to
// answer DIFFERENTLY for one fixed test hostname, depending on which one
// asks:
//
//   - node:dns/promises .lookup() — what server/index.js's
//     assertTargetUrlAllowed() calls to VALIDATE a target — answers with
//     DNS_REBIND_SAFE_ADDRESS.
//   - node:dns (callback-style) .lookup() — the function Node's net/undici
//     connector falls back to at ACTUAL CONNECT TIME whenever nothing pins
//     the address first — answers with DNS_REBIND_ATTACKER_ADDRESS.
//
// This is exactly what a real DNS-rebinding attacker does (answer public
// during the check, private/internal by the time something connects),
// reproduced deterministically instead of depending on real, uncontrollable
// DNS infrastructure. A fixed (pinned) fetchWithTimeout() never calls the
// callback-style lookup at all — its dispatcher supplies the validated
// address itself — so with the fix in place the attacker address is never
// even asked for.
import dnsCallback from "node:dns";
import dnsPromises from "node:dns/promises";

const TEST_HOST = process.env.DNS_REBIND_TEST_HOST;
const SAFE_ADDRESS = process.env.DNS_REBIND_SAFE_ADDRESS;
const ATTACKER_ADDRESS = process.env.DNS_REBIND_ATTACKER_ADDRESS;

if (TEST_HOST && SAFE_ADDRESS && ATTACKER_ADDRESS) {
  const origPromiseLookup = dnsPromises.lookup.bind(dnsPromises);
  dnsPromises.lookup = async (hostname, options) => {
    if (hostname === TEST_HOST) {
      return [{ address: SAFE_ADDRESS, family: SAFE_ADDRESS.includes(":") ? 6 : 4 }];
    }
    return origPromiseLookup(hostname, options);
  };

  const origCallbackLookup = dnsCallback.lookup.bind(dnsCallback);
  dnsCallback.lookup = (hostname, ...rest) => {
    if (hostname !== TEST_HOST) {
      return origCallbackLookup(hostname, ...rest);
    }
    const callback = rest[rest.length - 1];
    const options = rest.length > 1 ? rest[0] : {};
    const family = ATTACKER_ADDRESS.includes(":") ? 6 : 4;
    if (options && options.all) {
      callback(null, [{ address: ATTACKER_ADDRESS, family }]);
    } else {
      callback(null, ATTACKER_ADDRESS, family);
    }
    return undefined;
  };
}
