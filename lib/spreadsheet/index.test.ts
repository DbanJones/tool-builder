import { describe, expect, it } from "vitest";
import { utils } from "xlsx";

import {
  formatSummary,
  piiGuardText,
  summariseSheet,
  type SpreadsheetParse,
} from "./index";

// We test the pure summariser + formatter directly. parseSpreadsheet itself
// is a thin wrapper over xlsx.read; full round-trip coverage lives in the
// integration suite once it picks up a fixture file.

describe("summariseSheet", () => {
  it("captures sheet name, header row, row count, and sample rows", () => {
    const ws = utils.aoa_to_sheet([
      ["id", "name", "email"],
      [1, "Ada", "a@example.com"],
      [2, "Lin", "l@example.com"],
      [3, "Mo", "m@example.com"],
    ]);
    const sheet = summariseSheet("Customers", ws);
    expect(sheet.name).toBe("Customers");
    expect(sheet.columns).toEqual(["id", "name", "email"]);
    expect(sheet.rowCount).toBe(3);
    expect(sheet.sampleRows).toHaveLength(3);
    expect(sheet.sampleRows[0]).toEqual(["1", "Ada", "a@example.com"]);
  });

  it("caps sample rows at 10 even when the sheet is longer", () => {
    const rows: (string | number)[][] = [["x"]];
    for (let i = 0; i < 25; i++) rows.push([i]);
    const ws = utils.aoa_to_sheet(rows);
    const sheet = summariseSheet("Big", ws);
    expect(sheet.rowCount).toBe(25);
    expect(sheet.sampleRows).toHaveLength(10);
  });

  it("returns empty columns for an empty sheet", () => {
    const ws = utils.aoa_to_sheet<string>([]);
    const sheet = summariseSheet("Empty", ws);
    expect(sheet.rowCount).toBe(0);
    expect(sheet.columns).toEqual([]);
    expect(sheet.sampleRows).toEqual([]);
  });
});

describe("formatSummary", () => {
  const parse: SpreadsheetParse = {
    sheetCount: 1,
    sheets: [
      {
        name: "Orders",
        rowCount: 2,
        columnCount: 2,
        columns: ["id", "total"],
        sampleRows: [
          ["1", "9.99"],
          ["2", "12.5"],
        ],
      },
    ],
  };

  it("includes the source name, sheet name, counts, and sample rows", () => {
    const md = formatSummary(parse, "orders.xlsx");
    expect(md).toContain("# Spreadsheet summary — orders.xlsx");
    expect(md).toContain("## Orders");
    expect(md).toContain("Rows: 2 · Columns: 2");
    expect(md).toContain("`id`");
    expect(md).toContain("Sample rows:");
    expect(md).toMatch(/\| 1 \| 9\.99 \|/);
  });

  it("escapes pipe characters so the markdown table does not break", () => {
    const quirky: SpreadsheetParse = {
      sheetCount: 1,
      sheets: [
        {
          name: "Quirky",
          rowCount: 1,
          columnCount: 1,
          columns: ["note"],
          sampleRows: [["a|b"]],
        },
      ],
    };
    const md = formatSummary(quirky, "quirky.xlsx");
    expect(md).toContain("a\\|b");
  });
});

describe("piiGuardText", () => {
  it("flattens header + sample rows into newline-separated text", () => {
    const parse: SpreadsheetParse = {
      sheetCount: 1,
      sheets: [
        {
          name: "People",
          rowCount: 1,
          columnCount: 2,
          columns: ["name", "email"],
          sampleRows: [["Ada", "a@example.com"]],
        },
      ],
    };
    const text = piiGuardText(parse);
    expect(text).toContain("name\temail");
    expect(text).toContain("Ada\ta@example.com");
  });
});
