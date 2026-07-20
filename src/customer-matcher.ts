import type { CustomerRecord, MatchResult } from "./types";

export function normalizeName(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[ščćžđ]/g, (c) => ({ š: "s", č: "c", ć: "c", ž: "z", đ: "d" }[c] ?? c))
    .replace(/\b(d\.\s*o\.\s*o\.?|d\.\s*d\.?|s\.\s*p\.?|gmbh|ltd|inc\.?|llc|corp\.?|s\.\s*a\.\s*r\.\s*l\.|s\.\s*a\.?|s\.\s*r\.\s*l\.?|b\.\s*v\.?|spa|sl|ag|kg|ohg|sas|sasu|sarl|ltda)\b/gi, " ")
    .replace(/[,()&./]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether this record's tax number can go into <OrgId> as a TXID.
 *
 * MiniMax stores non-EU suppliers with the literal placeholder "tretja država"
 * (and a run-together "tretjadržava"), which identifies the customer fine but
 * is not an identifier. Requiring a digit rejects those without hard-coding
 * the phrase — every real number we hold has one (11414928, IE3206488LH,
 * NL005039900B16, EU372079631).
 */
export function hasUsableTaxNumber(c: CustomerRecord): boolean {
  const t = (c.taxNumber ?? "").trim();
  return /^[0-9A-Za-z][0-9A-Za-z-]*$/.test(t) && /\d/.test(t);
}

interface NormalizedCustomer {
  record: CustomerRecord;
  norm: string;
  words: string[];
}

export class CustomerMatcher {
  private entries: NormalizedCustomer[];

  constructor(public customers: CustomerRecord[]) {
    this.entries = customers.map((c) => {
      const norm = normalizeName(c.name);
      return { record: c, norm, words: norm.split(" ").filter(Boolean) };
    });
  }

  match(query: string): MatchResult {
    if (!query) return { matched: false, confidence: "none" };
    const norm = normalizeName(query);
    if (!norm) return { matched: false, confidence: "none" };
    const queryWords = norm.split(" ").filter(Boolean);

    type Cand = { record: CustomerRecord; score: number; confidence: "exact" | "prefix" | "fuzzy" };
    // Two ladders. MiniMax often holds the same party twice — the business
    // ("Sandra Staniša s.p." with a tax number) and a bare-name duplicate from
    // the webshop. The duplicate wins on raw score because the bank writes the
    // short name, but it is the useless one: the tax number is what MiniMax
    // links on. So a taxed record wins whenever one matches at all.
    const cands: Cand[] = [];
    const offer = (c: Cand) => cands.push(c);

    for (const entry of this.entries) {
      if (entry.norm === norm) {
        offer({ record: entry.record, score: 100, confidence: "exact" });
        continue;
      }

      // 4, not 5: short company names normalize below the old floor once the
      // legal-form suffix is stripped ("Ucom d.o.o." → "ucom"), so they could
      // never match their fuller bank-side spelling ("UCOM TRGOVINA D.O.O.").
      // Safe because the test below is a whole-word prefix, not a substring.
      if (norm.length >= 4 && entry.norm.length >= 4) {
        if (norm.startsWith(entry.norm + " ") || entry.norm.startsWith(norm + " ")) {
          const ratio =
            Math.min(norm.length, entry.norm.length) / Math.max(norm.length, entry.norm.length);
          const score = Math.max(70, ratio * 95);
          offer({ record: entry.record, score, confidence: "prefix" });
          continue;
        }
      }

      if (queryWords.length >= 2 && entry.words.length >= 2) {
        const [shorter, longer] =
          queryWords.length <= entry.words.length
            ? [queryWords, entry.words]
            : [entry.words, queryWords];
        const longerSet = new Set(longer);
        const significant = shorter.filter((w) => w.length >= 3);
        if (significant.length >= 2) {
          const hits = significant.filter((w) => longerSet.has(w)).length;
          if (hits === significant.length) {
            const score = 60 + Math.min(20, significant.length * 5);
            offer({ record: entry.record, score, confidence: "fuzzy" });
            continue;
          }
        }
      }

      const minLen = Math.min(queryWords.length, entry.words.length);
      if (minLen >= 2) {
        let leadingMatch = 0;
        for (let i = 0; i < minLen; i++) {
          if (queryWords[i] === entry.words[i]) leadingMatch++;
          else break;
        }
        if (leadingMatch >= 2) {
          const score = (leadingMatch / Math.max(queryWords.length, entry.words.length)) * 80;
          offer({ record: entry.record, score, confidence: "fuzzy" });
        }
      }
    }

    const viable = cands.filter((c) => c.score >= 50);
    if (viable.length === 0) return { matched: false, confidence: "none" };
    const taxed = viable.filter((c) => hasUsableTaxNumber(c.record));
    const pool = taxed.length > 0 ? taxed : viable;
    const pick = pool.reduce((a, b) => (b.score > a.score ? b : a));
    return { matched: true, customer: pick.record, confidence: pick.confidence, score: pick.score };
  }
}

export function parseCustomerJson(text: string): CustomerRecord[] {
  const parsed = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : (parsed.customers ?? parsed.Rows ?? []);
  if (!Array.isArray(arr)) {
    throw new Error("Customer JSON must be an array (or have a 'customers' or 'Rows' key)");
  }
  return arr
    .map((raw: Record<string, unknown>): CustomerRecord | null => {
      const id = (raw.id ?? raw.CustomerId) as number | undefined;
      const name = (raw.name ?? raw.Name) as string | undefined;
      const taxNumber = (raw.taxNumber ?? raw.TaxNumber) as string | undefined;
      const country = (raw.country ?? (raw.Country as { Name?: string })?.Name) as string | undefined;
      const code = (raw.code ?? raw.Code) as string | null | undefined;
      const city = (raw.city ?? raw.City) as string | undefined;
      // A missing or placeholder tax number no longer disqualifies a record.
      // It still can't be emitted as a TXID (hasUsableTaxNumber gates that),
      // but the name alone is worth having: it fixes the spelling MiniMax
      // shows and covers refunds to individuals and non-EU suppliers, none of
      // which carry a tax number.
      if (!id || !name) return null;
      return { id, name, taxNumber: (taxNumber ?? "").trim(), country, code, city };
    })
    .filter((x: CustomerRecord | null): x is CustomerRecord => x !== null);
}
