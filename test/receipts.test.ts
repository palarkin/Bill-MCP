import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { extractUploadUrl, matchInvoices, resetReceiptBodyCache } from "../src/tools/spendReceipts.js";
import { sniffType, toReceiptImages } from "../src/util/receiptImages.js";
import { FakeBill, testConfig } from "./helpers.js";
import { makePdf } from "./pdf.js";

const parse = (r: any) => JSON.parse(r.content[0].text);

async function connect(fake: FakeBill, env: Record<string, string> = {}) {
  const { server } = buildServer(testConfig({ BILL_SPEND_API_TOKEN: "tok", ...env }), fake.fetch);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

const txns = [
  { id: "t1", merchantName: "Adobe", amount: 59.99, occurredTime: "2026-09-03T10:00:00Z", receiptStatus: "MISSING", currency: "USD" },
  { id: "t2", merchantName: "Amazon Web Services", rawMerchantName: "AWS EMEA", amount: 412.37, occurredTime: "2026-09-02T00:00:00Z", receiptStatus: "MISSING" },
  { id: "t3", merchantName: "Zoom", amount: 15.99, occurredTime: "2026-09-10T00:00:00Z", receiptStatus: "ATTACHED" },
  { id: "t4", merchantName: "Slack", amount: 87.5, occurredTime: "2026-09-12T00:00:00Z", receiptStatus: "NOT_ATTACHED" },
  { id: "t5", merchantName: "Adobe", amount: 59.99, occurredTime: "2026-09-05T00:00:00Z", receiptStatus: "MISSING", declineReason: "INSUFFICIENT_FUNDS" },
];

describe("receipt image conversion", () => {
  it("renders each PDF page to an image and passes images through", async () => {
    const res = await toReceiptImages(makePdf(["Invoice 1", "Page 2", "Page 3"]), "inv.pdf", { maxPages: 2, scale: 1 });
    expect(res.sourceType).toBe("pdf");
    expect(res.totalPages).toBe(3);
    expect(res.skippedPages).toBe(1);
    expect(res.images.map((i) => i.fileName)).toEqual(["inv-page1.png", "inv-page2.png"]);
    expect(sniffType(res.images[0]!.data, "x")).toBe("png");

    const passthrough = await toReceiptImages(res.images[0]!.data, "photo.png");
    expect(passthrough.images[0]!.data).toBe(res.images[0]!.data);
  });

  it("rejects HEIC and unknown files with clear messages", async () => {
    const heic = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypheic"), 0, 0, 0, 0]);
    await expect(toReceiptImages(heic, "IMG_1.HEIC")).rejects.toThrow(/HEIC/);
    await expect(toReceiptImages(new Uint8Array([1, 2, 3]), "notes.txt")).rejects.toThrow(/not a PDF/);
  });
});

describe("matching", () => {
  it("assigns each invoice to the best transaction, at most once", () => {
    const res = matchInvoices(
      [
        { file: "adobe.pdf", vendorName: "Adobe Inc.", total: 59.99, invoiceDate: "2026-09-03", currency: "USD" },
        { file: "aws.pdf", vendorName: "Amazon Web Services EMEA SARL", total: 412.37, invoiceDate: "2026-09-01" },
        { file: "unknown.pdf", vendorName: "Figma", total: 12, invoiceDate: "2026-09-01" },
      ],
      txns.filter((t) => t.receiptStatus === "MISSING" && !t.declineReason),
    );
    expect(res.assignments.map((a: any) => [a.file, a.transaction.id, a.confidence])).toEqual([
      ["adobe.pdf", "t1", "high"],
      ["aws.pdf", "t2", "high"],
    ]);
    expect(res.unmatchedInvoices).toEqual(["unknown.pdf"]);
    expect(res.transactionsStillMissing).toEqual([]);
  });

  it("does not report high confidence when two transactions look identical", () => {
    const twins = [
      { id: "a", merchantName: "Notion", amount: 10, occurredTime: "2026-09-01T00:00:00Z", receiptStatus: "MISSING" },
      { id: "b", merchantName: "Notion", amount: 10, occurredTime: "2026-09-01T00:00:00Z", receiptStatus: "MISSING" },
    ];
    const res = matchInvoices([{ file: "n.pdf", vendorName: "Notion Labs", total: 10, invoiceDate: "2026-09-01" }], twins);
    expect(res.assignments[0]!.confidence).not.toBe("high");
    expect(res.transactionsStillMissing).toHaveLength(1);
  });

  it("ignores currency-mismatched amounts", () => {
    const res = matchInvoices(
      [{ file: "eur.pdf", vendorName: "Hetzner", total: 59.99, currency: "EUR", invoiceDate: "2026-06-01" }],
      [txns[0]!],
    );
    expect(res.assignments).toEqual([]);
  });

  it("finds the upload URL in different response shapes", () => {
    expect(extractUploadUrl({ uploadUrl: "https://s3/x" })).toBe("https://s3/x");
    expect(extractUploadUrl({ data: { url: "https://s3/y" } })).toBe("https://s3/y");
    expect(extractUploadUrl("https://s3/z")).toBe("https://s3/z");
    expect(extractUploadUrl({ url: "http://insecure" })).toBeUndefined();
  });
});

describe("Spend receipt tools", () => {
  let root: string;
  beforeEach(async () => {
    resetReceiptBodyCache();
    root = await mkdtemp(path.join(os.tmpdir(), "invoices-"));
    await mkdir(path.join(root, "sept"));
    await writeFile(path.join(root, "sept", "adobe.pdf"), makePdf(["Adobe invoice $59.99", "Terms"]));
  });

  it("lists transactions missing receipts, falling back to local filtering", async () => {
    const fake = new FakeBill();
    fake.on("GET /transactions", (c) =>
      (c.url.searchParams.get("filters") ?? "").includes("receiptStatus")
        ? { status: 400, body: [{ code: "BDC_1200", message: "unsupported filter" }] }
        : { body: { results: txns } },
    );
    const client = await connect(fake);
    const out = parse(
      await client.callTool({
        name: "bill_spend_list_transactions_missing_receipts",
        arguments: { from: "2026-09-01", to: "2026-09-30" },
      }),
    );
    expect(out.transactions.map((t: any) => t.id)).toEqual(["t2", "t1", "t4"]);
    expect(out.total).toBe(559.86);
    expect(out.note).toMatch(/locally/);
    expect(fake.callsTo("GET /transactions")[0]!.headers.apiToken).toBe("tok");
  });

  it("converts a PDF and attaches each page, discovering the accepted request body", async () => {
    const fake = new FakeBill();
    let n = 0;
    fake.on("POST /transactions/receipt-upload-url", () => ({ body: { uploadUrl: `https://uploads.example.com/r${++n}?sig=abc` } }));
    fake.on("PUT /r1", () => ({ body: {} }));
    fake.on("PUT /r2", () => ({ body: {} }));
    fake.set("POST /transactions/t1/receipts", (c) =>
      (c.body as any).uploadUrl ? { status: 400, body: [{ code: "BDC_1100", message: "receipts is required" }] } : { body: { ok: true } },
    );
    fake.on("GET /transactions/t1", () => ({ body: { id: "t1", receiptStatus: "ATTACHED" } }));
    const client = await connect(fake, { BILL_UPLOAD_ROOT: root });

    const out = parse(
      await client.callTool({ name: "bill_spend_attach_receipt", arguments: { transactionId: "t1", filePath: "sept/adobe.pdf" } }),
    );
    expect(out).toMatchObject({ sourceType: "pdf", totalPages: 2, attached: 2, receiptStatus: "ATTACHED" });

    const puts = fake.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.url.pathname)).toEqual(["/r1", "/r2"]);
    expect(puts[0]!.headers["Content-Type"]).toBe("image/png");
    expect(puts[0]!.headers.apiToken).toBeUndefined();

    const attaches = fake.callsTo("POST /transactions/t1/receipts").map((c) => c.body);
    // First page: shape 0 rejected, shape 1 accepted. Second page reuses shape 1 directly.
    expect(attaches).toEqual([
      { uploadUrl: "https://uploads.example.com/r1?sig=abc" },
      { receipts: [{ url: "https://uploads.example.com/r1?sig=abc", filename: "adobe-page1.png" }] },
      { receipts: [{ url: "https://uploads.example.com/r2?sig=abc", filename: "adobe-page2.png" }] },
    ]);
  });

  it("dry run converts the file but contacts nothing", async () => {
    const fake = new FakeBill();
    const client = await connect(fake, { BILL_UPLOAD_ROOT: root });
    const out = parse(
      await client.callTool({
        name: "bill_spend_attach_receipt",
        arguments: { transactionId: "t1", filePath: path.join(root, "sept", "adobe.pdf"), maxPages: 1, dryRun: true },
      }),
    );
    expect(out).toMatchObject({ dryRun: true, totalPages: 2, skippedPages: 1 });
    expect(out.images).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses files outside the invoices folder", async () => {
    const fake = new FakeBill();
    const client = await connect(fake, { BILL_UPLOAD_ROOT: path.join(root, "sept") });
    const out: any = await client.callTool({
      name: "bill_spend_attach_receipt",
      arguments: { transactionId: "t1", filePath: "../../../etc/hostname" },
    });
    expect(out.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("matches invoices end to end through the MCP tool", async () => {
    const fake = new FakeBill();
    fake.on("GET /transactions", () => ({ body: { results: txns } }));
    const client = await connect(fake);
    const out = parse(
      await client.callTool({
        name: "bill_spend_match_invoices",
        arguments: { invoices: [{ file: "sept/adobe.pdf", vendorName: "Adobe", total: 59.99, invoiceDate: "2026-09-03" }] },
      }),
    );
    expect(out.searchedRange).toEqual({ from: "2026-08-19", to: expect.any(String) });
    expect(out.assignments[0]).toMatchObject({ file: "sept/adobe.pdf", confidence: "high", transaction: { id: "t1" } });
    expect(out.transactionsStillMissing.map((t: any) => t.id).sort()).toEqual(["t2", "t4"]);
  });

  it("reports the invoices folder and works without core credentials", async () => {
    const fake = new FakeBill();
    const { server } = buildServer(
      testConfig({ BILL_USERNAME: "", BILL_SPEND_API_TOKEN: "tok", BILL_UPLOAD_ROOT: root }),
      fake.fetch,
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const info = parse(await client.callTool({ name: "bill_get_session_info", arguments: {} }));
    expect(info).toMatchObject({ spendApiConfigured: true, uploadRoot: root });
    expect(info.coreApi).toMatch(/not configured/);
    expect(fake.calls).toHaveLength(0);
  });
});
