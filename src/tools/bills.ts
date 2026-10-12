import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import {
  additionalFields,
  buildBody,
  classificationsSchema,
  dateRangeFilters,
  encodeId,
  getTool,
  id,
  isoDate,
  listTool,
  money,
} from "./common.js";
import type { FilterInput } from "../bill/list.js";
import { enablesAutopay } from "./raw.js";

function recurringBody(args: Record<string, unknown>, enableMoneyMovement: boolean, exclude: string[] = []) {
  const body = buildBody(args, exclude);
  if (!enableMoneyMovement && enablesAutopay(body)) {
    throw new Error("Auto-paying generated bills requires BILL_ENABLE_MONEY_MOVEMENT=true.");
  }
  return body;
}

const lineItem = z
  .object({
    amount: money("Line amount").optional(),
    quantity: z.number().optional().describe("With price, lets BILL calculate the amount"),
    price: z.number().optional(),
    description: z.string().optional(),
    classifications: classificationsSchema.optional(),
  })
  .passthrough();

const billFields = {
  vendorId: id("vendor"),
  dueDate: isoDate("Bill due date"),
  invoice: z
    .object({
      invoiceNumber: z.string().describe("The vendor's invoice number"),
      invoiceDate: isoDate("Invoice date"),
    })
    .passthrough()
    .describe("The vendor invoice this bill records"),
  billLineItems: z.array(lineItem).min(1).describe("At least one line item"),
  description: z.string().optional(),
  purchaseOrderNumber: z.string().optional(),
  payFromChartOfAccountId: z.string().optional().describe("Chart-of-accounts id the payment is drawn from"),
  vendorCredits: z
    .array(z.object({ id: z.string(), amount: z.number() }).passthrough())
    .optional()
    .describe("Vendor credits to apply to this bill"),
  additionalFields,
};

const PAYMENT_STATUSES = ["PAID", "UNPAID", "PARTIAL", "SCHEDULED", "PENDING", "IN_PROCESS"] as const;

export const billTools: ToolDefinition[] = [
  listTool({
    name: "bill_list_bills",
    title: "List bills",
    description: "Lists AP bills (amounts owed to vendors).",
    toolset: "bills",
    path: "/bills",
    archivable: true,
    convenience: {
      vendorId: z.string().optional().describe("Only bills for this vendor"),
      paymentStatus: z
        .array(z.enum(PAYMENT_STATUSES))
        .optional()
        .describe("Only bills in these payment statuses"),
      dueDateFrom: isoDate("Earliest due date").optional(),
      dueDateTo: isoDate("Latest due date").optional(),
    },
    toFilters: (a) => {
      const f: FilterInput[] = [];
      if (a.vendorId) f.push({ field: "vendorId", op: "eq", value: a.vendorId });
      if (a.paymentStatus?.length) f.push({ field: "paymentStatus", op: "in", value: a.paymentStatus });
      f.push(...dateRangeFilters("dueDate", a.dueDateFrom, a.dueDateTo));
      return f;
    },
  }),

  getTool({
    name: "bill_get_bill",
    title: "Get bill",
    description: "Gets full details of one bill, including line items, approval and payment status.",
    toolset: "bills",
    path: "/bills/{id}",
    idName: "billId",
    idDescription: "bill (begins with 00n)",
  }),

  defineTool({
    name: "bill_create_bill",
    title: "Create bill",
    description:
      "Creates an AP bill for a vendor. Line amounts may be given directly or as quantity × price. Use bill_find_duplicate_bills first if you suspect the invoice was already entered.",
    toolset: "bills",
    kind: "write",
    input: billFields,
    handler: (args, { client }) => client.post("/bills", buildBody(args)),
  }),

  defineTool({
    name: "bill_update_bill",
    title: "Update bill",
    description:
      "Updates only the supplied fields of a bill (PATCH). Supplying billLineItems may replace existing line items; fetch the bill first and send the complete set.",
    toolset: "bills",
    kind: "write",
    idempotent: true,
    input: {
      billId: id("bill"),
      vendorId: billFields.vendorId.optional(),
      dueDate: billFields.dueDate.optional(),
      invoice: billFields.invoice.optional(),
      billLineItems: billFields.billLineItems.optional(),
      description: billFields.description,
      purchaseOrderNumber: billFields.purchaseOrderNumber,
      payFromChartOfAccountId: billFields.payFromChartOfAccountId,
      vendorCredits: billFields.vendorCredits,
      additionalFields,
    },
    handler: (args, { client }) => client.patch(`/bills/${encodeId(args.billId)}`, buildBody(args, ["billId"])),
  }),

  defineTool({
    name: "bill_create_bills_bulk",
    title: "Create bills in bulk",
    description: "Creates several bills in one request. Each entry accepts the same fields as bill_create_bill.",
    toolset: "bills",
    kind: "write",
    input: {
      bills: z
        .array(z.object({ vendorId: z.string(), dueDate: z.string() }).passthrough())
        .min(1)
        .max(100),
    },
    handler: (args, { client }) => client.post("/bills/bulk", args.bills),
  }),

  defineTool({
    name: "bill_record_bill_payment",
    title: "Record external bill payment",
    description:
      "Records a payment made OUTSIDE of BILL (e.g. a manual check or wire) against one or more bills of a vendor, so they show as paid. Does not move money.",
    toolset: "bills",
    kind: "write",
    input: {
      vendorId: id("vendor"),
      processDate: isoDate("Date the payment was made"),
      payments: z
        .array(z.object({ billId: z.string(), amount: z.number().positive() }).passthrough())
        .min(1)
        .describe("Amount applied to each bill"),
      toPrintCheck: z.boolean().optional().describe("Check payments only: whether a check should be printed"),
      vendorCredits: z.array(z.object({ id: z.string(), amount: z.number() })).optional(),
      additionalFields,
    },
    handler: (args, { client }) => client.post("/bills/record-payment", buildBody(args)),
  }),

  // ---------------------------------------------------------------- vendor credits

  listTool({
    name: "bill_list_vendor_credits",
    title: "List vendor credits",
    description: "Lists vendor credits (amounts vendors owe you that can be applied to bills).",
    toolset: "bills",
    path: "/vendor-credits",
    archivable: true,
    convenience: { vendorId: z.string().optional() },
    toFilters: (a) => (a.vendorId ? [{ field: "vendorId", op: "eq", value: a.vendorId }] : []),
  }),

  getTool({
    name: "bill_get_vendor_credit",
    title: "Get vendor credit",
    description: "Gets one vendor credit.",
    toolset: "bills",
    path: "/vendor-credits/{id}",
    idName: "vendorCreditId",
    idDescription: "vendor credit",
  }),

  defineTool({
    name: "bill_create_vendor_credit",
    title: "Create vendor credit",
    description: "Creates a vendor credit that can later be applied to the vendor's bills.",
    toolset: "bills",
    kind: "write",
    input: {
      vendorId: id("vendor"),
      referenceNumber: z.string().optional().describe("Vendor's credit memo number"),
      creditDate: isoDate("Credit date").optional(),
      description: z.string().optional(),
      vendorCreditLineItems: z.array(lineItem).min(1).optional(),
      additionalFields,
    },
    handler: (args, { client }) => client.post("/vendor-credits", buildBody(args)),
  }),

  defineTool({
    name: "bill_update_vendor_credit",
    title: "Update vendor credit",
    description: "Updates only the supplied fields of a vendor credit (PATCH).",
    toolset: "bills",
    kind: "write",
    idempotent: true,
    input: {
      vendorCreditId: id("vendor credit"),
      referenceNumber: z.string().optional(),
      creditDate: isoDate("Credit date").optional(),
      description: z.string().optional(),
      vendorCreditLineItems: z.array(lineItem).optional(),
      additionalFields,
    },
    handler: (args, { client }) =>
      client.patch(`/vendor-credits/${encodeId(args.vendorCreditId)}`, buildBody(args, ["vendorCreditId"])),
  }),

  // ---------------------------------------------------------------- recurring bills

  listTool({
    name: "bill_list_recurring_bills",
    title: "List recurring bills",
    description: "Lists recurring bill schedules.",
    toolset: "bills",
    path: "/recurringbills",
    archivable: true,
    convenience: { vendorId: z.string().optional() },
    toFilters: (a) => (a.vendorId ? [{ field: "vendorId", op: "eq", value: a.vendorId }] : []),
  }),

  getTool({
    name: "bill_get_recurring_bill",
    title: "Get recurring bill",
    description: "Gets one recurring bill schedule.",
    toolset: "bills",
    path: "/recurringbills/{id}",
    idName: "recurringBillId",
    idDescription: "recurring bill",
  }),

  defineTool({
    name: "bill_create_recurring_bill",
    title: "Create recurring bill",
    description:
      "Creates a recurring bill schedule that generates bills automatically (and optionally auto-pays them via additionalFields).",
    toolset: "bills",
    kind: "write",
    input: {
      vendorId: id("vendor"),
      description: z.string().optional(),
      schedule: z
        .object({
          period: z.string().describe("e.g. MONTHLY, WEEKLY, YEARLY"),
          frequency: z.number().int().positive().optional().describe("Every N periods"),
          nextDueDate: isoDate("First/next due date"),
          endDate: isoDate("Last due date").optional(),
          daysInAdvance: z.number().int().optional().describe("Create each bill this many days before it is due"),
        })
        .passthrough(),
      recurringBillLineItems: z.array(lineItem).min(1),
      additionalFields,
    },
    handler: (args, { client, config }) =>
      client.post("/recurringbills", recurringBody(args, config.enableMoneyMovement)),
  }),

  defineTool({
    name: "bill_update_recurring_bill",
    title: "Update recurring bill",
    description: "Updates only the supplied fields of a recurring bill schedule (PATCH).",
    toolset: "bills",
    kind: "write",
    idempotent: true,
    input: {
      recurringBillId: id("recurring bill"),
      description: z.string().optional(),
      schedule: z.record(z.unknown()).optional(),
      recurringBillLineItems: z.array(lineItem).optional(),
      additionalFields,
    },
    handler: (args, { client, config }) =>
      client.patch(
        `/recurringbills/${encodeId(args.recurringBillId)}`,
        recurringBody(args, config.enableMoneyMovement, ["recurringBillId"]),
      ),
  }),
];
