// Smoke test: run the real CSV through parser+validator+builder and print output.
// Run with: node --experimental-strip-types scripts/smoke-test.mjs (Node 22.6+)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const { parseCsv, rowsToTransactions } = await import("../src/parser.ts");
const { groupByDay } = await import("../src/grouper.ts");
const { validate } = await import("../src/validator.ts");
const { buildXmls } = await import("../src/builder.ts");

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
