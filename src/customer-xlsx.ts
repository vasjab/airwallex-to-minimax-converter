import JSZip from "jszip";
import type { CustomerRecord } from "./types";

/**
 * Reads MiniMax's customer export straight from the .xlsx it hands you, so the
 * file can be dropped in as downloaded rather than converted to JSON first.
 *
 * .xlsx is a zip of XML, and jszip is already a dependency for building the
 * output archive — no new package needed.
 */

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Column letters from a cell ref like "AB12". */
function colOf(ref: string): string {
  let out = "";
  for (const ch of ref) {
    if (ch >= "A" && ch <= "Z") out += ch;
    else break;
  }
  return out;
}

function textOf(el: Element): string {
  // Shared strings may be split across runs; concatenate every <t>.
  return Array.from(el.getElementsByTagNameNS(MAIN_NS, "t"))
    .map((t) => t.textContent ?? "")
    .join("");
}

function readSheet(xml: Document, shared: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const row of Array.from(xml.getElementsByTagNameNS(MAIN_NS, "row"))) {
    const cells: Record<string, string> = {};
    for (const cell of Array.from(row.getElementsByTagNameNS(MAIN_NS, "c"))) {
      const ref = cell.getAttribute("r") ?? "";
      const type = cell.getAttribute("t");
      let value: string;
      if (type === "inlineStr") {
        value = textOf(cell);
      } else {
        const v = cell.getElementsByTagNameNS(MAIN_NS, "v")[0];
        value = v?.textContent ?? "";
        if (type === "s" && value) value = shared[Number(value)] ?? "";
      }
      if (value) cells[colOf(ref)] = value.trim();
    }
    rows.push(cells);
  }
  return rows;
}

/** Header label → the CustomerRecord field it feeds. Matched case-insensitively. */
const HEADERS: { field: keyof CustomerRecord; match: (h: string) => boolean }[] = [
  { field: "id", match: (h) => h.includes("identifikator") || h === "customerid" },
  { field: "code", match: (h) => h === "šifra" || h === "sifra" || h === "code" },
  { field: "name", match: (h) => h === "naziv" || h === "name" },
  { field: "country", match: (h) => h === "država" || h === "drzava" || h === "country" },
  { field: "city", match: (h) => h.includes("kraj") || h === "city" },
  { field: "taxNumber", match: (h) => h.includes("davčna") || h.includes("davcna") || h === "taxnumber" },
];

export async function parseCustomerXlsx(file: ArrayBuffer): Promise<CustomerRecord[]> {
  const zip = await JSZip.loadAsync(file);

  const sharedFile = zip.file("xl/sharedStrings.xml");
  const shared: string[] = sharedFile
    ? Array.from(
        new DOMParser()
          .parseFromString(await sharedFile.async("string"), "application/xml")
          .getElementsByTagNameNS(MAIN_NS, "si"),
      ).map(textOf)
    : [];

  const sheetFile =
    zip.file("xl/worksheets/sheet1.xml") ?? zip.file(/^xl\/worksheets\/.*\.xml$/)[0];
  if (!sheetFile) throw new Error("no worksheet found in workbook");
  const sheet = new DOMParser().parseFromString(await sheetFile.async("string"), "application/xml");

  const rows = readSheet(sheet, shared);
  if (rows.length < 2) throw new Error("workbook has no data rows");

  // Locate columns by header text rather than position — MiniMax is free to
  // reorder them, and a silent column shift would mis-assign every tax number.
  const header = rows[0];
  const colFor: Partial<Record<keyof CustomerRecord, string>> = {};
  for (const [col, label] of Object.entries(header)) {
    const h = label.toLowerCase().trim();
    for (const { field, match } of HEADERS) {
      if (!colFor[field] && match(h)) colFor[field] = col;
    }
  }
  if (!colFor.id || !colFor.name) {
    throw new Error(
      `could not find the customer id and name columns (saw: ${Object.values(header).join(", ")})`,
    );
  }

  const out: CustomerRecord[] = [];
  for (const row of rows.slice(1)) {
    const id = Number(row[colFor.id]);
    const name = row[colFor.name];
    if (!Number.isFinite(id) || id === 0 || !name) continue;
    out.push({
      id,
      name,
      taxNumber: colFor.taxNumber ? (row[colFor.taxNumber] ?? "") : "",
      country: colFor.country ? row[colFor.country] : undefined,
      city: colFor.city ? row[colFor.city] : undefined,
      code: colFor.code ? (row[colFor.code] ?? null) : null,
    });
  }
  return out;
}
