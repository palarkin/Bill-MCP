import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import { enablesAutopay } from "./raw.js";
import type { BillConfig } from "../config.js";
import { additionalFields, addressSchema, buildBody, encodeId, getTool, id, listTool, upperEnum } from "./common.js";

const vendorFields = {
  name: z.string().min(1).describe("Vendor name"),
  shortName: z.string().optional(),
  accountType: upperEnum(["BUSINESS", "PERSON", "NONE"]).optional().describe("BUSINESS or PERSON"),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: addressSchema.optional().describe("Vendor mailing address (required for check payments)"),
  accountNumber: z.string().optional().describe("Your account number with this vendor"),
  billCurrency: z.string().optional().describe("ISO currency code for bills from this vendor, e.g. USD"),
  description: z.string().optional(),
  additionalInfo: z
    .object({
      taxId: z.string().optional(),
      taxIdType: z.string().optional().describe("e.g. EIN or SSN"),
      track1099: z.boolean().optional(),
      companyName: z.string().optional(),
      leadTimeInDays: z.number().int().optional(),
    })
    .passthrough()
    .optional()
    .describe("Tax / 1099 and other supplementary vendor details"),
  paymentInformation: z
    .record(z.unknown())
    .optional()
    .describe("Payment preferences such as payeeName. Bank details are managed with the vendor bank account tools."),
  additionalFields,
};

function vendorBody(args: Record<string, unknown>, config: BillConfig, exclude: string[] = []): Record<string, unknown> {
  const body = buildBody(args, exclude);
  if (!config.enableMoneyMovement && enablesAutopay(body)) {
    throw new Error("Enabling vendor autoPay makes BILL pay bills automatically, and money movement is disabled. Set BILL_ENABLE_MONEY_MOVEMENT=true to allow it.");
  }
  return body;
}

export const vendorTools: ToolDefinition[] = [
  listTool({
    name: "bill_list_vendors",
    title: "List vendors",
    description: "Lists vendors (payees) in the BILL organization.",
    toolset: "vendors",
    path: "/vendors",
    archivable: true,
    convenience: {
      nameStartsWith: z.string().optional().describe("Only vendors whose name starts with this text"),
    },
    toFilters: (a) => (a.nameStartsWith ? [{ field: "name", op: "sw", value: a.nameStartsWith }] : []),
  }),

  getTool({
    name: "bill_get_vendor",
    title: "Get vendor",
    description: "Gets full details of one vendor, including address, payment information, and network status.",
    toolset: "vendors",
    path: "/vendors/{id}",
    idName: "vendorId",
    idDescription: "vendor (begins with 009)",
  }),

  defineTool({
    name: "bill_create_vendor",
    title: "Create vendor",
    description: "Creates a vendor. Add bank details afterwards with bill_create_vendor_bank_account for ACH payments.",
    toolset: "vendors",
    kind: "write",
    input: vendorFields,
    handler: (args, { client, config }) => client.post("/vendors", vendorBody(args, config)),
  }),

  defineTool({
    name: "bill_update_vendor",
    title: "Update vendor",
    description: "Updates only the supplied fields of a vendor (PATCH). Bank details cannot be changed here.",
    toolset: "vendors",
    kind: "write",
    idempotent: true,
    input: { vendorId: id("vendor"), ...vendorFields, name: vendorFields.name.optional() },
    handler: (args, { client, config }) =>
      client.patch(`/vendors/${encodeId(args.vendorId)}`, vendorBody(args, config, ["vendorId"])),
  }),

  defineTool({
    name: "bill_create_vendors_bulk",
    title: "Create vendors in bulk",
    description: "Creates several vendors in one request. Each entry accepts the same fields as bill_create_vendor.",
    toolset: "vendors",
    kind: "write",
    input: {
      vendors: z.array(z.object({ name: z.string().min(1) }).passthrough()).min(1).max(100),
    },
    handler: (args, { client, config }) => {
      if (!config.enableMoneyMovement && enablesAutopay(args.vendors)) {
        throw new Error("Enabling vendor autoPay requires BILL_ENABLE_MONEY_MOVEMENT=true.");
      }
      return client.post("/vendors/bulk", args.vendors);
    },
  }),

  getTool({
    name: "bill_get_vendor_bank_account",
    title: "Get vendor bank account",
    description: "Gets the (masked) bank account BILL pays this vendor into.",
    toolset: "vendors",
    path: "/vendors/{id}/bank-account",
    idName: "vendorId",
    idDescription: "vendor",
  }),

  defineTool({
    name: "bill_create_vendor_bank_account",
    title: "Add vendor bank account",
    description:
      "Adds the bank account BILL pays this vendor into (ACH). Changing where a vendor is paid is a common fraud vector: confirm the details out-of-band with the vendor first. Requires an MFA-trusted session in production; BILL takes ~2 business days to verify.",
    toolset: "vendors",
    kind: "money",
    input: {
      vendorId: id("vendor"),
      accountNumber: z.string().min(1),
      routingNumber: z.string().optional().describe("US ABA routing number"),
      nameOnAccount: z.string().optional(),
      payeeName: z.string().optional(),
      accountType: upperEnum(["CHECKING", "SAVINGS"]).optional(),
      ownerType: upperEnum(["BUSINESS", "PERSON"]).optional(),
      bankCountry: z.string().optional().describe("International vendors: bank country (ISO code)"),
      paymentCurrency: z.string().optional().describe("International vendors: payment currency"),
      additionalFields,
    },
    handler: (args, { client }) =>
      client.post(`/vendors/${encodeId(args.vendorId)}/bank-account`, buildBody(args, ["vendorId"])),
  }),

  defineTool({
    name: "bill_delete_vendor_bank_account",
    title: "Delete vendor bank account",
    description: "Removes a vendor's bank account. To change bank details, delete then create a new one.",
    toolset: "vendors",
    kind: "money",
    destructive: true,
    input: { vendorId: id("vendor") },
    handler: (args, { client }) => client.delete(`/vendors/${encodeId(args.vendorId)}/bank-account`),
  }),

  defineTool({
    name: "bill_get_international_payment_config",
    title: "Get international payment requirements",
    description:
      "Returns the fields and validation rules BILL requires to pay a vendor in a given country/currency. Use before creating an international vendor.",
    toolset: "vendors",
    kind: "read",
    input: {
      country: z.string().optional().describe("Vendor bank country (ISO code)"),
      currency: z.string().optional().describe("Payment currency (ISO code)"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Other query parameters"),
    },
    handler: (args, { client }) =>
      client.get("/vendors/configuration/international-payments", {
        ...(args.query ?? {}),
        country: args.country,
        currency: args.currency,
      }),
  }),
];
