import { describe, it, expect } from "vitest";

import { classifyByName } from "./types";

describe("classifyByName", () => {
  it.each([
    ["report.pdf", "document"],
    ["spec.docx", "document"],
    ["notes.md", "document"],
    ["readme.txt", "document"],
    ["wireframe.png", "image"],
    ["screenshot.JPG", "image"],
    ["mockup.jpeg", "image"],
    ["icon.webp", "image"],
    ["schema.sql", "schema"],
    ["openapi.yaml", "schema"],
    ["openapi.yml", "schema"],
    ["json-schema.json", "schema"],
    ["sample.csv", "data"],
    ["data.tsv", "data"],
    ["customers.xlsx", "spreadsheet"],
    ["legacy.xls", "spreadsheet"],
    ["calc.ods", "spreadsheet"],
    ["mystery.bin", "unknown"],
    ["no-extension", "unknown"],
    ["", "unknown"],
  ])("classifies %s as %s", (name, expected) => {
    expect(classifyByName(name)).toBe(expected);
  });
});
