import { describe, expect, it } from "vitest";
import { buildFilterString, buildSortString, fetchAll, projectFields } from "../src/bill/list.js";
import { BillClient } from "../src/bill/client.js";
import { FakeBill, testConfig } from "./helpers.js";

describe("buildFilterString", () => {
  it("quotes strings, leaves numbers and booleans bare, and joins with commas", () => {
    expect(
      buildFilterString([
        { field: "createdTime", op: "gte", value: "2024-09-01T00:00:00.000Z" },
        { field: "archived", op: "eq", value: false },
        { field: "amount", op: "gt", value: 100 },
      ]),
    ).toBe('createdTime:gte:"2024-09-01T00:00:00.000Z",archived:eq:false,amount:gt:100');
  });

  it('encodes in/nin lists as one quoted comma list, as BILL expects (currency:in:"USD,CAD")', () => {
    expect(buildFilterString([{ field: "invoiceCurrency", op: "in", value: ["USD", "CAD"] }])).toBe(
      'invoiceCurrency:in:"USD,CAD"',
    );
  });

  it("passes raw expressions through and returns undefined for no filters", () => {
    expect(buildFilterString(['name:sw:"Acme"'])).toBe('name:sw:"Acme"');
    expect(buildFilterString([])).toBeUndefined();
    expect(buildFilterString(undefined)).toBeUndefined();
  });

  it("rejects lists for scalar operators and unsafe field names", () => {
    expect(() => buildFilterString([{ field: "id", op: "eq", value: ["a", "b"] }])).toThrow(/in/);
    expect(() => buildFilterString([{ field: "name,archived", op: "eq", value: "x" }])).toThrow(/Invalid filter field/);
  });

  it("escapes embedded quotes", () => {
    expect(buildFilterString([{ field: "name", op: "eq", value: 'The "Best" Co' }])).toBe('name:eq:"The \\"Best\\" Co"');
  });
});

describe("buildSortString", () => {
  it("formats field:order pairs", () => {
    expect(buildSortString([{ field: "createdTime", order: "desc" }, { field: "name" }])).toBe("createdTime:desc,name:asc");
    expect(buildSortString(undefined)).toBeUndefined();
  });
});

describe("fetchAll", () => {
  it("follows nextPage tokens and stops at the limit", async () => {
    const fake = new FakeBill();
    const pages: Record<string, unknown> = {
      "": { results: [{ id: 1 }, { id: 2 }], nextPage: "p2" },
      p2: { results: [{ id: 3 }, { id: 4 }], nextPage: "p3" },
      p3: { results: [{ id: 5 }] },
    };
    fake.on("GET /vendors", (c) => ({ body: pages[c.url.searchParams.get("page") ?? ""] }));
    const client = new BillClient(testConfig(), fake.fetch);

    const all = await fetchAll(client, "/vendors", {}, 100);
    expect(all.results.map((r: any) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(all.truncated).toBe(false);
    expect(all.pagesFetched).toBe(3);
    expect(fake.callsTo("GET /vendors")[0]!.url.searchParams.get("max")).toBe("100");

    const limited = await fetchAll(client, "/vendors", {}, 3);
    expect(limited.results).toHaveLength(3);
    expect(limited.truncated).toBe(true);
    expect(limited.nextPage).toBe("p3");
  });

  it("stops if BILL repeats a page token", async () => {
    const fake = new FakeBill();
    fake.on("GET /bills", () => ({ body: { results: [{ id: "x" }], nextPage: "same" } }));
    const client = new BillClient(testConfig(), fake.fetch);
    const all = await fetchAll(client, "/bills", {}, 1000);
    expect(all.pagesFetched).toBe(2);
  });
});

describe("projectFields", () => {
  it("keeps only requested (nested) fields", () => {
    const out = projectFields([{ id: "1", name: "A", invoice: { invoiceNumber: "9", invoiceDate: "x" }, extra: true }], [
      "id",
      "invoice.invoiceNumber",
    ]);
    expect(out).toEqual([{ id: "1", invoice: { invoiceNumber: "9" } }]);
  });
});
