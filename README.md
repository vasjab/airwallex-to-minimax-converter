# Airwallex → MiniMax CAMT.053 Converter

Browser-only static tool that converts an **Airwallex Balance Activity Report (CSV)** into one or more **ISO 20022 camt.053.001.02 XML** files for import into [MiniMax](https://www.minimax.si/).

Files never leave your machine. No backend, no upload — everything runs in your browser.

## Use it

Live: <https://vasjab.github.io/airwallex-to-minimax-converter/>

1. In Airwallex, export a Balance Activity Report as CSV for the period you want.
2. Open the page, fill in the wallet settings (IBAN, BIC, owner) the first time — they're saved to your browser.
3. Drop the CSV. The preview shows balance walks, totals, and any validation issues.
4. Click **Generate** to download a ZIP of one XML per booking day, or a single XML for the whole period.
5. Upload the XML(s) to MiniMax.

## What it produces

- One `<Stmt>` per booking day (default), with `LglSeqNb` = `YYYYMMDD`.
- Opening (`OPBD`) and closing (`CLBD`) balances derived from the CSV's running `Account Balance` column.
- `<Ntry>` per transaction: parsed counterparty name and IBAN (when in description), reference, internal Airwallex ID, full description as remittance.
- All amounts in 2-decimal format with `Ccy="EUR"` (or whatever the wallet currency is).
- Owner side always populated with name, address, country, and `TXID` org id.

## Validation

Before generating, the converter walks the balance:

- Each row's `Account Balance` matches `previous + credit - debit`.
- Each day's `closing` matches the next day's `opening`.
- Period totals: `start + sum(credits) - sum(debits) = end`.

If any of these fail, the issues panel surfaces them and you should fix the CSV (or report a bug) before importing into MiniMax.

## Develop

```sh
npm install
npm run dev      # local dev server
npm run build    # type-check + production bundle in dist/
npx tsx scripts/smoke-test.mjs   # end-to-end on a real CSV (edit the path inside)
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages. Enable Pages in the repo's Settings → Pages → Source: "GitHub Actions".

## Caveats

- Built specifically against MiniMax's tolerance for the camt.053.001.02 dialect used by Slovenian banks (Banka Sparkasse format). Other ERPs may want different fields.
- Counterparty IBAN/BIC is omitted when not present in the description (most payouts).
- Currency conversion entries (FX) are not currently handled — export one currency wallet at a time.
