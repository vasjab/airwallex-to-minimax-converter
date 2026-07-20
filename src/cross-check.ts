import type {
  CrossCheckResult,
  CrossCheckRow,
  PdfSummary,
  Transaction,
  ValidationResult,
  WalletConfig,
} from "./types";

const EPSILON = 0.005;

/**
 * Totals for just the slice of the CSV that falls inside the PDF's period.
 * The PDF reports one window; a Balance Activity Report export rarely covers
 * exactly the same one, so comparing whole-CSV totals against it flags every
 * amount red purely because the date ranges differ. Returns null when the CSV
 * has nothing in the window (then we fall back to whole-CSV totals).
 */
function windowedTotals(
  txs: Transaction[],
  from?: string,
  to?: string,
): { credits: number; debits: number; start: number; end: number; first: string; last: string } | null {
  const inWindow = txs.filter(
    (t) => (!from || t.bookingDate >= from) && (!to || t.bookingDate <= to),
  );
  if (inWindow.length === 0) return null;

  let credits = 0;
  let debits = 0;
  for (const t of inWindow) {
    if (t.direction === "CRDT") credits += t.amount;
    else debits += t.amount;
  }
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const firstDelta = first.direction === "CRDT" ? first.amount : -first.amount;
  return {
    credits: round2(credits),
    debits: round2(debits),
    start: round2(first.accountBalance - firstDelta),
    end: last.accountBalance,
    first: first.bookingDate,
    last: last.bookingDate,
  };
}

export function crossCheckPdf(
  pdf: PdfSummary,
  csv: ValidationResult,
  wallet: WalletConfig,
  txs?: Transaction[],
  /** Booking-date span of the whole export, across every currency. */
  csvSpan?: { first: string; last: string },
): CrossCheckResult {
  const rows: CrossCheckRow[] = [];
  const ccy = pdf.currency || wallet.currency;

  const win =
    txs && (pdf.periodStart || pdf.periodEnd)
      ? windowedTotals(txs, pdf.periodStart, pdf.periodEnd)
      : null;
  // Compare like for like when we can; otherwise fall back to whole-CSV totals.
  const cmp = win
    ? { credits: win.credits, debits: win.debits, start: win.start, end: win.end }
    : {
        credits: csv.totalCredits,
        debits: csv.totalDebits,
        start: csv.startBalance,
        end: csv.endBalance,
      };
  // Judge coverage from the whole export, not this one wallet: a currency with
  // no activity until mid-period is perfectly normal and must not read as a
  // short export. Even this is a lower bound — the CSV carries no header
  // saying which window was requested — so it only ever annotates a diff, and
  // never becomes a verdict of its own.
  const shortStart = csvSpan && pdf.periodStart && csvSpan.first > pdf.periodStart;
  const shortEnd = csvSpan && pdf.periodEnd && csvSpan.last < pdf.periodEnd;
  const coverageNote =
    shortStart || shortEnd
      ? `Export only reaches ${csvSpan!.first} → ${csvSpan!.last}, inside the PDF's ${pdf.periodStart ?? "?"} → ${pdf.periodEnd ?? "?"} — the gap likely explains this diff. Re-export the CSV over the PDF's period to compare cleanly.`
      : undefined;

  if (pdf.iban) {
    rows.push({
      field: "IBAN",
      pdf: pdf.iban,
      csv: wallet.iban || "(none)",
      level: pdf.iban === wallet.iban ? "match" : "mismatch",
      note:
        pdf.iban !== wallet.iban
          ? "Wallet IBAN doesn't match PDF — update wallet settings."
          : undefined,
    });
  }

  if (pdf.currency) {
    rows.push({
      field: "Currency",
      pdf: pdf.currency,
      csv: wallet.currency || "(none)",
      level: pdf.currency === wallet.currency ? "match" : "mismatch",
    });
  }

  if (pdf.totalDeposits !== undefined) {
    rows.push(amountRow("Total credits", pdf.totalDeposits, cmp.credits, ccy, coverageNote));
  }
  if (pdf.totalPayouts !== undefined) {
    rows.push(amountRow("Total debits", pdf.totalPayouts, cmp.debits, ccy, coverageNote));
  }
  if (pdf.startingBalance !== undefined) {
    rows.push(amountRow("Start balance", pdf.startingBalance, cmp.start, ccy, coverageNote));
  }
  if (pdf.endingBalance !== undefined) {
    rows.push(amountRow("End balance", pdf.endingBalance, cmp.end, ccy, coverageNote));
  }
  if (pdf.periodStart || pdf.periodEnd) {
    rows.push({
      field: "Period",
      pdf: `${pdf.periodStart ?? "?"} → ${pdf.periodEnd ?? "?"}`,
      csv: win ? `${win.first} → ${win.last}` : "(whole CSV)",
      level: "info",
      note: coverageNote
        ?? (win
          ? "CSV totals below cover only this period."
          : "Reference only — CSV may not span the full PDF period."),
    });
  }
  if (pdf.minBalance !== undefined || pdf.maxBalance !== undefined) {
    rows.push({
      field: "Balance range",
      pdf: `${fmt(pdf.minBalance)} → ${fmt(pdf.maxBalance)} ${ccy}`,
      csv: undefined,
      level: "info",
    });
  }

  const ok = !rows.some((r) => r.level === "mismatch");
  return { ok, rows, summary: pdf };
}

function amountRow(
  field: string,
  pdfVal: number,
  csvVal: number,
  ccy: string,
  coverageNote?: string,
): CrossCheckRow {
  const match = Math.abs(pdfVal - csvVal) < EPSILON;
  const diff = `Diff ${(csvVal - pdfVal).toFixed(2)} ${ccy}.`;
  return {
    field,
    pdf: `${pdfVal.toFixed(2)} ${ccy}`,
    csv: `${csvVal.toFixed(2)} ${ccy}`,
    level: match ? "match" : "mismatch",
    note: match ? undefined : coverageNote ? `${diff} ${coverageNote}` : diff,
  };
}

function fmt(n?: number): string {
  return n === undefined ? "?" : n.toFixed(2);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
