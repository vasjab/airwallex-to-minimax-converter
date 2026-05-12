import type { Transaction, WalletSection } from "./types";
import { groupByDay } from "./grouper";
import { validate } from "./validator";

export function splitByCurrency(txs: Transaction[]): WalletSection[] {
  const buckets = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const ccy = (tx.currency || "").toUpperCase() || "UNKNOWN";
    const list = buckets.get(ccy) ?? [];
    list.push(tx);
    buckets.set(ccy, list);
  }
  const sections: WalletSection[] = [];
  for (const [currency, list] of [...buckets.entries()].sort()) {
    const days = groupByDay(list);
    const validation = validate(list, days);
    sections.push({ currency, txs: list, days, validation });
  }
  return sections;
}
