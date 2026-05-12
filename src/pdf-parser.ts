import type { PdfSummary } from "./types";

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function getPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = await import("pdfjs-dist");
      const workerUrl = (
        await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
      ).default;
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    })();
  }
  return pdfjsPromise;
}

export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await getPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "),
    );
  }
  return parts.join("\n");
}

export async function parseAirwallexPdf(file: File): Promise<PdfSummary> {
  const text = await extractPdfText(file);
  return summarize(text, file.name);
}

export function summarize(text: string, filename?: string): PdfSummary {
  const norm = text.replace(/\s+/g, " ");

  const ibanBankMatch = norm.match(
    /IBAN:\s*([A-Z]{2}[A-Z0-9]{12,30})\s+(.+?)\s+([A-Z]{3})\s+Account\s+Summary/,
  );
  const ibanMatch = ibanBankMatch ?? norm.match(/IBAN:\s*([A-Z]{2}[A-Z0-9]{12,30})/);
  const startMatch = norm.match(
    /Starting balance on ([A-Z][a-z]+ \d{1,2} \d{4})\s*([\d,]+\.\d{2})\s*([A-Z]{3})/,
  );
  const endMatch = norm.match(
    /Ending balance on ([A-Z][a-z]+ \d{1,2} \d{4})\s*([\d,]+\.\d{2})\s*([A-Z]{3})/,
  );
  const totalDepMatch = norm.match(
    /Total deposits and other additions\s*([\d,]+\.\d{2})\s*([A-Z]{3})/,
  );
  const totalPayMatch = norm.match(
    /Total payouts and other subtractions\s*([\d,]+\.\d{2})\s*([A-Z]{3})/,
  );
  const minMatch = norm.match(/Minimum balance\s*([\d,]+\.\d{2})\s*([A-Z]{3})/);
  const maxMatch = norm.match(/Maximum balance\s*([\d,]+\.\d{2})\s*([A-Z]{3})/);
  const ccyHeader = norm.match(
    /\b(EUR|USD|GBP|CAD|AUD|CHF|JPY|HKD|SGD|NZD|SEK|NOK|DKK|PLN)\s+Account\s+(?:Summary|Activity)/,
  );

  const summary: PdfSummary = {
    filename,
    rawTextLength: text.length,
    fieldsFound: 0,
  };

  if (ibanMatch) {
    summary.iban = ibanMatch[1];
    summary.fieldsFound += 1;
  }
  if (ibanBankMatch) {
    summary.bankName = ibanBankMatch[2].trim();
    summary.currency = summary.currency || ibanBankMatch[3];
    summary.fieldsFound += 1;
  }
  if (ccyHeader) {
    summary.currency = ccyHeader[1];
    summary.fieldsFound += 1;
  }
  if (startMatch) {
    summary.startingBalance = num(startMatch[2]);
    summary.periodStart = parseUSDate(startMatch[1]);
    summary.currency = summary.currency || startMatch[3];
    summary.fieldsFound += 2;
  }
  if (endMatch) {
    summary.endingBalance = num(endMatch[2]);
    summary.periodEnd = parseUSDate(endMatch[1]);
    summary.currency = summary.currency || endMatch[3];
    summary.fieldsFound += 2;
  }
  if (totalDepMatch) {
    summary.totalDeposits = num(totalDepMatch[1]);
    summary.fieldsFound += 1;
  }
  if (totalPayMatch) {
    summary.totalPayouts = num(totalPayMatch[1]);
    summary.fieldsFound += 1;
  }
  if (minMatch) {
    summary.minBalance = num(minMatch[1]);
    summary.fieldsFound += 1;
  }
  if (maxMatch) {
    summary.maxBalance = num(maxMatch[1]);
    summary.fieldsFound += 1;
  }
  return summary;
}

function num(s: string): number {
  return Number(s.replace(/,/g, ""));
}

function parseUSDate(s: string): string {
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m = s.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/);
  if (!m) return s;
  const month = months[m[1].toLowerCase()];
  if (!month) return s;
  return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
}
