import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import {
  additionalFields,
  addressSchema,
  buildBody,
  classificationsSchema,
  dateRangeFilters,
  encodeId,
  getTool,
  id,
  isoDate,
  listTool,
  money,
  upperEnum,
} from "./common.js";
import type { FilterInput } from "../bill/list.js";

// ---------------------------------------------------------------- customers

const customerFields = {
  name: z.string().min(1).describe("Customer name"),
  email: z.string().email().optional(),
  accountType: upperEnum(["BUSINESS", "PERSON", "NONE"]).optional(),
  phone: z.string().optional(),
  accountNumber: z.string().optional().describe("Your account number for this customer"),
  description: z.string().optional(),
  contact: z
    .object({ firstName: z.string().optional(), lastName: z.string().optional() })
    .passthrough()
    .optional(),
  billingAddress: addressSchema.optional(),
  shippingAddress: addressSchema.optional(),
  additionalFields,
};

export const customerTools: ToolDefinition[] = [
  listTool({
    name: "bill_list_customers",
    title: "List customers",
    description: "Lists AR customers.",
    toolset: "customers",
    path: "/customers",
    archivable: true,
    convenience: { nameStartsWith: z.string().optional().describe("Only customers whose name starts with this text") },
    toFilters: (a) => (a.nameStartsWith ? [{ field: "name", op: "sw", value: a.nameStartsWith }] : []),
  }),

  getTool({
    name: "bill_get_customer",
    title: "Get customer",
    description: "Gets one customer, including balance and charge authorization status.",
    toolset: "customers",
    path: "/customers/{id}",
    idName: "customerId",
    idDescription: "customer (begins with 0cu)",
  }),

  defineTool({
    name: "bill_create_customer",
    title: "Create customer",
    description: "Creates an AR customer.",
    toolset: "customers",
    kind: "write",
    input: customerFields,
    handler: (args, { client }) => client.post("/customers", buildBody(args)),
  }),

  defineTool({
    name: "bill_update_customer",
    title: "Update customer",
    description: "Updates only the supplied fields of a customer (PATCH).",
    toolset: "customers",
    kind: "write",
    idempotent: true,
    input: { customerId: id("customer"), ...customerFields, name: customerFields.name.optional() },
    handler: (args, { client }) =>
      client.patch(`/customers/${encodeId(args.customerId)}`, buildBody(args, ["customerId"])),
  }),

  defineTool({
    name: "bill_authorize_customer_charge",
    title: "Record customer charge authorization",
    description:
      "Records that the customer has authorized you to debit their bank account (sets authorizedToCharge), a prerequisite for bill_charge_customer. Only use with documented customer consent.",
    toolset: "customers",
    kind: "money",
    input: { customerId: id("customer"), additionalFields },
    handler: (args, { client }) =>
      client.post(`/customers/${encodeId(args.customerId)}/charge-authorization`, buildBody(args, ["customerId"])),
  }),
];

// ---------------------------------------------------------------- invoices

const invoiceLineItem = z
  .object({
    quantity: z.number().positive().optional(),
    price: z.number().optional().describe("Unit price"),
    description: z.string().optional(),
    classifications: classificationsSchema.optional(),
  })
  .passthrough();

export const invoiceTools: ToolDefinition[] = [
  listTool({
    name: "bill_list_invoices",
    title: "List invoices",
    description: "Lists AR invoices (amounts customers owe you).",
    toolset: "invoices",
    path: "/invoices",
    archivable: true,
    convenience: {
      customerId: z.string().optional(),
      status: z.array(z.string()).optional().describe("Only invoices in these statuses, e.g. OPEN, PARTIAL_PAYMENT, PAID_IN_FULL"),
      dueDateFrom: isoDate("Earliest due date").optional(),
      dueDateTo: isoDate("Latest due date").optional(),
      invoiceDateFrom: isoDate("Earliest invoice date").optional(),
      invoiceDateTo: isoDate("Latest invoice date").optional(),
    },
    toFilters: (a) => {
      const f: FilterInput[] = [];
      if (a.customerId) f.push({ field: "customerId", op: "eq", value: a.customerId });
      if (a.status?.length) f.push({ field: "status", op: "in", value: a.status.map((s) => s.toUpperCase()) });
      f.push(...dateRangeFilters("dueDate", a.dueDateFrom, a.dueDateTo));
      f.push(...dateRangeFilters("invoiceDate", a.invoiceDateFrom, a.invoiceDateTo));
      return f;
    },
  }),

  getTool({
    name: "bill_get_invoice",
    title: "Get invoice",
    description: "Gets one invoice with line items, amounts due and status.",
    toolset: "invoices",
    path: "/invoices/{id}",
    idName: "invoiceId",
    idDescription: "invoice (begins with 00e)",
  }),

  defineTool({
    name: "bill_create_invoice",
    title: "Create invoice",
    description:
      "Creates an AR invoice for an existing customer (customerId) or a new one (customerName + customerEmail). Set sendEmail to email it immediately.",
    toolset: "invoices",
    kind: "write",
    input: {
      customerId: z.string().optional().describe("Existing customer id"),
      customerName: z.string().optional().describe("Creates a new customer when customerId is not given"),
      customerEmail: z.string().email().optional(),
      invoiceNumber: z.string().min(1),
      invoiceDate: isoDate("Invoice date"),
      dueDate: isoDate("Due date"),
      invoiceLineItems: z.array(invoiceLineItem).min(1),
      description: z.string().optional(),
      sendEmail: z.boolean().optional().describe("Email the invoice to the customer on creation"),
      additionalFields,
    },
    handler: (args, { client }) => {
      if (!args.customerId && !args.customerName) throw new Error("Provide customerId, or customerName and customerEmail.");
      const body = buildBody(args, ["customerId", "customerName", "customerEmail", "sendEmail"]);
      body.customer = args.customerId ? { id: args.customerId } : { name: args.customerName, email: args.customerEmail };
      if (args.sendEmail !== undefined) {
        body.processingOptions = { ...((body.processingOptions as object) ?? {}), sendEmail: args.sendEmail };
      }
      return client.post("/invoices", body);
    },
  }),

  defineTool({
    name: "bill_update_invoice",
    title: "Update invoice",
    description:
      "Updates only the supplied fields of an invoice (PATCH). Supplying invoiceLineItems may replace existing lines; send the complete set.",
    toolset: "invoices",
    kind: "write",
    idempotent: true,
    input: {
      invoiceId: id("invoice"),
      invoiceNumber: z.string().optional(),
      invoiceDate: isoDate("Invoice date").optional(),
      dueDate: isoDate("Due date").optional(),
      invoiceLineItems: z.array(invoiceLineItem).optional(),
      description: z.string().optional(),
      additionalFields,
    },
    handler: (args, { client }) => client.patch(`/invoices/${encodeId(args.invoiceId)}`, buildBody(args, ["invoiceId"])),
  }),

  defineTool({
    name: "bill_send_invoice",
    title: "Email invoice",
    description: "Emails an existing invoice (with its payment link) to one or more recipients.",
    toolset: "invoices",
    kind: "write",
    input: {
      invoiceId: id("invoice"),
      to: z.array(z.string().email()).min(1).describe("Recipient email addresses"),
      cc: z.array(z.string().email()).optional(),
      additionalFields,
    },
    handler: (args, { client }) => {
      const body: Record<string, unknown> = {
        recipient: { to: args.to, ...(args.cc?.length ? { cc: args.cc } : {}) },
        ...(args.additionalFields ?? {}),
      };
      return client.post(`/invoices/${encodeId(args.invoiceId)}/email`, body);
    },
  }),

  defineTool({
    name: "bill_record_invoice_payment",
    title: "Record external invoice payment",
    description:
      "Records a customer payment received OUTSIDE of BILL (check, cash, card elsewhere) and applies it to invoices. Any unapplied remainder becomes customer credit. Does not move money.",
    toolset: "invoices",
    kind: "write",
    input: {
      customerId: id("customer"),
      amount: money("Total amount received"),
      paymentDate: isoDate("Date received"),
      paymentType: upperEnum(["CASH", "CHECK", "CREDIT_CARD", "ACH", "PAYPAL", "OTHER"]).describe("How the payment was made"),
      invoices: z
        .array(z.object({ id: z.string().min(1), amount: z.number().positive() }))
        .min(1)
        .describe("Invoices and the amount applied to each"),
      referenceNumber: z.string().optional().describe("e.g. check number"),
      description: z.string().optional(),
      additionalFields,
    },
    handler: (args, { client }) => {
      const applied = args.invoices.reduce((s, i) => s + i.amount, 0);
      if (applied - args.amount > 0.005) {
        throw new Error(`Invoice allocations (${applied.toFixed(2)}) exceed the payment amount (${args.amount.toFixed(2)}).`);
      }
      return client.post("/invoices/record-payment", buildBody(args));
    },
  }),
];

// ---------------------------------------------------------------- receivable payments

export const receivablePaymentTools: ToolDefinition[] = [
  listTool({
    name: "bill_list_receivable_payments",
    title: "List AR payments",
    description: "Lists payments received from customers (through BILL or recorded).",
    toolset: "receivables",
    path: "/receivable-payments",
    convenience: { customerId: z.string().optional() },
    toFilters: (a) => (a.customerId ? [{ field: "customerId", op: "eq", value: a.customerId }] : []),
  }),

  getTool({
    name: "bill_get_receivable_payment",
    title: "Get AR payment",
    description: "Gets one customer payment.",
    toolset: "receivables",
    path: "/receivable-payments/{id}",
    idName: "receivablePaymentId",
    idDescription: "receivable payment",
  }),

  defineTool({
    name: "bill_charge_customer",
    title: "Charge customer",
    description:
      "Debits a customer's bank account to pay one or more of their invoices. The customer must have authorizedToCharge=true and a bank account on file. Confirm amount and invoices with the user.",
    toolset: "receivables",
    kind: "money",
    input: {
      customerId: id("customer"),
      fundingAccount: z
        .object({ type: z.string().default("BANK_ACCOUNT"), id: z.string().min(1) })
        .passthrough()
        .describe("Customer bank account to debit"),
      invoicePayments: z
        .array(z.object({ invoiceId: z.string().min(1), amount: z.number().positive() }).passthrough())
        .min(1),
      processDate: isoDate("Date to process the charge").optional(),
      description: z.string().optional(),
      additionalFields,
    },
    handler: (args, { client }) => client.post("/receivable-payments", buildBody(args)),
  }),
];
