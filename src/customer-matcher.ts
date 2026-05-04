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

    let best: { record: CustomerRecord; score: number; confidence: "exact" | "prefix" | "fuzzy" } | null = null;

    for (const entry of this.entries) {
      if (entry.norm === norm) {
        return { matched: true, customer: entry.record, confidence: "exact", score: 100 };
      }

      if (norm.length >= 5 && entry.norm.length >= 5) {
        if (norm.startsWith(entry.norm + " ") || entry.norm.startsWith(norm + " ")) {
          const ratio =
            Math.min(norm.length, entry.norm.length) / Math.max(norm.length, entry.norm.length);
          const score = Math.max(70, ratio * 95);
          if (!best || score > best.score) best = { record: entry.record, score, confidence: "prefix" };
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
            if (!best || score > best.score) best = { record: entry.record, score, confidence: "fuzzy" };
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
          if (!best || score > best.score) best = { record: entry.record, score, confidence: "fuzzy" };
        }
      }
    }

    if (best && best.score >= 50) {
      return { matched: true, customer: best.record, confidence: best.confidence, score: best.score };
    }
    return { matched: false, confidence: "none" };
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
      if (!id || !name || !taxNumber) return null;
      if (!/^[0-9A-Za-z][0-9A-Za-z-]*$/.test(taxNumber)) return null;
      return { id, name, taxNumber, country, code, city };
    })
    .filter((x: CustomerRecord | null): x is CustomerRecord => x !== null);
}
