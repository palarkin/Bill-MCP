import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agingBucket, nameSimilarity, normalizeInvoiceNumber, openBalance, parseDate } from "../src/tools/analytics.js";
import { buildServer } from "../src/server.js";
import { FakeBill, testConfig } from "./helpers.js";

describe("analytics helpers", () => {
  it("buckets by days past due", () => {
    const asOf = parseDate("2025-06-30")!;
    expect(agingBucket(parseDate("2025-07-15"), asOf)).toBe("current");
    expect(agingBucket(parseDate("2025-06-30"), asOf)).toBe("current");
    expect(agingBucket(parseDate("2025-06-29"), asOf)).toBe("1-30");
    expect(agingBucket(parseDate("2025-05-31"), asOf)).toBe("1-30");
    expect(agingBucket(parseDate("2025-05-30"), asOf)).toBe("31-60");
    expect(agingBucket(parseDate("2025-04-15"), asOf)).toBe("61-90");
    expect(agingBucket(parseDate("2024-01-01"), asOf)).toBe("90+");
  });

  it("computes open balance across field variants", () => {
    expect(openBalance({ dueAmount: 40, amount: 100 })).toBe(40);
    expect(openBalance({ amount: 100, paidAmount: "25" })).toBe(75);
    expect(openBalance({ amount: 100, paymentStatus: "PAID" })).toBe(0);
    expect(openBalance({ totalAmount: 80, status: "PAID_IN_FULL" })).toBe(0);
  });

  it("matches names fuzzily", () => {
    expect(nameSimilarity("acme", "Acme Corporation")).toBe(1);
    expect(nameSimilarity("Acme Supply", "ACME Supply Co., Inc.")).toBe(1);
    expect(nameSimilarity("Stapels", "Staples")).toBeGreaterThan(0.4);
    expect(nameSimilarity("Staples", "Office Depot")).toBeLessThan(0.3);
  });

  it("normalizes invoice numbers", () => {
    expect(normalizeInvoiceNumber("INV-00042")).toBe("42");
    expect(normalizeInvoiceNumber("inv 42")).toBe("42");
    expect(normalizeInvoiceNumber("A-1/7")).toBe("a17");
  });
});

async function connect(fake: FakeBill) {
  const { server } = buildServer(testConfig(), fake.fetch);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("analytics tools", () => {
  const bills = [
    { id: "00n1", vendorId: "009A", vendorName: "Acme", dueAmount: 100, dueDate: "2025-07-10", invoice: { invoiceNumber: "INV-1", invoiceDate: "2025-06-10" }, amount: 100 },
    { id: "00n2", vendorId: "009A", vendorName: "Acme", dueAmount: 50, dueDate: "2025-06-15", invoice: { invoiceNumber: "inv-001", invoiceDate: "2025-05-15" }, amount: 50 },
    { id: "00n3", vendorId: "009B", vendorName: "Beta", dueAmount: 200, dueDate: "2025-03-01", invoice: { invoiceNumber: "77", invoiceDate: "2025-02-01" }, amount: 200 },
    { id: "00n4", vendorId: "009B", vendorName: "Beta", dueAmount: 0, paymentStatus: "PAID", dueDate: "2025-03-01", invoice: { invoiceNumber: "78", invoiceDate: "2025-02-01" }, amount: 200 },
  ];

  it("produces an AP aging report", async () => {
    const fake = new FakeBill();
    fake.on("GET /bills", () => ({ body: { results: bills } }));
    const client = await connect(fake);
    const out = parse(await client.callTool({ name: "bill_ap_aging_report", arguments: { asOf: "2025-06-30" } }));
    expect(out.totalOutstanding).toBe(350);
    expect(out.pastDue).toBe(250);
    const byBucket = Object.fromEntries(out.buckets.map((b: any) => [b.bucket, b.amount]));
    expect(byBucket).toMatchObject({ current: 100, "1-30": 50, "90+": 200 });
    expect(out.topVendors[0]).toMatchObject({ id: "009B", total: 200 });
  });

  it("forecasts cash requirements and falls back when dueDate is not filterable", async () => {
    const fake = new FakeBill();
    fake.on("GET /bills", (c) =>
      (c.url.searchParams.get("filters") ?? "").includes("dueDate")
        ? { status: 400, body: [{ code: "BDC_1200", message: "Invalid filter field" }] }
        : { body: { results: bills } },
    );
    const client = await connect(fake);
    const out = parse(
      await client.callTool({ name: "bill_cash_requirements_forecast", arguments: { asOf: "2025-06-30", horizonDays: 14 } }),
    );
    expect(out.overdue).toEqual({ amount: 250, count: 2 });
    expect(out.weekly).toEqual([{ weekStarting: "2025-07-07", amount: 100, count: 1, cumulativeIncludingOverdue: 350 }]);
    expect(out.totalRequired).toBe(350);
    expect(out.note).toMatch(/locally/);
  });

  it("flags a duplicate candidate before bill creation", async () => {
    const fake = new FakeBill();
    fake.on("GET /bills", () => ({ body: { results: bills.filter((b) => b.vendorId === "009A") } }));
    const client = await connect(fake);
    const out = parse(
      await client.callTool({
        name: "bill_find_duplicate_bills",
        arguments: { candidate: { vendorId: "009A", invoiceNumber: "INV 0001", amount: 999 } },
      }),
    );
    expect(out.likelyDuplicate).toBe(true);
    // "INV 0001", "INV-1" and "inv-001" all normalize to invoice number 1.
    expect(out.matches.map((m: any) => m.id)).toEqual(["00n1", "00n2"]);
  });

  it("scans for duplicate groups without double-reporting the same bills", async () => {
    const fake = new FakeBill();
    const dupes = [
      { id: "00nX", vendorId: "009A", amount: 10, invoice: { invoiceNumber: "A-7", invoiceDate: "2025-01-01" } },
      { id: "00nY", vendorId: "009A", amount: 10, invoice: { invoiceNumber: "a7", invoiceDate: "2025-01-01" } },
      { id: "00nZ", vendorId: "009A", amount: 55, invoice: { invoiceNumber: "Q1", invoiceDate: "2025-02-01" } },
      { id: "00nW", vendorId: "009A", amount: 55, invoice: { invoiceNumber: "Q2", invoiceDate: "2025-02-01" } },
    ];
    fake.on("GET /bills", () => ({ body: { results: dupes } }));
    const client = await connect(fake);
    const out = parse(await client.callTool({ name: "bill_find_duplicate_bills", arguments: {} }));
    expect(out.duplicateGroups).toBe(2);
    expect(out.duplicates.map((d: any) => [d.reason, d.bills.map((b: any) => b.id)])).toEqual([
      ["same vendor and invoice number", ["00nX", "00nY"]],
      ["same vendor, amount, and invoice date", ["00nZ", "00nW"]],
    ]);
  });

  it("resolves vendor names", async () => {
    const fake = new FakeBill();
    fake.on("GET /vendors", () => ({
      body: { results: [{ id: "009A", name: "Acme Supply, Inc." }, { id: "009B", name: "Beta Logistics LLC" }] },
    }));
    const client = await connect(fake);
    const out = parse(await client.callTool({ name: "bill_find_vendors", arguments: { query: "acme supply" } }));
    expect(out.matches[0]).toMatchObject({ id: "009A", score: 1 });
    expect(out.matches).toHaveLength(1);
  });
});
