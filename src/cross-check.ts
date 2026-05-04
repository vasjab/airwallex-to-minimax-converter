import type {
  CrossCheckResult,
  CrossCheckRow,
  PdfSummary,
  ValidationResult,
  WalletConfig,
} from "./types";

const EPSILON = 0.005;

export function crossCheckPdf(
  pdf: PdfSummary,
  csv: ValidationResult,
  wallet: WalletConfig,
): CrossCheckResult {
  const rows: CrossCheckRow[] = [];
  const ccy = pdf.currency || wallet.currency;

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
    rows.push(amountRow("Total credits", pdf.totalDeposits, csv.totalCredits, ccy));
  }
  if (pdf.totalPayouts !== undefined) {
    rows.push(amountRow("Total debits", pdf.totalPayouts, csv.totalDebits, ccy));
  }
  if (pdf.startingBalance !== undefined) {
    rows.push(amountRow("Start balance", pdf.startingBalance, csv.startBalance, ccy));
  }
  if (pdf.endingBalance !== undefined) {
    rows.push(amountRow("End balance", pdf.endingBalance, csv.endBalance, ccy));
  }
  if (pdf.periodStart || pdf.periodEnd) {
    rows.push({
      field: "Period",
      pdf: `${pdf.periodStart ?? "?"} → ${pdf.periodEnd ?? "?"}`,
      csv: undefined,
      level: "info",
      note: "Reference only — CSV may not span the full PDF period.",
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
): CrossCheckRow {
  const match = Math.abs(pdfVal - csvVal) < EPSILON;
  return {
    field,
    pdf: `${pdfVal.toFixed(2)} ${ccy}`,
    csv: `${csvVal.toFixed(2)} ${ccy}`,
    level: match ? "match" : "mismatch",
    note: match
      ? undefined
      : `Diff ${(csvVal - pdfVal).toFixed(2)} ${ccy}.`,
  };
}

function fmt(n?: number): string {
  return n === undefined ? "?" : n.toFixed(2);
}
