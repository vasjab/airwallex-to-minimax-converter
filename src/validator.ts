import type { DailyStatement, Transaction, ValidationIssue, ValidationResult } from "./types";

const EPSILON = 0.005;

export function validate(txs: Transaction[], days: DailyStatement[]): ValidationResult {
  const issues: ValidationIssue[] = [];

  let totalCredits = 0;
  let totalDebits = 0;
  for (const tx of txs) {
    if (tx.direction === "CRDT") totalCredits += tx.amount;
    else totalDebits += tx.amount;
  }
  totalCredits = round2(totalCredits);
  totalDebits = round2(totalDebits);

  let runningBalance: number | null = null;
  let firstTxBalance: number | null = null;
  let lastTxBalance: number | null = null;
  for (const tx of txs) {
    if (firstTxBalance === null) {
      const delta = tx.direction === "CRDT" ? tx.amount : -tx.amount;
      firstTxBalance = round2(tx.accountBalance - delta);
      runningBalance = firstTxBalance;
    }
    if (runningBalance === null) continue;
    const delta = tx.direction === "CRDT" ? tx.amount : -tx.amount;
    runningBalance = round2(runningBalance + delta);
    if (Math.abs(runningBalance - tx.accountBalance) > EPSILON) {
      issues.push({
        level: "error",
        message: `Balance walk mismatch at tx ${tx.txId}: expected ${runningBalance.toFixed(2)}, CSV says ${tx.accountBalance.toFixed(2)}`,
        context: tx.bookingTime,
      });
    }
    lastTxBalance = tx.accountBalance;
  }

  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1];
    const cur = days[i];
    if (Math.abs(prev.closingBalance - cur.openingBalance) > EPSILON) {
      issues.push({
        level: "error",
        message: `Day boundary mismatch: ${prev.date} closes at ${prev.closingBalance.toFixed(2)} but ${cur.date} opens at ${cur.openingBalance.toFixed(2)}`,
      });
    }
  }

  for (const day of days) {
    const expectedClose = round2(day.openingBalance + day.totalCredits - day.totalDebits);
    if (Math.abs(expectedClose - day.closingBalance) > EPSILON) {
      issues.push({
        level: "error",
        message: `Day ${day.date}: opening ${day.openingBalance.toFixed(2)} + credits ${day.totalCredits.toFixed(2)} - debits ${day.totalDebits.toFixed(2)} = ${expectedClose.toFixed(2)}, but closing balance is ${day.closingBalance.toFixed(2)}`,
      });
    }
  }

  const startBalance = firstTxBalance ?? 0;
  const endBalance = lastTxBalance ?? 0;
  const expectedEnd = round2(startBalance + totalCredits - totalDebits);
  if (Math.abs(expectedEnd - endBalance) > EPSILON) {
    issues.push({
      level: "error",
      message: `Period totals mismatch: ${startBalance.toFixed(2)} + ${totalCredits.toFixed(2)} - ${totalDebits.toFixed(2)} = ${expectedEnd.toFixed(2)}, expected end balance ${endBalance.toFixed(2)}`,
    });
  }

  return {
    ok: issues.filter((i) => i.level === "error").length === 0,
    issues,
    totalCredits,
    totalDebits,
    startBalance,
    endBalance,
    dayCount: days.length,
    txCount: txs.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
