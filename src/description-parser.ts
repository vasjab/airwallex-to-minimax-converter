import type { Direction } from "./types";

export interface ParsedDescription {
  name: string;
  iban: string;
  externalRef: string;
  internalRef: string;
  /** Extra payee context (card, country, source account, fee origin) for the remittance line. */
  details: string[];
}

const PAYOUT_RE = /^Pay (.+) ([\d,]+\.\d{2}) ([A-Z]{3}) \((.+)\) (P\d{6}-\S+)$/u;
const PAYOUT_NO_INTERNAL_RE = /^Pay (.+) ([\d,]+\.\d{2}) ([A-Z]{3}) \((.+)\)$/u;
const PAYOUT_NO_REF_RE = /^Pay (.+) ([\d,]+\.\d{2}) ([A-Z]{3})(?: (P\d{6}-\S+))?$/u;
const IBAN_INLINE_RE = /\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/u;

// "FEDEX SLOVENIA, WWW.FEDEX.COM, SVN, (Alpine Nation d.o.o., **8287): EUR 26.66"
const CARD_RE =
  /^(.+?), (.+?), ([A-Z]{3}), \((.+), \*\*(\d{4})\): [A-Z]{3} [\d,]+\.\d{2}$/u;
// "Fee for transfer of 4,580.30 USD to Macro Exports (ME 0043-2026) P260508-Z3SL7ZS"
const FEE_RE = /^Fee for transfer of [\d,]+\.\d{2} [A-Z]{3} to (.+)$/u;
const INTERNAL_REF_TAIL_RE = /\s(P\d{6}-\S+)$/u;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u;
const ACCOUNT_NO_RE = /^\d+$/u;

// Airwallex charges its own transfer fees, so the fee entry's counterparty is
// the bank — not the supplier the transfer went to.
const FEE_CREDITOR = "Airwallex";

export function parseDescription(description: string, direction: Direction): ParsedDescription {
  const desc = (description ?? "").trim();
  if (!desc) return empty();

  const fee = parseFee(desc);
  if (fee) return fee;

  const card = parseCard(desc);
  if (card) return card;

  if (direction === "DBIT") {
    const m = desc.match(PAYOUT_RE);
    if (m) {
      return {
        name: cleanName(m[1]),
        iban: "",
        externalRef: m[4].trim(),
        internalRef: m[5].trim(),
        details: [],
      };
    }
    const m2 = desc.match(PAYOUT_NO_INTERNAL_RE);
    if (m2) {
      return {
        name: cleanName(m2[1]),
        iban: "",
        externalRef: m2[4].trim(),
        internalRef: "",
        details: [],
      };
    }
    const m3 = desc.match(PAYOUT_NO_REF_RE);
    if (m3) {
      return {
        name: cleanName(m3[1]),
        iban: "",
        externalRef: "",
        internalRef: m3[4]?.trim() ?? "",
        details: [],
      };
    }
  }

  const piped = parsePiped(desc);
  if (piped) return piped;

  const ibanMatch = desc.match(IBAN_INLINE_RE);
  return {
    name: "",
    iban: ibanMatch ? ibanMatch[1] : "",
    externalRef: "",
    internalRef: "",
    details: [],
  };
}

/**
 * Card entries name the merchant first, then a descriptor (URL or city), the
 * merchant country, and the card the charge landed on.
 */
function parseCard(desc: string): ParsedDescription | null {
  const m = desc.match(CARD_RE);
  if (!m) return null;

  const merchant = cleanName(m[1]);
  const descriptor = cleanName(m[2]);
  const country = m[3];
  const last4 = m[5];

  const details: string[] = [];
  if (descriptor && descriptor.toLowerCase() !== merchant.toLowerCase()) details.push(descriptor);
  details.push(country, `Card **${last4}`);

  return { name: merchant, iban: "", externalRef: "", internalRef: "", details };
}

/**
 * The supplier refs inside a fee description belong to the transfer, not the
 * fee, so they stay in the free text instead of becoming externalRef — feeding
 * them to MiniMax as a structured ref would offer the fee against those invoices.
 */
function parseFee(desc: string): ParsedDescription | null {
  const m = desc.match(FEE_RE);
  if (!m) return null;

  let rest = m[1];
  let internalRef = "";
  const tail = rest.match(INTERNAL_REF_TAIL_RE);
  if (tail?.index !== undefined) {
    internalRef = tail[1];
    rest = rest.slice(0, tail.index).trim();
  }

  const { head, inner } = splitTrailingParen(rest);
  const payee = head || rest;
  const origin = inner ? `Transfer fee: ${payee} (${inner})` : `Transfer fee: ${payee}`;

  return {
    name: FEE_CREDITOR,
    iban: "",
    externalRef: "",
    internalRef,
    details: [origin],
  };
}

/**
 * Deposits and direct debits arrive pipe-separated:
 *   "<payer> | [Ref: X |] GA <our account> | <our account no> | <uuid>"
 *
 * The account trailing the "GA" (Global Account) label is the one *receiving*
 * the money — ours, not the payer's. It tracks the wallet currency, not the
 * payer: every EUR deposit carries our EUR wallet IBAN whether the payer is
 * Shopify, Currency Cloud or ourselves. So it must never become
 * counterpartyIban, or the XML claims the payer's account is our own account.
 * Airwallex simply does not disclose the payer's account here.
 */
function parsePiped(desc: string): ParsedDescription | null {
  if (!desc.includes("|")) return null;
  const segs = desc.split("|").map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;

  let externalRef = "";
  const details: string[] = [];

  for (const seg of segs.slice(1)) {
    if (UUID_RE.test(seg) || ACCOUNT_NO_RE.test(seg) || IBAN_RE.test(seg)) continue;
    const ref = extractRef(seg);
    if (ref) {
      externalRef = ref;
      continue;
    }
    details.push(cleanName(seg));
  }

  return { name: cleanName(segs[0]), iban: "", externalRef, internalRef: "", details };
}

/** Splits "NEWSTAR (SUQIAN) LTD (NSEX26068-4 (50%))" into head + innermost-balanced tail. */
function splitTrailingParen(s: string): { head: string; inner: string } {
  const t = s.trim();
  if (!t.endsWith(")")) return { head: t, inner: "" };
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] === ")") depth++;
    else if (t[i] === "(") {
      depth--;
      if (depth === 0) {
        return { head: t.slice(0, i).trim(), inner: t.slice(i + 1, -1).trim() };
      }
    }
  }
  return { head: t, inner: "" };
}

function empty(): ParsedDescription {
  return { name: "", iban: "", externalRef: "", internalRef: "", details: [] };
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
