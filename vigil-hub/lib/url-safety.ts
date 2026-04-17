import { lookup } from "dns/promises";
import net from "net";

const PRIVATE_RANGES: Array<[number, number, number]> = [
  [0x7f000000, 0xff000000, 0x7f000000], // 127.0.0.0/8 loopback
  [0x0a000000, 0xff000000, 0x0a000000], // 10.0.0.0/8
  [0xac100000, 0xfff00000, 0xac100000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000, 0xc0a80000], // 192.168.0.0/16
  [0xa9fe0000, 0xffff0000, 0xa9fe0000], // 169.254.0.0/16 link-local
  [0x00000000, 0xff000000, 0x00000000], // 0.0.0.0/8
  [0x64400000, 0xffc00000, 0x64400000], // 100.64.0.0/10 CGNAT
  [0xe0000000, 0xf0000000, 0xe0000000], // 224.0.0.0/4 multicast
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const num = Number(p);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    n = (n << 8) | num;
  }
  return n >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  for (const [, mask, net] of PRIVATE_RANGES) {
    if ((n & mask) === (net & mask)) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.replace("::ffff:", "");
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  return false;
}

/** True when VIGIL_ALLOW_INTERNAL_NET=1. Allows loopback/RFC1918 for dev use. */
export function internalNetAllowed(): boolean {
  return process.env.VIGIL_ALLOW_INTERNAL_NET === "1";
}

/** Reject hostnames that resolve to loopback/RFC1918/link-local. */
export async function assertExternalHostname(
  hostname: string,
): Promise<void> {
  if (!hostname) throw new Error("Hostname is empty");
  if (internalNetAllowed()) return;

  // Literal IP
  if (net.isIPv4(hostname)) {
    if (isPrivateIPv4(hostname)) {
      throw new Error(`Refusing to reach private IPv4 ${hostname}`);
    }
    return;
  }
  if (net.isIPv6(hostname)) {
    if (isPrivateIPv6(hostname)) {
      throw new Error(`Refusing to reach private IPv6 ${hostname}`);
    }
    return;
  }

  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    throw new Error(`Refusing to reach internal hostname ${hostname}`);
  }

  // DNS resolve and check every address
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    // DNS resolution failure — let the downstream call surface the error
    return;
  }
  for (const a of addrs) {
    if (a.family === 4 && isPrivateIPv4(a.address)) {
      throw new Error(
        `Refusing to reach ${hostname} (resolves to private IP ${a.address})`,
      );
    }
    if (a.family === 6 && isPrivateIPv6(a.address)) {
      throw new Error(
        `Refusing to reach ${hostname} (resolves to private IPv6 ${a.address})`,
      );
    }
  }
}

/** Reject URLs that would SSRF to internal networks. Only HTTP(S). */
export async function assertExternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing non-HTTP scheme: ${parsed.protocol}`);
  }
  await assertExternalHostname(parsed.hostname);
}
