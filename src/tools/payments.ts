import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import {
  additionalFields,
  buildBody,
  dateRangeFilters,
  encodeId,
  getTool,
  id,
  isoDate,
  listInputShape,
  listTool,
  runList,
  upperEnum,
  type ListArgs,
} from "./common.js";
import type { FilterInput } from "../bill/list.js";

const fundingAccount = z
  .object({
    type: upperEnum(["BANK_ACCOUNT", "CARD_ACCOUNT", "AP_CARD", "WALLET"]).describe(
      "Funding source type (BANK_ACCOUNT is most common)",
    ),
    id: z.string().min(1).describe("Funding account id (from bill_list_bank_accounts / bill_list_card_accounts)"),
  })
  .passthrough();

const processingOptions = z
  .object({
    requestPayFaster: z.boolean().optional().describe("Request faster (expedited) delivery where eligible"),
    requestCheckDeliveryType: z.string().optional(),
  })
  .passthrough()
  .optional();

// ---------------------------------------------------------------- approvals

export const approvalTools: ToolDefinition[] = [
  defineTool({
    name: "bill_list_pending_bill_approvals",
    title: "List bills awaiting my approval",
    description: "Lists bills waiting for the signed-in user's approval.",
    toolset: "approvals",
    kind: "read",
    input: listInputShape,
    handler: (args, ctx) => runList(ctx, "/bill-approvals/pending-user-approvals", args as ListArgs),
  }),

  defineTool({
    name: "bill_approve_or_deny_bills",
    title: "Approve or deny bills",
    description:
      "Approves or denies one or more bills as the signed-in approver. Approved bills become payable once every approver in the policy has approved.",
    toolset: "approvals",
    kind: "write",
    input: {
      actions: z
        .array(
          z
            .object({
              billId: z.string().min(1),
              action: upperEnum(["APPROVE", "DENY"]),
              comment: z.string().optional().describe("Reason or note (recommended when denying)"),
            })
            .passthrough(),
        )
        .min(1)
        .max(100),
    },
    handler: (args, { client }) => client.post("/bill-approvals/actions", args.actions),
  }),

  listTool({
    name: "bill_list_approval_policies",
    title: "List bill approval policies",
    description: "Lists the organization's bill approval policies (rules that route bills to approvers).",
    toolset: "approvals",
    path: "/bill-approvals/policies",
  }),
];

// ---------------------------------------------------------------- payments

export const paymentTools: ToolDefinition[] = [
  listTool({
    name: "bill_list_payments",
    title: "List AP payments",
    description: "Lists vendor payments (scheduled, in process, paid, cancelled, failed).",
    toolset: "payments",
    path: "/payments",
    convenience: {
      vendorId: z.string().optional(),
      createdFrom: isoDate("Created on or after").optional(),
      createdTo: isoDate("Created on or before").optional(),
    },
    toFilters: (a) => {
      const f: FilterInput[] = [];
      if (a.vendorId) f.push({ field: "vendorId", op: "eq", value: a.vendorId });
      f.push(
        ...dateRangeFilters(
          "createdTime",
          a.createdFrom ? `${a.createdFrom}T00:00:00.000Z` : undefined,
          a.createdTo ? `${a.createdTo}T23:59:59.999Z` : undefined,
        ),
      );
      return f;
    },
  }),

  getTool({
    name: "bill_get_payment",
    title: "Get AP payment",
    description: "Gets one vendor payment, including status, funding account, disbursement and bill allocations.",
    toolset: "payments",
    path: "/payments/{id}",
    idName: "paymentId",
    idDescription: "payment",
  }),

  defineTool({
    name: "bill_create_payment",
    title: "Pay a vendor",
    description:
      "Schedules a payment to a vendor for a bill (or creates the bill as part of the payment with createBill=true). Requires an MFA-trusted session. Verify vendor, amount, date and funding account with the user; consider dryRun first.",
    toolset: "payments",
    kind: "money",
    input: {
      vendorId: id("vendor"),
      billId: z.string().optional().describe("Bill to pay. Omit only when createBill is true."),
      amount: z.number().positive().describe("Payment amount"),
      processDate: isoDate("Date BILL should process the payment"),
      fundingAccount,
      createBill: z.boolean().optional().describe("Create a bill for this payment instead of paying an existing one"),
      description: z.string().optional(),
      processingOptions,
      additionalFields,
    },
    handler: (args, { client }) => {
      if (!args.billId && !args.createBill) throw new Error("Provide billId, or set createBill to true.");
      if (args.billId && args.createBill) throw new Error("Do not combine billId with createBill=true.");
      return client.post("/payments", buildBody(args));
    },
  }),

  defineTool({
    name: "bill_create_bulk_payments",
    title: "Pay multiple bills",
    description:
      "Schedules payments for multiple bills (and vendors) in one request. Requires an MFA-trusted session. Strongly consider dryRun first and confirm the totals with the user.",
    toolset: "payments",
    kind: "money",
    input: {
      processDate: isoDate("Date BILL should process the payments"),
      fundingAccount,
      payments: z
        .array(
          z
            .object({
              vendorId: z.string().optional(),
              billId: z.string().min(1),
              amount: z.number().positive(),
            })
            .passthrough(),
        )
        .min(1)
        .max(100),
      processingOptions,
      additionalFields,
    },
    handler: (args, { client }) => client.post("/payments/bulk", buildBody(args)),
  }),

  defineTool({
    name: "bill_cancel_payment",
    title: "Cancel AP payment",
    description: "Cancels a scheduled vendor payment that has not yet been processed.",
    toolset: "payments",
    kind: "write",
    destructive: true,
    input: { paymentId: id("payment") },
    handler: (args, { client }) => client.post(`/payments/${encodeId(args.paymentId)}/cancel`, {}),
  }),

  defineTool({
    name: "bill_get_exchange_rate",
    title: "Get FX exchange rate",
    description: "Gets BILL's current exchange rate for paying an international vendor in a foreign currency.",
    toolset: "payments",
    kind: "read",
    input: {
      vendorId: z.string().optional(),
      currency: z.string().optional().describe("Target currency (ISO code)"),
      amount: z.number().positive().optional(),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Other query parameters"),
    },
    handler: (args, { client }) =>
      client.get("/payments/exchange-rate", {
        ...(args.query ?? {}),
        vendorId: args.vendorId,
        currency: args.currency,
        amount: args.amount,
      }),
  }),
];
