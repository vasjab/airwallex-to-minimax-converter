import type { DailyStatement, Transaction } from "./types";

export function groupByDay(txs: Transaction[]): DailyStatement[] {
  const sorted = [...txs].sort((a, b) =>
    a.bookingTime < b.bookingTime ? -1 : a.bookingTime > b.bookingTime ? 1 : 0,
  );
  const groups = new Map<string, Transaction[]>();
  for (const tx of sorted) {
    const list = groups.get(tx.bookingDate) ?? [];
    list.push(tx);
    groups.set(tx.bookingDate, list);
  }

  const days: DailyStatement[] = [];
  for (const [date, list] of [...groups.entries()].sort()) {
    const last = list[list.length - 1];
    const first = list[0];
    let totalCredits = 0;
    let totalDebits = 0;
    let numCredits = 0;
    let numDebits = 0;
    for (const tx of list) {
      if (tx.direction === "CRDT") {
        totalCredits += tx.amount;
        numCredits += 1;
      } else {
        totalDebits += tx.amount;
        numDebits += 1;
      }
    }
    const closing = last.accountBalance;
    const firstDelta = first.direction === "CRDT" ? first.amount : -first.amount;
    const opening = round2(first.accountBalance - firstDelta);

    days.push({
      date,
      openingBalance: opening,
      closingBalance: round2(closing),
      transactions: list,
      totalCredits: round2(totalCredits),
      totalDebits: round2(totalDebits),
      numCredits,
      numDebits,
    });
  }
  return days;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
