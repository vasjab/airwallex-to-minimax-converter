// Smoke test: run the real CSV through parser+validator+builder and print output.
// Run with: node --experimental-strip-types scripts/smoke-test.mjs (Node 22.6+)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const { parseCsv, rowsToTransactions } = await import("../src/parser.ts");
const { groupByDay } = await import("../src/grouper.ts");
const { validate } = await import("../src/validator.ts");
const { buildXmls } = await import("../src/builder.ts");
const { summarize } = await import("../src/pdf-parser.ts");
const { crossCheckPdf } = await import("../src/cross-check.ts");
const { CustomerMatcher, parseCustomerJson } = await import("../src/customer-matcher.ts");

const CSV_PATH = "/Users/vbocko/Downloads/Balance_Activity_Report_2026-04-30 (1).csv";
const csv = readFileSync(CSV_PATH, "utf8");
const rows = parseCsv(csv);
console.log(`Parsed ${rows.length} CSV rows`);

const txs = rowsToTransactions(rows);
console.log(`→ ${txs.length} transactions`);

const days = groupByDay(txs);
console.log(`→ ${days.length} days: ${days.map((d) => d.date).join(", ")}`);

const v = validate(txs, days);
console.log(`Validation: ${v.ok ? "PASS" : "FAIL"}`);
console.log(`  txCount=${v.txCount} dayCount=${v.dayCount}`);
console.log(`  startBal=${v.startBalance.toFixed(2)} endBal=${v.endBalance.toFixed(2)}`);
console.log(`  credits=${v.totalCredits.toFixed(2)} debits=${v.totalDebits.toFixed(2)}`);
for (const i of v.issues) console.log(`  [${i.level}] ${i.message}`);

const wallet = {
  currency: "EUR",
  iban: "NL71AINH2467531516",
  bic: "AIPBNL2AXXX",
  bankName: "Airwallex (Netherlands) B.V.",
  ownerName: "Alpine Nation d.o.o.",
  ownerAddressLine1: "Gabrščkova ulica 24",
  ownerAddressLine2: "1000 Ljubljana",
  ownerCountry: "SI",
  ownerTaxId: "11414928",
};

// Customer matching
try {
  const customerJson = readFileSync("data/customers.json", "utf8");
  const customers = parseCustomerJson(customerJson);
  const matcher = new CustomerMatcher(customers);
  console.log(`\nCustomer DB: ${customers.length} records`);
  const seen = new Set();
  let matchedCount = 0;
  let unmatchedCount = 0;
  const ownerName = wallet.ownerName.trim().toLowerCase();
  for (const tx of txs) {
    const key = (tx.counterpartyName || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (key === ownerName) {
      console.log(`  ⊘ ${tx.counterpartyName} (self — skipped)`);
      continue;
    }
    const r = matcher.match(tx.counterpartyName);
    if (r.matched) {
      matchedCount++;
      console.log(`  ✓ [${r.confidence}] ${tx.counterpartyName} → ${r.customer.name} (TaxID ${r.customer.taxNumber})`);
    } else {
      unmatchedCount++;
      console.log(`  · ${tx.counterpartyName} — no match`);
    }
  }
  for (const tx of txs) {
    if ((tx.counterpartyName || "").toLowerCase() === ownerName) continue;
    const r = matcher.match(tx.counterpartyName);
    if (r.matched) { tx.matchedCustomer = r.customer; tx.matchConfidence = r.confidence; }
  }
  console.log(`\n  Total: ${matchedCount} matched, ${unmatchedCount} unmatched (unique counterparties)`);
} catch (e) {
  console.log(`\nCustomer DB not available: ${e.message}`);
}

mkdirSync(".smoke/out", { recursive: true });

const perDay = buildXmls(txs, { perDay: true, wallet });
console.log(`\nPer-day mode: ${perDay.length} files`);
for (const x of perDay) {
  const path = `.smoke/out/${x.filename}`;
  writeFileSync(path, x.xml);
  console.log(`  wrote ${path} (${x.xml.length} bytes)`);
}

const single = buildXmls(txs, { perDay: false, wallet });
console.log(`\nSingle-file mode: ${single.length} file`);
writeFileSync(`.smoke/out/${single[0].filename}`, single[0].xml);
console.log(`  wrote .smoke/out/${single[0].filename} (${single[0].xml.length} bytes)`);

const expectedCredits = 30000.00;
const expectedDebits = 16998.33;
const expectedEnd = 13001.67;
console.log(`\nPDF cross-check:`);
console.log(`  credits ${v.totalCredits.toFixed(2)} vs PDF ${expectedCredits.toFixed(2)} → ${Math.abs(v.totalCredits - expectedCredits) < 0.01 ? "MATCH" : "MISMATCH"}`);
console.log(`  debits  ${v.totalDebits.toFixed(2)} vs PDF ${expectedDebits.toFixed(2)} → ${Math.abs(v.totalDebits - expectedDebits) < 0.01 ? "MATCH" : "MISMATCH"}`);
console.log(`  endBal  ${v.endBalance.toFixed(2)} vs PDF ${expectedEnd.toFixed(2)} → ${Math.abs(v.endBalance - expectedEnd) < 0.01 ? "MATCH" : "MISMATCH"}`);

console.log(`\nSample transaction parses:`);
for (const tx of txs.slice(0, 5)) {
  console.log(`  ${tx.bookingDate} ${tx.direction} ${tx.amount.toFixed(2)} | name="${tx.counterpartyName}" iban="${tx.counterpartyIban}" extRef="${tx.externalRef}" intRef="${tx.internalRef}"`);
}

// Test PDF parsing using the static text we know is in the April PDF
console.log(`\n=== PDF cross-check ===`);
const knownPdfText = `
Account Holder
Alpine Nation d.o.o.
Gabrsckova ulica 24, Ljubljana, OSREDNJESLOVENSKA
1000, SI
Account Details
IBAN: NL71AINH2467531516
Airwallex (Netherlands) B.V.
EUR Account Summary
Starting balance on Apr 01 20260.00 EURMinimum balance0.00 EUR
Total deposits and other additions30,000.00 EURMaximum balance15,393.52 EUR
Total payouts and other subtractions16,998.33 EUR
Ending balance on Apr 30 202613,001.67 EUR
EUR Account Activity Apr 01 2026 to Apr 30 2026
`;
const pdfSummary = summarize(knownPdfText, "Account_Statement_EUR_2026-04-01-2026-04-30.pdf");
console.log("Extracted from PDF:");
for (const [k, v] of Object.entries(pdfSummary)) {
  console.log(`  ${k}: ${typeof v === "number" ? v.toFixed(2) : v}`);
}

console.log("\nCross-check:");
const cc = crossCheckPdf(pdfSummary, v, wallet);
console.log(`  Result: ${cc.ok ? "OK" : "MISMATCH"}`);
for (const r of cc.rows) {
  const sym = r.level === "match" ? "✓" : r.level === "mismatch" ? "✗" : "·";
  console.log(`  ${sym} ${r.field}: PDF=${r.pdf ?? "-"} | CSV=${r.csv ?? "-"}${r.note ? ` (${r.note})` : ""}`);
}
