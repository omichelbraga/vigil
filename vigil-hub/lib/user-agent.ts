/**
 * Minimal User-Agent parser — no external dep.
 * Produces a short human-readable summary like "Chrome on macOS" or "curl".
 */

interface ParsedUA {
  browser: string;
  os: string;
  summary: string;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\/[\d.]+/i, "Edge"],
  [/OPR\/[\d.]+|Opera\/[\d.]+/i, "Opera"],
  [/Chrome\/[\d.]+/i, "Chrome"],
  [/Firefox\/[\d.]+/i, "Firefox"],
  [/Safari\/[\d.]+/i, "Safari"],
  [/curl\/[\d.]+/i, "curl"],
  [/Wget\/[\d.]+/i, "Wget"],
  [/PostmanRuntime/i, "Postman"],
  [/vigil-agent/i, "Vigil Agent"],
];

const OS: Array<[RegExp, string]> = [
  [/Windows NT 10\.0/i, "Windows 10/11"],
  [/Windows NT 6\.3/i, "Windows 8.1"],
  [/Windows NT 6\.1/i, "Windows 7"],
  [/Windows/i, "Windows"],
  [/Mac OS X|Macintosh/i, "macOS"],
  [/iPhone|iPad|iOS/i, "iOS"],
  [/Android/i, "Android"],
  [/Linux/i, "Linux"],
];

export function parseUserAgent(ua: string | null | undefined): ParsedUA {
  if (!ua) return { browser: "Unknown", os: "Unknown", summary: "Unknown" };

  let browser = "Unknown";
  for (const [re, name] of BROWSERS) {
    if (re.test(ua)) {
      browser = name;
      break;
    }
  }

  let os = "Unknown";
  for (const [re, name] of OS) {
    if (re.test(ua)) {
      os = name;
      break;
    }
  }

  const summary =
    browser === "Unknown" && os === "Unknown"
      ? ua.slice(0, 40)
      : browser === "Unknown"
        ? os
        : os === "Unknown"
          ? browser
          : `${browser} on ${os}`;

  return { browser, os, summary };
}
