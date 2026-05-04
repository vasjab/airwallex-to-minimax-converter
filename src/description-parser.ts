import type { Direction } from "./types";

export interface ParsedDescription {
  name: string;
  iban: string;
  externalRef: string;
  internalRef: string;
}

const PAYOUT_RE = /^Pay (.+) ([\d,]+\.\d{2}) ([A-Z]{3}) \((.+)\) (P\d{6}-\S+)$/u;
const PAYOUT_NO_INTERNAL_RE = /^Pay (.+) ([\d,]+\.\d{2}) ([A-Z]{3}) \((.+)\)$/u;
const PAYOUT_NO_REF_RE = /^Pay (.+) ([\d,]+\.\d{2}) ([A-Z]{3})(?: (P\d{6}-\S+))?$/u;
const DEPOSIT_PIPED_RE = /^([^|]+)\s*\|\s*([^|]+)\s*\|\s*([A-Z]{2}[A-Z0-9]+)\s*\|\s*(.+)$/u;
const IBAN_INLINE_RE = /\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/u;

export function parseDescription(description: string, direction: Direction): ParsedDescription {
  const desc = (description ?? "").trim();
  if (!desc) return empty();

  if (direction === "DBIT") {
    const m = desc.match(PAYOUT_RE);
    if (m) {
      return {
        name: cleanName(m[1]),
        iban: "",
        externalRef: m[4].trim(),
        internalRef: m[5].trim(),
      };
    }
    const m2 = desc.match(PAYOUT_NO_INTERNAL_RE);
    if (m2) {
      return {
        name: cleanName(m2[1]),
        iban: "",
        externalRef: m2[4].trim(),
        internalRef: "",
      };
    }
    const m3 = desc.match(PAYOUT_NO_REF_RE);
    if (m3) {
      return {
        name: cleanName(m3[1]),
        iban: "",
        externalRef: "",
        internalRef: m3[4]?.trim() ?? "",
      };
    }
  }

  if (direction === "CRDT") {
    const m = desc.match(DEPOSIT_PIPED_RE);
    if (m) {
      return {
        name: cleanName(m[1]),
        iban: m[3].trim(),
        externalRef: extractRef(m[2]) || extractRef(m[4]) || "",
        internalRef: "",
      };
    }
  }

  const ibanMatch = desc.match(IBAN_INLINE_RE);
  return {
    name: "",
    iban: ibanMatch ? ibanMatch[1] : "",
    externalRef: "",
    internalRef: "",
  };
}

function empty(): ParsedDescription {
  return { name: "", iban: "", externalRef: "", internalRef: "" };
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function extractRef(s: string): string {
  if (!s) return "";
  const trimmed = s.trim();
  if (trimmed.toLowerCase().startsWith("ref:")) {
    return trimmed.slice(4).trim();
  }
  return "";
}
