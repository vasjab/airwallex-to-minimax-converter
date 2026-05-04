export type Direction = "CRDT" | "DBIT";

export interface RawCsvRow {
  [key: string]: string;
}

export interface Transaction {
  txId: string;
  bookingDate: string;
  valueDate: string;
  bookingTime: string;
  type: string;
  finTxType: string;
  direction: Direction;
  amount: number;
  fee: number;
  currency: string;
  accountBalance: number;
  description: string;
  reference: string;
  requestId: string;
  noteToSelf: string;
  counterpartyName: string;
  counterpartyIban: string;
  externalRef: string;
  internalRef: string;
  matchedCustomer?: CustomerRecord;
  matchConfidence?: MatchConfidence;
}

export interface DailyStatement {
  date: string;
  openingBalance: number;
  closingBalance: number;
  transactions: Transaction[];
  totalCredits: number;
  totalDebits: number;
  numCredits: number;
  numDebits: number;
}

export interface ValidationIssue {
  level: "error" | "warning" | "info";
  message: string;
  context?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  totalCredits: number;
  totalDebits: number;
  startBalance: number;
  endBalance: number;
  dayCount: number;
  txCount: number;
}

export interface WalletConfig {
  currency: string;
  iban: string;
  bic: string;
  bankName: string;
  ownerName: string;
  ownerAddressLine1: string;
  ownerAddressLine2: string;
  ownerCountry: string;
  ownerTaxId: string;
}

export type WalletConfigMap = Record<string, WalletConfig>;

export interface BuilderOptions {
  perDay: boolean;
  wallet: WalletConfig;
}

export interface PdfSummary {
  filename?: string;
  iban?: string;
  ownerName?: string;
  currency?: string;
  startingBalance?: number;
  endingBalance?: number;
  totalDeposits?: number;
  totalPayouts?: number;
  minBalance?: number;
  maxBalance?: number;
  periodStart?: string;
  periodEnd?: string;
  rawTextLength: number;
  fieldsFound: number;
}

export type CrossCheckLevel = "match" | "mismatch" | "info";

export interface CrossCheckRow {
  field: string;
  pdf?: string;
  csv?: string;
  level: CrossCheckLevel;
  note?: string;
}

export interface CrossCheckResult {
  ok: boolean;
  rows: CrossCheckRow[];
  summary: PdfSummary;
}

export interface CustomerRecord {
  id: number;
  name: string;
  taxNumber: string;
  country?: string;
  code?: string | null;
  city?: string;
}

export type MatchConfidence = "exact" | "prefix" | "fuzzy" | "none";

export interface MatchResult {
  matched: boolean;
  customer?: CustomerRecord;
  confidence: MatchConfidence;
  score?: number;
}

export interface CustomerDb {
  customers: CustomerRecord[];
  loadedAt: string;
}
