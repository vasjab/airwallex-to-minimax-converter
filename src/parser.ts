import type { Direction, RawCsvRow, Transaction } from "./types";
import { parseDescription } from "./description-parser";

export function parseCsv(text: string): RawCsvRow[] {
  const cleaned = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cur.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && cleaned[i + 1] === "\n") i++;
      cur.push(field);
      field = "";
      if (cur.length > 1 || cur[0] !== "") rows.push(cur);
      cur = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    if (cur.length > 1 || cur[0] !== "") rows.push(cur);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: RawCsvRow = {};
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] ?? "").trim();
    });
    return obj;
  });
}

function parseAmount(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === "-") return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new Error(`Cannot parse amount: "${s}"`);
  }
  return n;
}

function pickDate(time: string): string {
  const idx = time.indexOf("T");
  return idx > 0 ? time.slice(0, idx) : time;
}

/** Available-balance holds, not ledger movements — see rowsToTransactions. */
function isHold(finTxType: string): boolean {
  return (
    finTxType.startsWith("CARD_AUTHORISATION") ||
    finTxType === "CONVERSION_RESERVE" ||
    finTxType === "CONVERSION_RELEASE"
  );
}

export function rowsToTransactions(rows: RawCsvRow[]): Transaction[] {
  const txs: Transaction[] = [];
  for (const row of rows) {
    // Holds move the Available Balance only — Account Balance, the actual
    // ledger, does not budge until the settling row lands (CARD_PURCHASE /
    // CARD_REFUND for cards, CONVERSION_SELL / CONVERSION_BUY for FX). The
    // hold amount can also differ from the settled amount. Counting them
    // double-books every conversion and breaks the balance walk, and the
    // official Account Statement PDF omits them entirely.
    const finTxType = (row["Financial Transaction Type"] ?? "").toUpperCase();
    if (isHold(finTxType)) continue;

    const debit = parseAmount(row["Debit Net Amount"] ?? "");
    const credit = parseAmount(row["Credit Net Amount"] ?? "");
    let direction: Direction;
    let amount: number;
    if (credit > 0 && debit === 0) {
      direction = "CRDT";
      amount = credit;
    } else if (debit > 0 && credit === 0) {
      direction = "DBIT";
      amount = debit;
    } else if (credit === 0 && debit === 0) {
      const fallback = parseAmount(row["Amount"] ?? "");
      if (fallback === 0) continue;
      direction = (row["Type"] ?? "").toUpperCase() === "DEPOSIT" ? "CRDT" : "DBIT";
      amount = fallback;
    } else {
      throw new Error(
        `Row has both debit and credit values: txId=${row["Transaction Id"]}`,
      );
    }

    const time = row["Time"] ?? "";
    const date = pickDate(time);
    const description = row["Description"] ?? "";
    const parsed = parseDescription(description, direction);

    txs.push({
      txId: row["Transaction Id"] ?? "",
      bookingDate: date,
      valueDate: date,
      bookingTime: time,
      type: row["Type"] ?? "",
      finTxType: row["Financial Transaction Type"] ?? "",
      direction,
      amount,
      fee: parseAmount(row["Fee"] ?? ""),
      currency: row["Wallet Currency"] ?? "",
      accountBalance: parseAmount(row["Account Balance"] ?? ""),
      description,
      reference: row["Reference"] ?? "",
      requestId: row["Request Id"] ?? "",
      noteToSelf: row["Note to Self"] ?? "",
      counterpartyName: parsed.name,
      counterpartyIban: parsed.iban,
      externalRef: parsed.externalRef || row["Reference"] || "",
      internalRef: parsed.internalRef,
      details: parsed.details,
    });
  }
  return txs;
}
