import JSZip from "jszip";
import { parseCsv, rowsToTransactions } from "./parser";
import { buildXmls } from "./builder";
import { splitByCurrency } from "./multi-wallet";
import { parseAirwallexPdf } from "./pdf-parser";
import { crossCheckPdf } from "./cross-check";
import { CustomerMatcher, parseCustomerJson } from "./customer-matcher";
import { parseCustomerXlsx } from "./customer-xlsx";
import {
  loadWallets,
  saveWallets,
  loadPrefs,
  savePrefs,
  defaultWalletForCurrency,
} from "./settings";
import type {
  CrossCheckResult,
  CustomerRecord,
  DailyStatement,
  PdfSummary,
  Transaction,
  ValidationResult,
  WalletConfig,
  WalletSection,
} from "./types";

const CUSTOMERS_KEY = "awx-minimax-customers-v1";

interface AppState {
  csv: { name: string; text: string } | null;
  sections: WalletSection[];
  pdfs: Map<string, PdfSummary>;
  pdfsByFilename: PdfSummary[];
  crossChecks: { currency: string; result: CrossCheckResult }[];
  pdfNotices: string[];
  matcher: CustomerMatcher | null;
  customerDbName: string | null;
  customerDbCount: number;
}

const state: AppState = {
  csv: null,
  sections: [],
  pdfs: new Map(),
  pdfsByFilename: [],
  crossChecks: [],
  pdfNotices: [],
  matcher: null,
  customerDbName: null,
  customerDbCount: 0,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fields = {
  owner: $<HTMLInputElement>("f-owner"),
  taxid: $<HTMLInputElement>("f-taxid"),
  ctry: $<HTMLInputElement>("f-ctry"),
  addr1: $<HTMLInputElement>("f-addr1"),
  addr2: $<HTMLInputElement>("f-addr2"),
  perDay: $<HTMLInputElement>("f-perday"),
  file: $<HTMLInputElement>("f-file"),
  pdf: $<HTMLInputElement>("f-pdf"),
  customers: $<HTMLInputElement>("f-customers"),
  addWalletCcy: $<HTMLInputElement>("add-wallet-ccy"),
  addWalletForm: $<HTMLFormElement>("add-wallet-form"),
};

const walletsListEl = $<HTMLDivElement>("wallets-list");

const drop = $<HTMLLabelElement>("drop");
const dropPdf = $<HTMLLabelElement>("drop-pdf");
const dropCustomers = $<HTMLLabelElement>("drop-customers");
const fileInfo = $<HTMLDivElement>("file-info");
const pdfInfo = $<HTMLDivElement>("pdf-info");
const customersInfo = $<HTMLDivElement>("customers-info");
const previewCard = $<HTMLDivElement>("preview-card");
const actionCard = $<HTMLDivElement>("action-card");
const sectionsEl = $<HTMLDivElement>("sections");
const crossCheckEl = $<HTMLDivElement>("crosscheck");
const matchStatusEl = $<HTMLDivElement>("match-status");
const generateBtn = $<HTMLButtonElement>("generate");
const genStatus = $<HTMLParagraphElement>("gen-status");

function init(): void {
  const prefs = loadPrefs();
  fields.perDay.checked = prefs.perDay;
  loadOwnerIntoForm();
  renderWallets();
  loadCachedCustomers();

  fields.perDay.addEventListener("change", () => {
    savePrefs({ perDay: fields.perDay.checked });
  });

  for (const key of ["owner", "taxid", "ctry", "addr1", "addr2"] as const) {
    fields[key].addEventListener("input", onOwnerFieldInput);
  }

  fields.addWalletForm.addEventListener("submit", (e) => {
    e.preventDefault();
    onAddWallet();
  });

  fields.file.addEventListener("change", () => {
    const f = fields.file.files?.[0];
    if (f) handleCsvFile(f);
  });
  fields.pdf.addEventListener("change", () => {
    const fs = fields.pdf.files;
    if (fs && fs.length > 0) void handlePdfFiles(Array.from(fs));
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
    const fs = e.dataTransfer?.files;
    if (fs && fs.length > 0) void handlePdfFiles(Array.from(fs));
  });

  fields.customers.addEventListener("change", () => {
    const f = fields.customers.files?.[0];
    if (f) void handleCustomersFile(f);
  });
  dropCustomers.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropCustomers.classList.add("dragover");
  });
  dropCustomers.addEventListener("dragleave", () => dropCustomers.classList.remove("dragover"));
  dropCustomers.addEventListener("drop", (e) => {
    e.preventDefault();
    dropCustomers.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f) void handleCustomersFile(f);
  });

  generateBtn.addEventListener("click", () => {
    void generate();
  });
}

interface OwnerInfo {
  ownerName: string;
  ownerTaxId: string;
  ownerCountry: string;
  ownerAddressLine1: string;
  ownerAddressLine2: string;
}

function readOwnerFromForm(): OwnerInfo {
  return {
    ownerName: fields.owner.value.trim(),
    ownerTaxId: fields.taxid.value.trim(),
    ownerCountry: fields.ctry.value.trim().toUpperCase(),
    ownerAddressLine1: fields.addr1.value.trim(),
    ownerAddressLine2: fields.addr2.value.trim(),
  };
}

function loadOwnerIntoForm(): void {
  const wallets = loadWallets();
  const sample = Object.values(wallets)[0] ?? defaultWalletForCurrency("EUR");
  fields.owner.value = sample.ownerName;
  fields.taxid.value = sample.ownerTaxId;
  fields.ctry.value = sample.ownerCountry;
  fields.addr1.value = sample.ownerAddressLine1;
  fields.addr2.value = sample.ownerAddressLine2;
}

function onOwnerFieldInput(): void {
  const owner = readOwnerFromForm();
  const wallets = loadWallets();
  const ccys = Object.keys(wallets);
  // Apply shared owner fields to every configured wallet
  for (const ccy of ccys) {
    wallets[ccy] = { ...wallets[ccy], ...owner };
  }
  // Make sure detected currencies exist too, so owner edits apply to them
  for (const s of state.sections) {
    if (!wallets[s.currency]) {
      wallets[s.currency] = { ...defaultWalletForCurrency(s.currency), ...owner };
    }
  }
  saveWallets(wallets);
}

function listWalletCurrencies(): string[] {
  const wallets = loadWallets();
  const set = new Set<string>([
    ...Object.keys(wallets),
    ...state.sections.map((s) => s.currency),
  ]);
  return [...set].filter(Boolean).sort();
}

function renderWallets(): void {
  const wallets = loadWallets();
  const detected = new Set(state.sections.map((s) => s.currency));
  const ccys = listWalletCurrencies();

  if (ccys.length === 0) {
    // Bootstrap with EUR default so the user always has at least one wallet visible
    wallets.EUR = wallets.EUR ?? defaultWalletForCurrency("EUR");
    saveWallets(wallets);
    return renderWallets();
  }

  walletsListEl.innerHTML = ccys.map((ccy) => {
    const w = wallets[ccy] ?? defaultWalletForCurrency(ccy);
    const isDetected = detected.has(ccy);
    const issues = walletProblems(w);
    const tagClass = isDetected ? (issues.length > 0 ? "warn" : "ok") : "";
    const tagLabel = isDetected
      ? (issues.length > 0 ? `needs ${issues.join(", ")}` : "ready")
      : "saved";
    const showRemove = !isDetected;
    return `<div class="wallet-card" data-ccy="${escapeAttr(ccy)}">
      <div class="wallet-card-head">
        <span class="ccy">${escapeHtml(ccy)}</span>
        <span class="tag ${tagClass}">${escapeHtml(tagLabel)}</span>
        <span class="spacer"></span>
        ${showRemove ? `<button class="link" type="button" data-action="remove" data-ccy="${escapeAttr(ccy)}">Remove</button>` : ""}
        <button class="link" type="button" data-action="reset" data-ccy="${escapeAttr(ccy)}">Reset</button>
      </div>
      <div class="grid">
        <label>IBAN<input data-field="iban" data-ccy="${escapeAttr(ccy)}" type="text" value="${escapeAttr(w.iban)}" /></label>
        <label>BIC<input data-field="bic" data-ccy="${escapeAttr(ccy)}" type="text" value="${escapeAttr(w.bic)}" /></label>
        <label>Bank name<input data-field="bankName" data-ccy="${escapeAttr(ccy)}" type="text" value="${escapeAttr(w.bankName)}" /></label>
      </div>
    </div>`;
  }).join("");

  for (const input of walletsListEl.querySelectorAll<HTMLInputElement>("input[data-field]")) {
    input.addEventListener("input", onWalletFieldInput);
  }
  for (const btn of walletsListEl.querySelectorAll<HTMLButtonElement>('button[data-action="reset"]')) {
    btn.addEventListener("click", () => resetWallet(btn.dataset.ccy ?? ""));
  }
  for (const btn of walletsListEl.querySelectorAll<HTMLButtonElement>('button[data-action="remove"]')) {
    btn.addEventListener("click", () => removeWallet(btn.dataset.ccy ?? ""));
  }
}

function onWalletFieldInput(e: Event): void {
  const input = e.target as HTMLInputElement;
  const ccy = input.dataset.ccy;
  const field = input.dataset.field as "iban" | "bic" | "bankName" | undefined;
  if (!ccy || !field) return;
  const wallets = loadWallets();
  const existing = wallets[ccy] ?? { ...defaultWalletForCurrency(ccy), ...readOwnerFromForm() };
  let value = input.value;
  if (field === "iban") value = value.trim().replace(/\s+/g, "");
  else if (field === "bic") value = value.trim().toUpperCase();
  else value = value.trim();
  wallets[ccy] = { ...existing, [field]: value };
  saveWallets(wallets);
  // Update the tag in place (avoid full re-render to preserve input focus)
  updateWalletCardTag(ccy);
  renderSections();
}

function updateWalletCardTag(ccy: string): void {
  const wallets = loadWallets();
  const wallet = wallets[ccy];
  if (!wallet) return;
  const isDetected = state.sections.some((s) => s.currency === ccy);
  const issues = walletProblems(wallet);
  const tagEl = walletsListEl.querySelector<HTMLSpanElement>(
    `.wallet-card[data-ccy="${ccy}"] .tag`,
  );
  if (!tagEl) return;
  const tagClass = isDetected ? (issues.length > 0 ? "warn" : "ok") : "";
  const tagLabel = isDetected
    ? (issues.length > 0 ? `needs ${issues.join(", ")}` : "ready")
    : "saved";
  tagEl.className = `tag ${tagClass}`.trim();
  tagEl.textContent = tagLabel;
}

function resetWallet(ccy: string): void {
  if (!ccy) return;
  const wallets = loadWallets();
  wallets[ccy] = { ...defaultWalletForCurrency(ccy), ...readOwnerFromForm() };
  saveWallets(wallets);
  renderWallets();
  renderSections();
}

function removeWallet(ccy: string): void {
  if (!ccy) return;
  if (state.sections.find((s) => s.currency === ccy)) return; // can't remove detected
  const wallets = loadWallets();
  delete wallets[ccy];
  saveWallets(wallets);
  renderWallets();
}

function onAddWallet(): void {
  const raw = fields.addWalletCcy.value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(raw)) {
    fields.addWalletCcy.focus();
    return;
  }
  const wallets = loadWallets();
  if (!wallets[raw]) {
    wallets[raw] = { ...defaultWalletForCurrency(raw), ...readOwnerFromForm() };
    saveWallets(wallets);
  }
  fields.addWalletCcy.value = "";
  renderWallets();
}

function loadCachedCustomers(): void {
  try {
    const raw = localStorage.getItem(CUSTOMERS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { customers: CustomerRecord[]; loadedAt: string; name?: string };
    if (Array.isArray(parsed.customers) && parsed.customers.length > 0) {
      state.matcher = new CustomerMatcher(parsed.customers);
      state.customerDbCount = parsed.customers.length;
      state.customerDbName = parsed.name ?? "cached";
      const when = new Date(parsed.loadedAt);
      const daysAgo = Math.floor((Date.now() - when.getTime()) / 86400000);
      customersInfo.textContent = `${parsed.customers.length} customers cached · ${daysAgo === 0 ? "today" : `${daysAgo}d ago`}`;
      customersInfo.classList.remove("hidden");
      dropCustomers.classList.add("has-file");
    }
  } catch {
    // ignore
  }
}

async function handleCustomersFile(file: File): Promise<void> {
  customersInfo.textContent = `${file.name} — parsing…`;
  customersInfo.classList.remove("hidden");
  try {
    // MiniMax exports customers as .xlsx; accept it as downloaded rather than
    // making the user convert to JSON first.
    const isXlsx = /\.xlsx$/i.test(file.name)
      || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const customers = isXlsx
      ? await parseCustomerXlsx(await file.arrayBuffer())
      : parseCustomerJson(await file.text());
    if (customers.length === 0) throw new Error("no valid customers found in file");
    state.matcher = new CustomerMatcher(customers);
    state.customerDbCount = customers.length;
    state.customerDbName = file.name;
    customersInfo.textContent = `${file.name} — ${customers.length} customers loaded`;
    dropCustomers.classList.add("has-file");
    localStorage.setItem(
      CUSTOMERS_KEY,
      JSON.stringify({ customers, loadedAt: new Date().toISOString(), name: file.name }),
    );
    if (state.sections.length > 0) {
      applyMatching();
      renderMatchStatus();
    }
  } catch (e) {
    state.matcher = null;
    customersInfo.textContent = `${file.name} — parse failed: ${(e as Error).message}`;
    dropCustomers.classList.remove("has-file");
  }
}

function applyMatching(): void {
  if (!state.matcher) return;
  const wallets = loadWallets();
  for (const section of state.sections) {
    const wallet = wallets[section.currency] ?? defaultWalletForCurrency(section.currency);
    const ownerName = wallet.ownerName.trim().toLowerCase();
    for (const tx of section.txs) {
      if (
        tx.counterpartyName &&
        tx.counterpartyName.trim().toLowerCase() === ownerName
      ) {
        tx.matchedCustomer = undefined;
        tx.matchConfidence = "none";
        continue;
      }
      const result = state.matcher.match(tx.counterpartyName);
      if (result.matched && result.customer) {
        tx.matchedCustomer = result.customer;
        tx.matchConfidence = result.confidence;
      } else {
        tx.matchedCustomer = undefined;
        tx.matchConfidence = "none";
      }
    }
  }
}

function allTxs(): Transaction[] {
  return state.sections.flatMap((s) => s.txs);
}

function renderMatchStatus(): void {
  if (!state.matcher || state.sections.length === 0) {
    matchStatusEl.classList.add("hidden");
    return;
  }
  const seen = new Set<string>();
  const rows: { name: string; matched: boolean; matchedName?: string; taxId?: string; conf?: string }[] = [];
  for (const tx of allTxs()) {
    const key = (tx.counterpartyName || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      name: tx.counterpartyName || "(no name)",
      matched: !!tx.matchedCustomer,
      matchedName: tx.matchedCustomer?.name,
      taxId: tx.matchedCustomer?.taxNumber,
      conf: tx.matchConfidence,
    });
  }
  rows.sort((a, b) => Number(b.matched) - Number(a.matched) || a.name.localeCompare(b.name));
  const matchedCount = rows.filter((r) => r.matched).length;
  const html = `<div class="match-card">
    <div class="match-card-head">
      <span>Customer matching · ${escapeHtml(state.customerDbName ?? "")} (${state.customerDbCount})</span>
      <span class="match-card-status">${matchedCount}/${rows.length} matched</span>
    </div>
    <div class="match-list">
      ${rows
        .map((r) => {
          const cls = r.matched ? `matched ${r.conf ?? ""}` : "unmatched";
          const icon = r.matched ? "✓" : "·";
          const right = r.matched
            ? `<span class="dst">→ ${escapeHtml(r.matchedName ?? "")} <code>${escapeHtml(r.taxId ?? "")}</code></span>`
            : `<span class="dst">no match — manual in MiniMax</span>`;
          const conf = r.matched && r.conf ? `<span class="conf">${escapeHtml(r.conf)}</span>` : `<span class="conf"></span>`;
          return `<div class="match-row ${cls}">
            <span class="icon">${icon}</span>
            <span class="src">${escapeHtml(r.name)}</span>
            ${right}
            ${conf}
          </div>`;
        })
        .join("")}
    </div>
  </div>`;
  matchStatusEl.innerHTML = html;
  matchStatusEl.classList.remove("hidden");
}

function walletForCurrency(currency: string): WalletConfig {
  const wallets = loadWallets();
  return wallets[currency] ?? defaultWalletForCurrency(currency);
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

async function handlePdfFiles(files: File[]): Promise<void> {
  const totalKb = files.reduce((sum, f) => sum + f.size, 0) / 1024;
  pdfInfo.textContent = `${files.length} file${files.length === 1 ? "" : "s"} — ${totalKb.toFixed(1)} KB · parsing…`;
  pdfInfo.classList.remove("hidden");
  dropPdf.classList.remove("has-file");

  const pdfFiles: File[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (name.endsWith(".zip")) {
      try {
        const buf = await f.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        for (const entry of Object.values(zip.files)) {
          if (entry.dir) continue;
          if (!entry.name.toLowerCase().endsWith(".pdf")) continue;
          const blob = await entry.async("blob");
          pdfFiles.push(new File([blob], entry.name.split("/").pop() ?? entry.name, { type: "application/pdf" }));
        }
      } catch (e) {
        errors.push(`${f.name}: ZIP extract failed — ${(e as Error).message}`);
      }
    } else if (name.endsWith(".pdf") || f.type === "application/pdf") {
      pdfFiles.push(f);
    } else {
      errors.push(`${f.name}: unsupported file type (need .pdf or .zip)`);
    }
  }

  if (pdfFiles.length === 0) {
    state.pdfs.clear();
    state.pdfsByFilename = [];
    state.crossChecks = [];
    state.pdfNotices = errors;
    pdfInfo.textContent = errors.join(" · ") || "No PDFs found.";
    crossCheckEl.classList.add("hidden");
    return;
  }

  state.pdfs.clear();
  state.pdfsByFilename = [];
  state.pdfNotices = [...errors];

  for (const pdf of pdfFiles) {
    try {
      const summary = await parseAirwallexPdf(pdf);
      state.pdfsByFilename.push(summary);
      const ccy = (summary.currency ?? "").toUpperCase();
      if (ccy) {
        if (state.pdfs.has(ccy)) {
          state.pdfNotices.push(`${pdf.name}: duplicate ${ccy} PDF, overwriting previous.`);
        }
        state.pdfs.set(ccy, summary);
      } else {
        state.pdfNotices.push(`${pdf.name}: could not detect currency.`);
      }
    } catch (e) {
      state.pdfNotices.push(`${pdf.name}: parse failed — ${(e as Error).message}`);
    }
  }

  const autoFilled = autoFillWalletsFromPdfs();
  if (autoFilled.length > 0) {
    state.pdfNotices.unshift(`Auto-filled wallet IBAN/bank for: ${autoFilled.join(", ")}.`);
    renderWallets();
    renderSections();
  }

  const parsedCcys = [...state.pdfs.keys()].sort();
  const fileSummary = `${pdfFiles.length} PDF${pdfFiles.length === 1 ? "" : "s"} parsed${parsedCcys.length > 0 ? ` (${parsedCcys.join(", ")})` : ""}`;
  pdfInfo.textContent = state.pdfNotices.length > 0
    ? `${fileSummary} · ${state.pdfNotices.join(" · ")}`
    : fileSummary;
  if (parsedCcys.length > 0) dropPdf.classList.add("has-file");

  if (state.sections.length > 0) {
    runCrossCheck();
  }
}

function autoFillWalletsFromPdfs(): string[] {
  const wallets = loadWallets();
  const filled: string[] = [];
  for (const [ccy, summary] of state.pdfs) {
    if (!summary.iban) continue;
    const existing = wallets[ccy] ?? defaultWalletForCurrency(ccy);
    const before = { iban: existing.iban, bankName: existing.bankName };
    const next: WalletConfig = { ...existing, currency: ccy };
    if (!existing.iban && summary.iban) next.iban = summary.iban;
    if (!existing.bankName && summary.bankName) next.bankName = summary.bankName;
    if (next.iban !== before.iban || next.bankName !== before.bankName) {
      wallets[ccy] = next;
      filled.push(ccy);
    }
  }
  if (filled.length > 0) saveWallets(wallets);
  return filled;
}

function runCrossCheck(): void {
  if (state.pdfs.size === 0 || state.sections.length === 0) {
    state.crossChecks = [];
    renderCrossCheck();
    return;
  }
  const results: { currency: string; result: CrossCheckResult }[] = [];
  // How far the export reaches is a property of the file, not of one wallet.
  const allDates = allTxs().map((t) => t.bookingDate).filter(Boolean).sort();
  const csvSpan = allDates.length
    ? { first: allDates[0], last: allDates[allDates.length - 1] }
    : undefined;
  for (const [ccy, summary] of state.pdfs) {
    const section = state.sections.find((s) => s.currency === ccy);
    if (!section) continue;
    const wallet = walletForCurrency(ccy);
    results.push({
      currency: ccy,
      result: crossCheckPdf(summary, section.validation, wallet, section.txs, csvSpan),
    });
  }
  state.crossChecks = results.sort((a, b) => a.currency.localeCompare(b.currency));
  renderCrossCheck();
}

function renderCrossCheck(): void {
  const orphans: string[] = [];
  for (const ccy of state.pdfs.keys()) {
    if (!state.sections.find((s) => s.currency === ccy)) orphans.push(ccy);
  }
  if (state.crossChecks.length === 0 && orphans.length === 0) {
    crossCheckEl.classList.add("hidden");
    return;
  }
  const orphanNote = orphans.length > 0
    ? `<div class="issue warning">PDF cross-check skipped for ${orphans.join(", ")} — no matching wallet in the CSV.</div>`
    : "";
  const blocks = state.crossChecks.map((entry) => {
    const cc = entry.result;
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
    return `<div class="crosscheck">
      <div class="crosscheck-head">
        <span>${escapeHtml(entry.currency)} wallet · ${escapeHtml(filename)}</span>
        <span class="crosscheck-status ${statusClass}">${status}</span>
      </div>
      <table>
        <thead><tr>
          <th></th><th>Field</th><th class="amt">PDF</th><th class="amt">CSV / wallet</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join("");
  crossCheckEl.innerHTML = orphanNote + blocks;
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

  const sections = splitByCurrency(txs);
  state.sections = sections;

  // Make sure each detected currency has a wallet entry, inheriting shared owner info
  const wallets = loadWallets();
  const owner = readOwnerFromForm();
  for (const s of sections) {
    if (!wallets[s.currency]) {
      wallets[s.currency] = { ...defaultWalletForCurrency(s.currency), ...owner };
    }
  }
  saveWallets(wallets);
  renderWallets();

  if (state.matcher) {
    applyMatching();
  }

  renderSections();

  if (state.pdfs.size > 0) {
    runCrossCheck();
  } else {
    crossCheckEl.classList.add("hidden");
  }
  if (state.matcher) {
    renderMatchStatus();
  } else {
    matchStatusEl.classList.add("hidden");
  }
  previewCard.classList.remove("hidden");
  actionCard.classList.remove("hidden");
  genStatus.textContent = "";
}

function renderSections(): void {
  if (state.sections.length === 0) {
    sectionsEl.innerHTML = "";
    return;
  }
  const wallets = loadWallets();
  sectionsEl.innerHTML = state.sections
    .map((section) => {
      const wallet = wallets[section.currency] ?? defaultWalletForCurrency(section.currency);
      const v = section.validation;
      const setupNeeded = walletProblems(wallet);
      const statusLabel = !v.ok
        ? "Validation FAIL"
        : setupNeeded.length > 0
        ? `Wallet incomplete: ${setupNeeded.join(", ")}`
        : "Validation PASS";
      const statusClass = !v.ok ? "err" : setupNeeded.length > 0 ? "warn" : "ok";
      const ibanLabel = wallet.iban || "(no IBAN configured)";
      return `<div class="wallet-section">
        <div class="wallet-section-head">
          <div>
            <div class="title">${escapeHtml(section.currency)} wallet</div>
            <div class="meta">${escapeHtml(ibanLabel)}</div>
          </div>
          <span class="status ${statusClass}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="wallet-section-body">
          ${summaryHtml(v, section.currency)}
          ${issuesHtml(v)}
          <details>
            <summary>Per-day breakdown</summary>
            ${dayTableHtml(section.days, section.currency)}
          </details>
        </div>
      </div>`;
    })
    .join("");
}

function summaryHtml(v: ValidationResult, ccy: string): string {
  return `<div class="summary">
    <div class="kpi"><div class="k">Transactions</div><div class="v">${v.txCount}</div></div>
    <div class="kpi"><div class="k">Days</div><div class="v">${v.dayCount}</div></div>
    <div class="kpi"><div class="k">Total credits ${escapeHtml(ccy)}</div><div class="v">${v.totalCredits.toFixed(2)}</div></div>
    <div class="kpi"><div class="k">Total debits ${escapeHtml(ccy)}</div><div class="v">${v.totalDebits.toFixed(2)}</div></div>
    <div class="kpi"><div class="k">Start balance</div><div class="v">${v.startBalance.toFixed(2)}</div></div>
    <div class="kpi"><div class="k">End balance</div><div class="v">${v.endBalance.toFixed(2)}</div></div>
    <div class="kpi ${v.ok ? "ok" : "err"}"><div class="k">Validation</div><div class="v">${v.ok ? "PASS" : "FAIL"}</div></div>
    <div class="kpi"><div class="k">Issues</div><div class="v">${v.issues.length}</div></div>
  </div>`;
}

function issuesHtml(v: ValidationResult): string {
  if (v.issues.length === 0) {
    return `<div class="issues"><div class="issue info">Balance walks check out.</div></div>`;
  }
  return `<div class="issues">${v.issues
    .map((i) => `<div class="issue ${i.level}">${escapeHtml(i.message)}${i.context ? ` <small>(${escapeHtml(i.context)})</small>` : ""}</div>`)
    .join("")}</div>`;
}

function dayTableHtml(days: DailyStatement[], ccy: string): string {
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
  return `<div class="day-table"><table>
    <thead><tr>
      <th>Date</th><th>#</th><th>Cr</th><th>Dr</th>
      <th>Credits ${escapeHtml(ccy)}</th><th>Debits ${escapeHtml(ccy)}</th>
      <th>Open</th><th>Close</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

async function generate(): Promise<void> {
  if (state.sections.length === 0) return;
  // Sync any in-progress owner edits across all wallets before we read them.
  onOwnerFieldInput();
  const wallets = loadWallets();

  const incomplete: string[] = [];
  for (const s of state.sections) {
    const w = wallets[s.currency] ?? defaultWalletForCurrency(s.currency);
    const issues = walletProblems(w);
    if (issues.length > 0) incomplete.push(`${s.currency} (${issues.join(", ")})`);
  }
  if (incomplete.length > 0) {
    genStatus.textContent = `Wallet setup incomplete: ${incomplete.join("; ")}. Use the picker to fill them in.`;
    return;
  }

  const allXmls: { filename: string; xml: string; date: string }[] = [];
  for (const s of state.sections) {
    const wallet = wallets[s.currency] ?? defaultWalletForCurrency(s.currency);
    const xmls = buildXmls(s.txs, { perDay: fields.perDay.checked, wallet });
    allXmls.push(...xmls);
  }

  if (allXmls.length === 0) {
    genStatus.textContent = "Nothing to generate.";
    return;
  }

  if (allXmls.length === 1) {
    triggerDownload(allXmls[0].xml, allXmls[0].filename, "application/xml");
    genStatus.textContent = `Downloaded ${allXmls[0].filename}.`;
    return;
  }

  const zip = new JSZip();
  for (const x of allXmls) zip.file(x.filename, x.xml);
  const blob = await zip.generateAsync({ type: "blob" });
  const sortedDates = [...allXmls].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = sortedDates[0].date.replace(/-/g, "");
  const last = sortedDates[sortedDates.length - 1].date.replace(/-/g, "");
  const ccys = state.sections.map((s) => s.currency).join("-");
  const zipName = `airwallex-camt053-${ccys}-${first}_to_${last}.zip`;
  triggerBlob(blob, zipName);
  genStatus.textContent = `Downloaded ${zipName} (${allXmls.length} files across ${state.sections.length} wallet${state.sections.length === 1 ? "" : "s"}).`;
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
  sectionsEl.innerHTML = `<div class="issues"><div class="issue error">${escapeHtml(msg)}</div></div>`;
  actionCard.classList.add("hidden");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s ?? "");
}

init();
