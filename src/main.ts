import JSZip from "jszip";
import { parseCsv, rowsToTransactions } from "./parser";
import { groupByDay } from "./grouper";
import { validate } from "./validator";
import { buildXmls } from "./builder";
import { parseAirwallexPdf } from "./pdf-parser";
import { crossCheckPdf } from "./cross-check";
import {
  loadWallets,
  saveWallets,
  loadPrefs,
  savePrefs,
  defaultWalletForCurrency,
} from "./settings";
import type {
  CrossCheckResult,
  PdfSummary,
  Transaction,
  ValidationResult,
  WalletConfig,
} from "./types";

interface AppState {
  csv: { name: string; text: string } | null;
  txs: Transaction[];
  validation: ValidationResult | null;
  detectedCurrency: string;
  pdf: PdfSummary | null;
  crossCheck: CrossCheckResult | null;
}

const state: AppState = {
  csv: null,
  txs: [],
  validation: null,
  detectedCurrency: "EUR",
  pdf: null,
  crossCheck: null,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fields = {
  ccy: $<HTMLInputElement>("f-ccy"),
  iban: $<HTMLInputElement>("f-iban"),
  bic: $<HTMLInputElement>("f-bic"),
  bank: $<HTMLInputElement>("f-bank"),
  owner: $<HTMLInputElement>("f-owner"),
  taxid: $<HTMLInputElement>("f-taxid"),
  ctry: $<HTMLInputElement>("f-ctry"),
  addr1: $<HTMLInputElement>("f-addr1"),
  addr2: $<HTMLInputElement>("f-addr2"),
  perDay: $<HTMLInputElement>("f-perday"),
  file: $<HTMLInputElement>("f-file"),
  pdf: $<HTMLInputElement>("f-pdf"),
};

const drop = $<HTMLLabelElement>("drop");
const dropPdf = $<HTMLLabelElement>("drop-pdf");
const fileInfo = $<HTMLDivElement>("file-info");
const pdfInfo = $<HTMLDivElement>("pdf-info");
const previewCard = $<HTMLDivElement>("preview-card");
const actionCard = $<HTMLDivElement>("action-card");
const summary = $<HTMLDivElement>("summary");
const issuesEl = $<HTMLDivElement>("issues");
const crossCheckEl = $<HTMLDivElement>("crosscheck");
const dayTable = $<HTMLDivElement>("day-table");
const generateBtn = $<HTMLButtonElement>("generate");
const genStatus = $<HTMLParagraphElement>("gen-status");
const resetBtn = $<HTMLButtonElement>("reset-wallet");

function init(): void {
  const prefs = loadPrefs();
  fields.perDay.checked = prefs.perDay;
  loadWalletIntoForm(currentWallet());

  fields.perDay.addEventListener("change", () => {
    savePrefs({ perDay: fields.perDay.checked });
  });

  for (const key of ["ccy", "iban", "bic", "bank", "owner", "taxid", "ctry", "addr1", "addr2"] as const) {
    fields[key].addEventListener("input", saveCurrentWallet);
  }

  resetBtn.addEventListener("click", () => {
    const ccy = fields.ccy.value || state.detectedCurrency || "EUR";
    loadWalletIntoForm(defaultWalletForCurrency(ccy));
    saveCurrentWallet();
  });

  fields.file.addEventListener("change", () => {
    const f = fields.file.files?.[0];
    if (f) handleCsvFile(f);
  });
  fields.pdf.addEventListener("change", () => {
    const f = fields.pdf.files?.[0];
    if (f) void handlePdfFile(f);
  });

  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f) handleCsvFile(f);
  });

  dropPdf.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropPdf.classList.add("dragover");
  });
  dropPdf.addEventListener("dragleave", () => dropPdf.classList.remove("dragover"));
  dropPdf.addEventListener("drop", (e) => {
    e.preventDefault();
    dropPdf.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f) void handlePdfFile(f);
  });

  generateBtn.addEventListener("click", () => {
    void generate();
  });
}

function currentWallet(): WalletConfig {
  const wallets = loadWallets();
  const ccy = state.detectedCurrency || "EUR";
  return wallets[ccy] ?? defaultWalletForCurrency(ccy);
}

function loadWalletIntoForm(w: WalletConfig): void {
  fields.ccy.value = w.currency;
  fields.iban.value = w.iban;
  fields.bic.value = w.bic;
  fields.bank.value = w.bankName;
  fields.owner.value = w.ownerName;
  fields.taxid.value = w.ownerTaxId;
  fields.ctry.value = w.ownerCountry;
  fields.addr1.value = w.ownerAddressLine1;
  fields.addr2.value = w.ownerAddressLine2;
}

function readWalletFromForm(): WalletConfig {
  return {
    currency: fields.ccy.value.trim().toUpperCase(),
    iban: fields.iban.value.trim().replace(/\s+/g, ""),
    bic: fields.bic.value.trim().toUpperCase(),
    bankName: fields.bank.value.trim(),
    ownerName: fields.owner.value.trim(),
    ownerTaxId: fields.taxid.value.trim(),
    ownerCountry: fields.ctry.value.trim().toUpperCase(),
    ownerAddressLine1: fields.addr1.value.trim(),
    ownerAddressLine2: fields.addr2.value.trim(),
  };
}

function saveCurrentWallet(): void {
  const w = readWalletFromForm();
  if (!w.currency) return;
  const wallets = loadWallets();
  wallets[w.currency] = w;
  saveWallets(wallets);
}

async function handleCsvFile(file: File): Promise<void> {
  fileInfo.textContent = `${file.name} — ${(file.size / 1024).toFixed(1)} KB`;
  fileInfo.classList.remove("hidden");
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    showError(`Could not read file: ${(e as Error).message}`);
    return;
  }
  state.csv = { name: file.name, text };
  parseAndPreview();
}

async function handlePdfFile(file: File): Promise<void> {
  pdfInfo.textContent = `${file.name} — ${(file.size / 1024).toFixed(1)} KB · parsing…`;
  pdfInfo.classList.remove("hidden");
  dropPdf.classList.remove("has-file");
  try {
    const summary = await parseAirwallexPdf(file);
    state.pdf = summary;
    pdfInfo.textContent = `${file.name} — ${summary.fieldsFound} fields extracted`;
    dropPdf.classList.add("has-file");
    if (state.validation) {
      runCrossCheck();
    }
  } catch (e) {
    state.pdf = null;
    state.crossCheck = null;
    pdfInfo.textContent = `${file.name} — parse failed: ${(e as Error).message}`;
    crossCheckEl.classList.add("hidden");
  }
}

function runCrossCheck(): void {
  if (!state.pdf || !state.validation) return;
  const wallet = readWalletFromForm();
  state.crossCheck = crossCheckPdf(state.pdf, state.validation, wallet);
  renderCrossCheck();
}

function renderCrossCheck(): void {
  if (!state.crossCheck) {
    crossCheckEl.classList.add("hidden");
    return;
  }
  const cc = state.crossCheck;
  const filename = cc.summary.filename ?? "PDF";
  const status = cc.ok ? "All match" : "Mismatch";
  const statusClass = cc.ok ? "ok" : "err";
  const rows = cc.rows
    .map((r) => {
      const icon = r.level === "match" ? "✓" : r.level === "mismatch" ? "✗" : "·";
      const note = r.note ? `<span class="note">${escapeHtml(r.note)}</span>` : "";
      return `<tr class="${r.level}">
        <td class="icon">${icon}</td>
        <td>${escapeHtml(r.field)}${note}</td>
        <td class="amt">${escapeHtml(r.pdf ?? "")}</td>
        <td class="amt">${escapeHtml(r.csv ?? "")}</td>
      </tr>`;
    })
    .join("");
  crossCheckEl.innerHTML = `<div class="crosscheck">
    <div class="crosscheck-head">
      <span>PDF cross-check · ${escapeHtml(filename)}</span>
      <span class="crosscheck-status ${statusClass}">${status}</span>
    </div>
    <table>
      <thead><tr>
        <th></th><th>Field</th><th class="amt">PDF</th><th class="amt">CSV / wallet</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  crossCheckEl.classList.remove("hidden");
}

function parseAndPreview(): void {
  if (!state.csv) return;
  let txs: Transaction[];
  try {
    const rows = parseCsv(state.csv.text);
    txs = rowsToTransactions(rows);
  } catch (e) {
    showError(`Parse failed: ${(e as Error).message}`);
    return;
  }

  if (txs.length === 0) {
    showError("No transactions found in CSV.");
    return;
  }

  const detected = txs.find((t) => t.currency)?.currency ?? "EUR";
  if (detected !== state.detectedCurrency) {
    state.detectedCurrency = detected;
    const wallets = loadWallets();
    const wallet = wallets[detected] ?? defaultWalletForCurrency(detected);
    loadWalletIntoForm(wallet);
  }

  const days = groupByDay(txs);
  const validation = validate(txs, days);

  state.txs = txs;
  state.validation = validation;

  renderSummary(validation);
  renderIssues(validation);
  renderDayTable(days);
  if (state.pdf) {
    runCrossCheck();
  } else {
    crossCheckEl.classList.add("hidden");
  }
  previewCard.classList.remove("hidden");
  actionCard.classList.remove("hidden");
  genStatus.textContent = "";
}

function renderSummary(v: ValidationResult): void {
  const ccy = state.detectedCurrency;
  summary.innerHTML = `
    <div class="kpi"><div class="k">Transactions</div><div class="v">${v.txCount}</div></div>
    <div class="kpi"><div class="k">Days</div><div class="v">${v.dayCount}</div></div>
    <div class="kpi"><div class="k">Total credits ${ccy}</div><div class="v">${v.totalCredits.toFixed(2)}</div></div>
    <div class="kpi"><div class="k">Total debits ${ccy}</div><div class="v">${v.totalDebits.toFixed(2)}</div></div>
    <div class="kpi"><div class="k">Start balance</div><div class="v">${v.startBalance.toFixed(2)}</div></div>
    <div class="kpi"><div class="k">End balance</div><div class="v">${v.endBalance.toFixed(2)}</div></div>
    <div class="kpi ${v.ok ? "ok" : "err"}"><div class="k">Validation</div><div class="v">${v.ok ? "PASS" : "FAIL"}</div></div>
    <div class="kpi"><div class="k">Issues</div><div class="v">${v.issues.length}</div></div>
  `;
}

function renderIssues(v: ValidationResult): void {
  if (v.issues.length === 0) {
    issuesEl.innerHTML = `<div class="issue info">All balance walks check out. Cross-check totals against the Airwallex PDF before importing.</div>`;
    return;
  }
  issuesEl.innerHTML = v.issues
    .map((i) => `<div class="issue ${i.level}">${escapeHtml(i.message)}${i.context ? ` <small>(${escapeHtml(i.context)})</small>` : ""}</div>`)
    .join("");
}

function renderDayTable(days: ReturnType<typeof groupByDay>): void {
  const ccy = state.detectedCurrency;
  const rows = days
    .map(
      (d) => `<tr>
        <td>${d.date}</td>
        <td>${d.transactions.length}</td>
        <td>${d.numCredits}</td>
        <td>${d.numDebits}</td>
        <td>${d.totalCredits.toFixed(2)}</td>
        <td>${d.totalDebits.toFixed(2)}</td>
        <td>${d.openingBalance.toFixed(2)}</td>
        <td>${d.closingBalance.toFixed(2)}</td>
      </tr>`,
    )
    .join("");
  dayTable.innerHTML = `<table>
    <thead><tr>
      <th>Date</th><th>#</th><th>Cr</th><th>Dr</th>
      <th>Credits ${ccy}</th><th>Debits ${ccy}</th>
      <th>Open</th><th>Close</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function generate(): Promise<void> {
  if (state.txs.length === 0) return;
  const wallet = readWalletFromForm();
  const missing = walletProblems(wallet);
  if (missing.length > 0) {
    genStatus.textContent = `Fill in: ${missing.join(", ")}`;
    return;
  }
  saveCurrentWallet();

  const xmls = buildXmls(state.txs, { perDay: fields.perDay.checked, wallet });
  if (xmls.length === 0) {
    genStatus.textContent = "Nothing to generate.";
    return;
  }

  if (xmls.length === 1 && fields.perDay.checked === false) {
    triggerDownload(xmls[0].xml, xmls[0].filename, "application/xml");
    genStatus.textContent = `Downloaded ${xmls[0].filename}.`;
    return;
  }

  if (xmls.length === 1) {
    triggerDownload(xmls[0].xml, xmls[0].filename, "application/xml");
    genStatus.textContent = `Downloaded ${xmls[0].filename}.`;
    return;
  }

  const zip = new JSZip();
  for (const x of xmls) zip.file(x.filename, x.xml);
  const blob = await zip.generateAsync({ type: "blob" });
  const zipName = `airwallex-camt053-${xmls[0].date}_to_${xmls[xmls.length - 1].date}.zip`;
  triggerBlob(blob, zipName);
  genStatus.textContent = `Downloaded ${zipName} (${xmls.length} files).`;
}

function walletProblems(w: WalletConfig): string[] {
  const m: string[] = [];
  if (!w.currency) m.push("currency");
  if (!w.iban) m.push("IBAN");
  if (!w.bic) m.push("BIC");
  if (!w.ownerName) m.push("owner");
  if (!w.ownerTaxId) m.push("tax ID");
  return m;
}

function triggerDownload(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  triggerBlob(blob, filename);
}

function triggerBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showError(msg: string): void {
  previewCard.classList.remove("hidden");
  summary.innerHTML = "";
  issuesEl.innerHTML = `<div class="issue error">${escapeHtml(msg)}</div>`;
  dayTable.innerHTML = "";
  actionCard.classList.add("hidden");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

init();
