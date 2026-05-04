import type { BuilderOptions, DailyStatement, Transaction, WalletConfig } from "./types";
import { groupByDay } from "./grouper";

const NS = "urn:iso:std:iso:20022:tech:xsd:camt.053.001.02";

export interface BuiltXml {
  filename: string;
  xml: string;
  date: string;
}

export function buildXmls(transactions: Transaction[], opts: BuilderOptions): BuiltXml[] {
  const days = groupByDay(transactions);
  if (days.length === 0) return [];
  if (opts.perDay) {
    return days.map((day) => buildSingle([day], opts.wallet));
  }
  return [buildSingle(days, opts.wallet)];
}

function buildSingle(days: DailyStatement[], wallet: WalletConfig): BuiltXml {
  const now = new Date();
  const creDtTm = isoLocal(now);
  const firstYmd = days[0].date.replace(/-/g, "");
  const msgId = truncate(`AWX${shortStamp(now)}${firstYmd}`, 35);

  const stmts = days.map((d) => stmtBlock(d, wallet, creDtTm)).join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="${NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${NS} camt.053.001.02.xsd">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>${esc(msgId)}</MsgId>
      <CreDtTm>${creDtTm}</CreDtTm>
      <MsgRcpt>
        <Nm>${esc(truncate(wallet.ownerName, 140))}</Nm>
        <Id>
          <OrgId>
            <Othr>
              <Id>${esc(truncate(wallet.ownerTaxId, 35))}</Id>
            </Othr>
          </OrgId>
        </Id>
      </MsgRcpt>
      <AddtlInf>/EODY/</AddtlInf>
    </GrpHdr>
${stmts}  </BkToCstmrStmt>
</Document>
`;

  const filename = days.length === 1
    ? `CAMT53_${wallet.iban}_${ymd(days[0].date)}.xml`
    : `CAMT53_${wallet.iban}_${ymd(days[0].date)}_to_${ymd(days[days.length - 1].date)}.xml`;

  return { filename, xml, date: days[0].date };
}

function stmtBlock(day: DailyStatement, wallet: WalletConfig, creDtTm: string): string {
  const lglSeq = String(dayOfYear(day.date));
  const stmtId = truncate(`${wallet.iban}/${day.date.replace(/-/g, "")}/${wallet.currency}`, 35);
  const prevDate = previousDay(day.date);

  const totalSum = round2(day.totalCredits + day.totalDebits).toFixed(2);

  return `    <Stmt>
      <Id>${esc(stmtId)}</Id>
      <LglSeqNb>${lglSeq}</LglSeqNb>
      <CreDtTm>${creDtTm}</CreDtTm>
      <Acct>
        <Id>
          <IBAN>${esc(wallet.iban)}</IBAN>
        </Id>
        <Ccy>${esc(wallet.currency)}</Ccy>
        <Ownr>
          <Nm>${esc(truncate(wallet.ownerName, 140))}</Nm>
          <PstlAdr>
${addrLines(wallet)}          </PstlAdr>
        </Ownr>
      </Acct>
      <Bal>
        <Tp>
          <CdOrPrtry>
            <Cd>OPBD</Cd>
          </CdOrPrtry>
        </Tp>
        <Amt Ccy="${esc(wallet.currency)}">${day.openingBalance.toFixed(2)}</Amt>
        <CdtDbtInd>${day.openingBalance >= 0 ? "CRDT" : "DBIT"}</CdtDbtInd>
        <Dt>
          <Dt>${prevDate}</Dt>
        </Dt>
      </Bal>
      <Bal>
        <Tp>
          <CdOrPrtry>
            <Cd>CLBD</Cd>
          </CdOrPrtry>
        </Tp>
        <Amt Ccy="${esc(wallet.currency)}">${day.closingBalance.toFixed(2)}</Amt>
        <CdtDbtInd>${day.closingBalance >= 0 ? "CRDT" : "DBIT"}</CdtDbtInd>
        <Dt>
          <Dt>${day.date}</Dt>
        </Dt>
      </Bal>
      <TxsSummry>
        <TtlNtries>
          <NbOfNtries>${day.transactions.length}</NbOfNtries>
          <Sum>${totalSum}</Sum>
        </TtlNtries>
        <TtlCdtNtries>
          <NbOfNtries>${day.numCredits}</NbOfNtries>
          <Sum>${day.totalCredits.toFixed(2)}</Sum>
        </TtlCdtNtries>
        <TtlDbtNtries>
          <NbOfNtries>${day.numDebits}</NbOfNtries>
          <Sum>${day.totalDebits.toFixed(2)}</Sum>
        </TtlDbtNtries>
      </TxsSummry>
${day.transactions.map((t) => entryBlock(t, wallet)).join("")}    </Stmt>
`;
}

function entryBlock(tx: Transaction, wallet: WalletConfig): string {
  const acctRef = sanitizeRef(tx.txId);
  const txIdRef = sanitizeRef(tx.txId);

  return `      <Ntry>
        <Amt Ccy="${esc(wallet.currency)}">${tx.amount.toFixed(2)}</Amt>
        <CdtDbtInd>${tx.direction}</CdtDbtInd>
        <RvslInd>false</RvslInd>
        <Sts>BOOK</Sts>
        <BookgDt>
          <Dt>${tx.bookingDate}</Dt>
        </BookgDt>
        <ValDt>
          <Dt>${tx.valueDate}</Dt>
        </ValDt>
        <AcctSvcrRef>${esc(acctRef)}</AcctSvcrRef>
        <BkTxCd>
          <Prtry>
            <Cd>DP01</Cd>
          </Prtry>
        </BkTxCd>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <EndToEndId>${esc(truncate(tx.externalRef || "NOTPROVIDED", 35))}</EndToEndId>
              <TxId>${esc(txIdRef)}</TxId>
            </Refs>
            <RltdPties>
${partiesBlock(tx, wallet)}            </RltdPties>
${agentsBlock(tx, wallet)}            <Purp>
              <Cd>OTHR</Cd>
            </Purp>
            <RmtInf>
${rmtInfBlock(tx)}            </RmtInf>
            <RltdDts>
              <IntrBkSttlmDt>${tx.valueDate}</IntrBkSttlmDt>
            </RltdDts>
          </TxDtls>
        </NtryDtls>
      </Ntry>
`;
}

function partiesBlock(tx: Transaction, wallet: WalletConfig): string {
  const owner = ownerPartyXml(wallet);
  const ownerAcct = `              <DbtrAcct>
                <Id>
                  <IBAN>${esc(wallet.iban)}</IBAN>
                </Id>
              </DbtrAcct>
`;
  const ownerCdtrAcct = ownerAcct.replace("DbtrAcct", "CdtrAcct").replace("DbtrAcct", "CdtrAcct");

  if (tx.direction === "DBIT") {
    const cdtr = counterpartyPartyXml("Cdtr", tx, wallet);
    const cdtrAcct = tx.counterpartyIban
      ? `              <CdtrAcct>
                <Id>
                  <IBAN>${esc(tx.counterpartyIban)}</IBAN>
                </Id>
              </CdtrAcct>
`
      : "";
    return owner.dbtr + ownerAcct + cdtr + cdtrAcct;
  }
  const dbtr = counterpartyPartyXml("Dbtr", tx, wallet);
  const dbtrAcct = tx.counterpartyIban
    ? `              <DbtrAcct>
                <Id>
                  <IBAN>${esc(tx.counterpartyIban)}</IBAN>
                </Id>
              </DbtrAcct>
`
    : "";
  return dbtr + dbtrAcct + owner.cdtr + ownerCdtrAcct;
}

function ownerPartyXml(wallet: WalletConfig): { dbtr: string; cdtr: string } {
  const inner = `                <Nm>${esc(truncate(wallet.ownerName, 140))}</Nm>
                <PstlAdr>
                  <Ctry>${esc(wallet.ownerCountry)}</Ctry>
${ownerAddrLines(wallet)}                </PstlAdr>
                <Id>
                  <OrgId>
                    <Othr>
                      <Id>${esc(truncate(wallet.ownerTaxId, 35))}</Id>
                      <SchmeNm>
                        <Cd>TXID</Cd>
                      </SchmeNm>
                    </Othr>
                  </OrgId>
                </Id>
`;
  return {
    dbtr: `              <Dbtr>
${inner}              </Dbtr>
`,
    cdtr: `              <Cdtr>
${inner}              </Cdtr>
`,
  };
}

function counterpartyPartyXml(
  tag: "Dbtr" | "Cdtr",
  tx: Transaction,
  wallet: WalletConfig,
): string {
  const matched = tx.matchedCustomer;
  const name = matched?.name || tx.counterpartyName || tx.description.slice(0, 70) || "UNKNOWN";
  const sameAsOwner = tx.counterpartyName.trim().toLowerCase() === wallet.ownerName.trim().toLowerCase();
  const ctry = matched?.country
    || (sameAsOwner ? wallet.ownerCountry : (inferCountry(tx.counterpartyIban) || wallet.ownerCountry));
  const idBlock = matched
    ? `                <Id>
                  <OrgId>
                    <Othr>
                      <Id>${esc(truncate(matched.taxNumber, 35))}</Id>
                      <SchmeNm>
                        <Cd>TXID</Cd>
                      </SchmeNm>
                    </Othr>
                  </OrgId>
                </Id>
`
    : "";
  return `              <${tag}>
                <Nm>${esc(truncate(name, 140))}</Nm>
                <PstlAdr>
                  <Ctry>${esc(ctry)}</Ctry>
                  <AdrLine>NOTPROVIDED</AdrLine>
                </PstlAdr>
${idBlock}              </${tag}>
`;
}

function agentsBlock(tx: Transaction, wallet: WalletConfig): string {
  const ownerAgent = `                <FinInstnId>
                  <BIC>${esc(wallet.bic)}</BIC>
                </FinInstnId>
`;
  if (tx.direction === "DBIT") {
    return `            <RltdAgts>
              <DbtrAgt>
${ownerAgent}              </DbtrAgt>
            </RltdAgts>
`;
  }
  return `            <RltdAgts>
              <CdtrAgt>
${ownerAgent}              </CdtrAgt>
            </RltdAgts>
`;
}

function rmtInfBlock(tx: Transaction): string {
  const desc = buildRemittanceText(tx);
  const ustrd = `              <Ustrd>${esc(truncate(desc, 140))}</Ustrd>
`;
  if (tx.externalRef) {
    const strd = `              <Strd>
                <CdtrRefInf>
                  <Ref>${esc(siWrapRef(tx.externalRef))}</Ref>
                </CdtrRefInf>
              </Strd>
`;
    return ustrd + strd;
  }
  return ustrd;
}

function siWrapRef(ref: string): string {
  const t = ref.trim();
  if (/^SI\d{2}/.test(t) || /^RF\d{2}/.test(t)) {
    return truncate(t, 35);
  }
  const wrapped = `SI99${t}`;
  return wrapped.length <= 35 ? wrapped : wrapped.slice(0, 35);
}

function buildRemittanceText(tx: Transaction): string {
  const parts: string[] = [];
  if (tx.counterpartyName) parts.push(tx.counterpartyName);
  if (tx.externalRef) parts.push(`Ref: ${tx.externalRef}`);
  if (tx.noteToSelf && tx.noteToSelf !== tx.externalRef) parts.push(tx.noteToSelf);
  if (tx.internalRef) parts.push(tx.internalRef);
  if (parts.length === 0) return tx.description;
  return parts.join(" | ");
}

function ownerAddrLines(wallet: WalletConfig): string {
  const lines: string[] = [];
  if (wallet.ownerAddressLine1) lines.push(truncate(wallet.ownerAddressLine1, 70));
  if (wallet.ownerAddressLine2) lines.push(truncate(wallet.ownerAddressLine2, 70));
  if (lines.length === 0) lines.push("NOTPROVIDED");
  return lines.map((l) => `                  <AdrLine>${esc(l)}</AdrLine>\n`).join("");
}

function addrLines(wallet: WalletConfig): string {
  const lines: string[] = [];
  if (wallet.ownerAddressLine1) lines.push(truncate(wallet.ownerAddressLine1, 70));
  if (wallet.ownerAddressLine2) lines.push(truncate(wallet.ownerAddressLine2, 70));
  if (lines.length === 0) lines.push("NOTPROVIDED");
  return lines.map((l) => `            <AdrLine>${esc(l)}</AdrLine>\n`).join("");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(s: string, max: number): string {
  if (!s) return s;
  return s.length <= max ? s : s.slice(0, max);
}

function sanitizeRef(s: string): string {
  return s.replace(/-/g, "").slice(0, 35);
}

function inferCountry(iban: string): string {
  if (!iban || iban.length < 2) return "";
  return iban.slice(0, 2);
}

function ymd(date: string): string {
  return date.replace(/-/g, "");
}

function previousDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortStamp(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayOfYear(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.floor((d.getTime() - yearStart.getTime()) / 86400000) + 1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
