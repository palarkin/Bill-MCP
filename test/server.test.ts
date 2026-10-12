import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { FakeBill, testConfig } from "./helpers.js";

async function connect(env: Record<string, string> = {}, fake = new FakeBill()) {
  const { server, report } = buildServer(testConfig(env), fake.fetch);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, fake, report };
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe("tool registration", () => {
  it("hides money-movement tools by default and marks write tools with dryRun", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("bill_list_bills");
    expect(names).toContain("bill_create_bill");
    expect(names).not.toContain("bill_create_payment");
    expect(names).not.toContain("bill_create_vendor_bank_account");
    expect(names).not.toContain("bill_spend_list_cards"); // no Spend token

    const create = tools.find((t) => t.name === "bill_create_bill")!;
    expect(create.inputSchema.properties).toHaveProperty("dryRun");
    expect(create.annotations?.readOnlyHint).toBe(false);
    const list = tools.find((t) => t.name === "bill_list_bills")!;
    expect(list.inputSchema.properties).not.toHaveProperty("dryRun");
    expect(list.annotations?.readOnlyHint).toBe(true);
  });

  it("exposes only read tools in read-only mode, even if money movement is requested", async () => {
    const { client } = await connect({ BILL_READ_ONLY: "true", BILL_ENABLE_MONEY_MOVEMENT: "true" });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("labels money tools and flags them destructive when enabled", async () => {
    const { client } = await connect({ BILL_ENABLE_MONEY_MOVEMENT: "true" });
    const { tools } = await client.listTools();
    const pay = tools.find((t) => t.name === "bill_create_payment")!;
    expect(pay.description).toMatch(/^\[MOVES MONEY\]/);
    expect(pay.annotations?.destructiveHint).toBe(true);
  });

  it("limits tools to the selected toolsets", async () => {
    const { client } = await connect({ BILL_TOOLSETS: "vendors,analytics" });
    const { tools } = await client.listTools();
    expect(tools.every((t) => /vendor|find_|aging|forecast|spend_summary|duplicate|international/.test(t.name))).toBe(true);
  });
});

describe("tool calls", () => {
  it("translates convenience arguments into BILL filters and excludes archived records", async () => {
    const fake = new FakeBill();
    fake.on("GET /bills", () => ({ body: { results: [{ id: "00n1", amount: 10 }], nextPage: "tok" } }));
    const { client } = await connect({}, fake);
    const result = await client.callTool({
      name: "bill_list_bills",
      arguments: { vendorId: "009A", paymentStatus: ["UNPAID", "PARTIAL"], dueDateTo: "2025-12-31", max: 50 },
    });
    expect(parse(result)).toEqual({ count: 1, nextPage: "tok", results: [{ id: "00n1", amount: 10 }] });
    const params = fake.callsTo("GET /bills")[0]!.url.searchParams;
    expect(params.get("max")).toBe("50");
    expect(params.get("filters")).toBe(
      'vendorId:eq:"009A",paymentStatus:in:"UNPAID,PARTIAL",dueDate:lte:"2025-12-31",archived:eq:false',
    );
  });

  it("returns the request instead of sending it when dryRun is set", async () => {
    const fake = new FakeBill();
    const { client } = await connect({}, fake);
    const result = await client.callTool({
      name: "bill_create_bill",
      arguments: {
        vendorId: "009A",
        dueDate: "2025-11-30",
        invoice: { invoiceNumber: "INV-1", invoiceDate: "2025-10-31" },
        billLineItems: [{ amount: 125.5, description: "Consulting" }],
        additionalFields: { customField: "x" },
        dryRun: true,
      },
    });
    const out = parse(result);
    expect(out.dryRun).toBe(true);
    expect(out.request.method).toBe("POST");
    expect(out.request.body).toEqual({
      vendorId: "009A",
      dueDate: "2025-11-30",
      invoice: { invoiceNumber: "INV-1", invoiceDate: "2025-10-31" },
      billLineItems: [{ amount: 125.5, description: "Consulting" }],
      customField: "x",
    });
    expect(fake.callsTo("POST /bills")).toHaveLength(0);
  });

  it("returns structured, actionable errors from BILL", async () => {
    const fake = new FakeBill();
    fake.on("GET /vendors/009NOPE", () => ({ status: 404, body: [{ code: "BDC_1004", message: "Vendor not found" }] }));
    const { client } = await connect({}, fake);
    const result: any = await client.callTool({ name: "bill_get_vendor", arguments: { vendorId: "009NOPE" } });
    expect(result.isError).toBe(true);
    const err = parse(result);
    expect(err.status).toBe(404);
    expect(err.details[0].code).toBe("BDC_1004");
    expect(err.hint).toMatch(/prefixes/);
  });

  it("builds the invoice customer reference and sendEmail processing option", async () => {
    const fake = new FakeBill();
    fake.on("POST /invoices", (c) => ({ body: { id: "00eNEW", echo: c.body } }));
    const { client } = await connect({}, fake);
    const result = await client.callTool({
      name: "bill_create_invoice",
      arguments: {
        customerId: "0cuA",
        invoiceNumber: "1001",
        invoiceDate: "2025-10-01",
        dueDate: "2025-10-31",
        invoiceLineItems: [{ quantity: 2, price: 39.99, description: "Widget" }],
        sendEmail: true,
      },
    });
    expect(parse(result).echo).toEqual({
      customer: { id: "0cuA" },
      invoiceNumber: "1001",
      invoiceDate: "2025-10-01",
      dueDate: "2025-10-31",
      invoiceLineItems: [{ quantity: 2, price: 39.99, description: "Widget" }],
      processingOptions: { sendEmail: true },
    });
  });

  it("archives via the generic archive tool", async () => {
    const fake = new FakeBill();
    fake.on("POST /vendor-credits/0vcA/archive", () => ({ body: { archived: true } }));
    const { client } = await connect({}, fake);
    const result = await client.callTool({
      name: "bill_archive_object",
      arguments: { objectType: "vendor-credit", objectId: "0vcA" },
    });
    expect(parse(result)).toEqual({ archived: true });
  });

  it("refuses money-moving endpoints through the raw tool when money movement is off", async () => {
    const fake = new FakeBill();
    const { client } = await connect({}, fake);
    const result: any = await client.callTool({
      name: "bill_api_request",
      arguments: { method: "POST", path: "/payments", body: { amount: 1 } },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/money movement is disabled/);

    const autopay: any = await client.callTool({
      name: "bill_update_vendor",
      arguments: { vendorId: "009A", additionalFields: { autoPay: { enabled: true } } },
    });
    expect(autopay.isError).toBe(true);
    expect(fake.calls.filter((c) => c.method !== "GET" && !c.url.pathname.endsWith("/login"))).toHaveLength(0);
  });

  it("rejects raw paths that try to escape the API base", async () => {
    const { client } = await connect();
    const result: any = await client.callTool({ name: "bill_api_get", arguments: { path: "/../../evil" } });
    expect(result.isError).toBe(true);
  });

  it("validates payment arguments before calling BILL", async () => {
    const fake = new FakeBill();
    const { client } = await connect({ BILL_ENABLE_MONEY_MOVEMENT: "true" }, fake);
    const result: any = await client.callTool({
      name: "bill_create_payment",
      arguments: {
        vendorId: "009A",
        amount: 10,
        processDate: "2025-11-01",
        fundingAccount: { type: "bank_account", id: "bac1" },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/billId/);
    expect(fake.callsTo("POST /payments")).toHaveLength(0);
  });

  it("handles zero-argument tools and routes webhook calls to connect-events", async () => {
    const fake = new FakeBill();
    fake.on("GET /subscriptions", () => ({ body: [{ id: "sub1" }] }));
    fake.on("GET /login/session", () => ({ body: { organizationId: "00801TEST" } }));
    const { client } = await connect({}, fake);
    expect(parse(await client.callTool({ name: "bill_list_webhook_subscriptions", arguments: {} }))).toEqual([{ id: "sub1" }]);
    expect(fake.callsTo("GET /subscriptions")[0]!.url.pathname).toBe("/connect-events/v3/subscriptions");
    const info = parse(await client.callTool({ name: "bill_get_session_info", arguments: {} }));
    expect(info).toMatchObject({ environment: "sandbox", organizationId: "00801TEST", moneyMovementEnabled: false });
  });

  it("sends webhook subscription creation with a UUID idempotency key", async () => {
    const fake = new FakeBill();
    fake.on("POST /subscriptions", (c) => ({ body: { id: "sub1", securityKey: "k", key: c.headers["X-Idempotent-Key"] } }));
    const { client } = await connect({}, fake);
    const out = parse(
      await client.callTool({
        name: "bill_create_webhook_subscription",
        arguments: { name: "hook", notificationUrl: "https://example.com/hook", events: [{ type: "bill.created", version: "1" }] },
      }),
    );
    expect(out.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.callsTo("POST /subscriptions")[0]!.body).toMatchObject({ status: { enabled: true } });
  });

  it("serves the guide and status resources", async () => {
    const { client } = await connect();
    const guide = await client.readResource({ uri: "bill://guide" });
    expect((guide.contents[0] as any).text).toMatch(/Money movement/);
    const status = JSON.parse(((await client.readResource({ uri: "bill://status" })).contents[0] as any).text);
    expect(status.moneyMovementEnabled).toBe(false);
    expect(status.tools.enabled).toBeGreaterThan(50);
  });

  it("exposes workflow prompts", async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(["payment_run", "enter_bill", "collections_review", "month_end_close"]),
    );
  });
});
