// Addresses a server-side fetch must never reach: loopback, private, link-local,
// carrier-grade NAT, multicast/reserved, and the IPv6 forms that embed or tunnel
// to one of those.

import net from "node:net";

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
].map(([base, bits]) => [ipv4ToNumber(base), bits]);

function normalizeAddress(address) {
  return String(address || "")
    .split("%")[0]
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

// Anything that is not a parseable IP literal counts as blocked.
export function isBlockedIpAddress(address) {
  const normalized = normalizeAddress(address);
  const version = net.isIP(normalized);
  if (version === 4) {
    return isBlockedIpv4(normalized);
  }
  if (version === 6) {
    return isBlockedIpv6(normalized);
  }
  return true;
}

export function isBlockedIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === null) {
    return true;
  }
  return BLOCKED_IPV4_CIDRS.some(([base, bits]) => isIpv4InCidr(value, base, bits));
}

function ipv4ToNumber(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

function isIpv4InCidr(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv4FromGroups(high, low) {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

export function isBlockedIpv6(address) {
  const groups = parseIpv6Groups(address);
  if (!groups) {
    return true;
  }

  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (allZero || loopback) {
    return true;
  }

  const [first, second, third] = groups;
  if ((first & 0xfe00) === 0xfc00) {
    return true;
  }
  if ((first & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((first & 0xff00) === 0xff00) {
    return true;
  }

  // Forms that carry an IPv4 address: the IPv4 verdict decides.
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated, RFC 2765).
  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const ipv4Translated = groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0;
  // 64:ff9b::/96, the well-known NAT64 prefix.
  const nat64 = first === 0x64 && second === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (ipv4Mapped || ipv4Translated || nat64) {
    return isBlockedIpv4(ipv4FromGroups(groups[6], groups[7]));
  }
  // 2002::/16, 6to4: the IPv4 address sits in groups 1-2.
  if (first === 0x2002) {
    return isBlockedIpv4(ipv4FromGroups(second, third));
  }
  // 64:ff9b:1::/48, local-use NAT64 (RFC 8215): translates to whatever the
  // operator chose, so there is no fixed IPv4 to check.
  if (first === 0x64 && second === 0xff9b && third === 1) {
    return true;
  }
  // 2001::/32 Teredo and 2001:db8::/32 documentation.
  if (first === 0x2001 && (second === 0 || second === 0xdb8)) {
    return true;
  }

  const ipv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  if (ipv4Compatible) {
    return true;
  }

  return false;
}

function parseIpv6Groups(address) {
  let input = normalizeAddress(address);
  const ipv4Match = input.match(/(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const ipv4Value = ipv4ToNumber(ipv4Match[2]);
    if (ipv4Value === null) {
      return null;
    }
    const high = ((ipv4Value >>> 16) & 0xffff).toString(16);
    const low = (ipv4Value & 0xffff).toString(16);
    input = `${input.slice(0, input.length - ipv4Match[2].length)}${high}:${low}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) {
    return null;
  }

  const groups = [...left, ...Array(missing).fill("0"), ...right].map((group) => {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }
    return Number.parseInt(group, 16);
  });

  if (groups.length !== 8 || groups.some((group) => group === null || group < 0 || group > 0xffff)) {
    return null;
  }

  return groups;
}
