import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/tools/webhooks.js";
import { guessContentType, resolveUploadPath } from "../src/tools/documents.js";
import { isMoneyMovement } from "../src/tools/raw.js";
import { loadConfig } from "../src/config.js";
import { parseErrorBody, BillApiError } from "../src/bill/errors.js";

describe("webhook signatures", () => {
  const key = "sec-key";
  const body = '{"metadata":{"eventType":"bill.created"},"bill":{"id":"00n1"}}';
  const sig = createHmac("sha256", key).update(body).digest("base64");

  it("accepts a valid signature and rejects tampering", () => {
    expect(verifyWebhookSignature(body, sig, key)).toBe(true);
    expect(verifyWebhookSignature(body + " ", sig, key)).toBe(false);
    expect(verifyWebhookSignature(body, sig, "other")).toBe(false);
    expect(verifyWebhookSignature(body, "not-base64!!", key)).toBe(false);
  });
});

describe("document uploads", () => {
  it("only reads files inside BILL_UPLOAD_ROOT", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bill-mcp-"));
    const root = path.join(dir, "uploads");
    await mkdir(root);
    await writeFile(path.join(root, "inv.pdf"), "pdf");
    await writeFile(path.join(dir, "secret.txt"), "nope");

    await expect(resolveUploadPath("inv.pdf", root)).resolves.toMatch(/inv\.pdf$/);
    await expect(resolveUploadPath("../secret.txt", root)).rejects.toThrow(/inside BILL_UPLOAD_ROOT/);
    await expect(resolveUploadPath(path.join(dir, "secret.txt"), root)).rejects.toThrow(/inside BILL_UPLOAD_ROOT/);
    await expect(resolveUploadPath("inv.pdf", undefined)).rejects.toThrow(/disabled/);
  });

  it("guesses content types", () => {
    expect(guessContentType("a.PDF")).toBe("application/pdf");
    expect(guessContentType("a.unknown")).toBe("application/octet-stream");
  });
});

describe("money movement detection", () => {
  it("recognizes payment, charge, bank-detail and autopay requests", () => {
    expect(isMoneyMovement("POST", "/payments", "core", {})).toBe(true);
    expect(isMoneyMovement("POST", "/payments/bulk", "core", {})).toBe(true);
    expect(isMoneyMovement("POST", "/payments/abc/cancel", "core", {})).toBe(false);
    expect(isMoneyMovement("POST", "/receivable-payments", "core", {})).toBe(true);
    expect(isMoneyMovement("POST", "/vendors/009A/bank-account", "core", {})).toBe(true);
    expect(isMoneyMovement("PATCH", "/vendors/009A", "core", { autoPay: { enabled: true } })).toBe(true);
    expect(isMoneyMovement("PATCH", "/vendors/009A", "core", { name: "x" })).toBe(false);
    expect(isMoneyMovement("POST", "/cards", "spend", {})).toBe(true);
    expect(isMoneyMovement("POST", "/bills", "core", {})).toBe(false);
  });
});

describe("configuration", () => {
  it("defaults to sandbox with safe settings", () => {
    const c = loadConfig({});
    expect(c.environment).toBe("sandbox");
    expect(c.apiBaseUrl).toBe("https://gateway.stage.bill.com/connect/v3");
    expect(c.readOnly).toBe(false);
    expect(c.enableMoneyMovement).toBe(false);
    expect(c.maxConcurrency).toBe(3);
  });

  it("read-only overrides money movement, and toolsets are validated", () => {
    expect(loadConfig({ BILL_READ_ONLY: "1", BILL_ENABLE_MONEY_MOVEMENT: "true" }).enableMoneyMovement).toBe(false);
    expect(() => loadConfig({ BILL_TOOLSETS: "bills,bogus" })).toThrow(/bogus/);
    expect(() => loadConfig({ BILL_ENVIRONMENT: "staging" })).toThrow();
    expect(() => loadConfig({ BILL_MAX_CONCURRENCY: "50" })).toThrow(/between/);
  });

  it("supports a custom gateway host", () => {
    const c = loadConfig({ BILL_API_HOST: "https://gw.example.com/" });
    expect(c.eventsBaseUrl).toBe("https://gw.example.com/connect-events/v3");
    expect(c.spendBaseUrl).toBe("https://gw.example.com/connect/v3/spend");
  });
});

describe("error parsing", () => {
  it("handles v3 arrays, wrapped errors, v2 envelopes and text", () => {
    expect(parseErrorBody([{ code: "BDC_1", message: "x" }])).toEqual([{ code: "BDC_1", message: "x" }]);
    expect(parseErrorBody({ errors: [{ code: "BDC_2" }] })).toEqual([{ code: "BDC_2" }]);
    expect(parseErrorBody({ response_status: 1, response_data: { error_code: "BDC_3", error_message: "y" } })).toEqual([
      { code: "BDC_3", message: "y" },
    ]);
    expect(parseErrorBody("<html>oops</html>")).toEqual([{ message: "<html>oops</html>" }]);
  });

  it("classifies MFA errors with guidance", () => {
    const err = new BillApiError({
      status: 403,
      method: "POST",
      path: "/payments",
      details: [{ code: "BDC_1386", message: "This operation requires an MFA trusted session" }],
    });
    expect(err.isMfaRequired).toBe(true);
    expect(err.hint).toMatch(/bill_mfa_create_challenge/);
  });
});
