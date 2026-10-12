import { describe, expect, it } from "vitest";
import { BillClient } from "../src/bill/client.js";
import { BillApiError, ConfigurationError, DryRunCapture } from "../src/bill/errors.js";
import { FakeBill, testConfig } from "./helpers.js";

describe("BillClient session handling", () => {
  it("logs in lazily with credentials and sends devKey + sessionId headers", async () => {
    const fake = new FakeBill();
    fake.on("GET /vendors/009A", () => ({ body: { id: "009A" } }));
    const client = new BillClient(testConfig(), fake.fetch);

    expect(fake.loginCount).toBe(0);
    await client.get("/vendors/009A");

    const login = fake.callsTo("POST /login")[0]!;
    expect(login.url.href).toBe("https://gateway.stage.bill.com/connect/v3/login");
    expect(login.body).toEqual({
      username: "user@example.com",
      password: "secret",
      organizationId: "00801TEST",
      devKey: "devkey-123",
    });
    const call = fake.callsTo("GET /vendors/009A")[0]!;
    expect(call.headers.devKey).toBe("devkey-123");
    expect(call.headers.sessionId).toBe("session-1");
  });

  it("includes rememberMeId and device when configured, for MFA-trusted sessions", async () => {
    const fake = new FakeBill();
    fake.on("GET /x", () => ({ body: {} }));
    const client = new BillClient(testConfig({ BILL_REMEMBER_ME_ID: "rm-1", BILL_DEVICE_NAME: "laptop" }), fake.fetch);
    await client.get("/x");
    expect(fake.callsTo("POST /login")[0]!.body).toMatchObject({ rememberMeId: "rm-1", device: "laptop" });
  });

  it("shares a single login across concurrent requests", async () => {
    const fake = new FakeBill();
    fake.delayMs = 5;
    fake.on("GET /a", () => ({ body: {} }));
    const client = new BillClient(testConfig(), fake.fetch);
    await Promise.all([client.get("/a"), client.get("/a"), client.get("/a"), client.get("/a")]);
    expect(fake.loginCount).toBe(1);
  });

  it("re-authenticates once when BILL reports an invalid session, then retries", async () => {
    const fake = new FakeBill();
    fake.on("GET /bills", () => ({ status: 401, body: [{ code: "BDC_1109", message: "Session is invalid" }] }));
    fake.on("GET /bills", (c) => ({ body: { results: [], session: c.headers.sessionId } }));
    const client = new BillClient(testConfig(), fake.fetch);
    const res = await client.get<{ session: string }>("/bills");
    expect(fake.loginCount).toBe(2);
    expect(res.session).toBe("session-2");
  });

  it("does not loop forever if the session keeps being rejected", async () => {
    const fake = new FakeBill();
    fake.on("GET /bills", () => ({ status: 401, body: [{ code: "BDC_1109", message: "Session is invalid" }] }));
    const client = new BillClient(testConfig(), fake.fetch);
    await expect(client.get("/bills")).rejects.toBeInstanceOf(BillApiError);
    expect(fake.loginCount).toBe(2);
  });

  it("raises a ConfigurationError when credentials are missing", async () => {
    const fake = new FakeBill();
    const client = new BillClient(testConfig({ BILL_DEV_KEY: "" }), fake.fetch);
    await expect(client.get("/vendors")).rejects.toBeInstanceOf(ConfigurationError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("BillClient retries", () => {
  it("retries concurrency throttling (BDC_1322), even for POST", async () => {
    const fake = new FakeBill();
    fake.on("POST /bills", () => ({ status: 400, body: [{ code: "BDC_1322", message: "Too many concurrent requests" }] }));
    fake.on("POST /bills", () => ({ body: { id: "00nNEW" } }));
    const client = new BillClient(testConfig(), fake.fetch);
    await expect(client.post("/bills", { vendorId: "009A" })).resolves.toEqual({ id: "00nNEW" });
    expect(fake.callsTo("POST /bills")).toHaveLength(2);
  });

  it("never retries a POST after an ambiguous 5xx (no double payments)", async () => {
    const fake = new FakeBill();
    fake.on("POST /payments", () => ({ status: 503, body: [{ code: "BDC_5000", message: "Unavailable" }] }));
    const client = new BillClient(testConfig(), fake.fetch);
    await expect(client.post("/payments", { amount: 10 })).rejects.toMatchObject({ status: 503 });
    expect(fake.callsTo("POST /payments")).toHaveLength(1);
  });

  it("retries GET on 5xx and honors Retry-After", async () => {
    const fake = new FakeBill();
    fake.on("GET /vendors", () => ({ status: 502, body: "bad gateway", headers: { "retry-after": "0" } }));
    fake.on("GET /vendors", () => ({ body: { results: [] } }));
    const client = new BillClient(testConfig(), fake.fetch);
    await expect(client.get("/vendors")).resolves.toEqual({ results: [] });
  });

  it("fails fast on the hourly quota (BDC_1144) with a helpful hint", async () => {
    const fake = new FakeBill();
    fake.on("GET /vendors", () => ({ status: 429, body: [{ code: "BDC_1144", message: "Rate limit exceeded" }] }));
    const client = new BillClient(testConfig(), fake.fetch);
    const err: any = await client.get("/vendors").catch((e: any) => e);
    expect(err).toBeInstanceOf(BillApiError);
    expect(err.hint).toMatch(/next hour/);
    expect(fake.callsTo("GET /vendors")).toHaveLength(1);
  });

  it("never exceeds the configured concurrency", async () => {
    const fake = new FakeBill();
    fake.delayMs = 10;
    fake.on("GET /a", () => ({ body: {} }));
    const client = new BillClient(testConfig({ BILL_MAX_CONCURRENCY: "3" }), fake.fetch);
    await client.get("/a"); // login first
    fake.maxInFlight = 0;
    await Promise.all(Array.from({ length: 12 }, () => client.get("/a")));
    expect(fake.maxInFlight).toBe(3);
  });
});

describe("BillClient dry run", () => {
  it("captures mutating requests with redacted credentials but still performs GETs", async () => {
    const fake = new FakeBill();
    fake.on("GET /vendors/009A", () => ({ body: { id: "009A" } }));
    const client = new BillClient(testConfig(), fake.fetch).withDryRun();
    await expect(client.get("/vendors/009A")).resolves.toEqual({ id: "009A" });

    const err: any = await client.post("/payments", { amount: 5 }).catch((e: any) => e);
    expect(err).toBeInstanceOf(DryRunCapture);
    expect(err.request).toMatchObject({
      method: "POST",
      url: "https://gateway.stage.bill.com/connect/v3/payments",
      body: { amount: 5 },
      headers: { devKey: "<redacted>", sessionId: "<redacted>" },
    });
    expect(fake.callsTo("POST /payments")).toHaveLength(0);
  });
});

describe("API targets", () => {
  it("routes Spend & Expense calls with the apiToken header and no session", async () => {
    const fake = new FakeBill();
    fake.on("GET /cards", () => ({ body: { results: [] } }));
    const client = new BillClient(testConfig({ BILL_SPEND_API_TOKEN: "spend-tok" }), fake.fetch);
    await client.get("/cards", undefined, "spend");
    const call = fake.callsTo("GET /cards")[0]!;
    expect(call.url.href).toBe("https://gateway.stage.bill.com/connect/v3/spend/cards");
    expect(call.headers.apiToken).toBe("spend-tok");
    expect(call.headers.sessionId).toBeUndefined();
    expect(fake.loginCount).toBe(0);
  });

  it("uses the production gateway and the connect-events base for webhooks", async () => {
    const fake = new FakeBill();
    fake.on("GET /subscriptions", () => ({ body: [] }));
    const client = new BillClient(testConfig({ BILL_ENVIRONMENT: "production" }), fake.fetch);
    await client.get("/subscriptions", undefined, "events");
    expect(fake.callsTo("GET /subscriptions")[0]!.url.href).toBe("https://gateway.prod.bill.com/connect-events/v3/subscriptions");
  });
});
