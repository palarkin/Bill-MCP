import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import { additionalFields, buildBody, dateRangeFilters, getTool, isoDate, listTool, upperEnum } from "./common.js";
import type { FilterInput } from "../bill/list.js";

/** BILL Spend & Expense (formerly Divvy): users, budgets, cards, transactions, reimbursements. */
export const spendTools: ToolDefinition[] = [
  defineTool({
    name: "bill_spend_get_current_user",
    title: "Spend: current user",
    description: "Gets the Spend & Expense user that owns the configured API token.",
    toolset: "spend",
    kind: "read",
    requires: "spend",
    input: {},
    handler: (_args, { client }) => client.get("/users/current", undefined, "spend"),
  }),

  listTool({
    name: "bill_spend_list_users",
    title: "Spend: list users",
    description: "Lists Spend & Expense users.",
    toolset: "spend",
    api: "spend",
    path: "/users",
  }),

  getTool({
    name: "bill_spend_get_user",
    title: "Spend: get user",
    description: "Gets one Spend & Expense user.",
    toolset: "spend",
    api: "spend",
    path: "/users/{id}",
    idName: "userId",
    idDescription: "Spend & Expense user",
  }),

  defineTool({
    name: "bill_spend_create_user",
    title: "Spend: create user",
    description: "Invites a Spend & Expense user.",
    toolset: "spend",
    kind: "write",
    requires: "spend",
    input: {
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().email(),
      role: upperEnum(["ADMIN", "AUDITOR", "BOOKKEEPER", "MEMBER"]),
      additionalFields,
    },
    handler: (args, { client }) => client.post("/users", buildBody(args), { api: "spend" }),
  }),

  listTool({
    name: "bill_spend_list_budgets",
    title: "Spend: list budgets",
    description: "Lists Spend & Expense budgets (spending policies with limits and reset intervals).",
    toolset: "spend",
    api: "spend",
    path: "/budgets",
  }),

  getTool({
    name: "bill_spend_get_budget",
    title: "Spend: get budget",
    description: "Gets one budget, including its current period spend.",
    toolset: "spend",
    api: "spend",
    path: "/budgets/{id}",
    idName: "budgetId",
    idDescription: "budget",
  }),

  defineTool({
    name: "bill_spend_create_budget",
    title: "Spend: create budget",
    description: "Creates a Spend & Expense budget. Members and owners are user ids from bill_spend_list_users.",
    toolset: "spend",
    kind: "write",
    requires: "spend",
    input: {
      name: z.string().min(1),
      description: z.string().optional(),
      recurringInterval: upperEnum(["NONE", "DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]).optional(),
      limit: z.number().nonnegative().optional().describe("Spend limit per period"),
      limitlessOverspend: z.boolean().optional(),
      expirationDate: isoDate("Budget expiration date").optional(),
      owners: z.array(z.string()).optional().describe("Budget owner user ids"),
      members: z.array(z.string()).optional().describe("Budget member user ids"),
      additionalFields,
    },
    handler: (args, { client }) => client.post("/budgets", buildBody(args), { api: "spend" }),
  }),

  listTool({
    name: "bill_spend_list_cards",
    title: "Spend: list cards",
    description: "Lists virtual and physical Spend & Expense cards.",
    toolset: "spend",
    api: "spend",
    path: "/cards",
    convenience: {
      userId: z.string().optional(),
      budgetId: z.string().optional(),
    },
    toFilters: (a) => {
      const f: FilterInput[] = [];
      if (a.userId) f.push({ field: "userId", op: "eq", value: a.userId });
      if (a.budgetId) f.push({ field: "budgetId", op: "eq", value: a.budgetId });
      return f;
    },
  }),

  getTool({
    name: "bill_spend_get_card",
    title: "Spend: get card",
    description: "Gets one card's (masked) details, limits, and status.",
    toolset: "spend",
    api: "spend",
    path: "/cards/{id}",
    idName: "cardId",
    idDescription: "card",
  }),

  listTool({
    name: "bill_spend_list_transactions",
    title: "Spend: list transactions",
    description: "Lists card transactions with merchant, amount, budget, receipt status, and decline reason.",
    toolset: "spend",
    api: "spend",
    path: "/transactions",
    convenience: {
      userId: z.string().optional(),
      budgetId: z.string().optional(),
      occurredFrom: isoDate("Transactions on or after").optional(),
      occurredTo: isoDate("Transactions on or before").optional(),
    },
    toFilters: (a) => {
      const f: FilterInput[] = [];
      if (a.userId) f.push({ field: "userId", op: "eq", value: a.userId });
      if (a.budgetId) f.push({ field: "budgetId", op: "eq", value: a.budgetId });
      f.push(
        ...dateRangeFilters(
          "occurredTime",
          a.occurredFrom ? `${a.occurredFrom}T00:00:00.000Z` : undefined,
          a.occurredTo ? `${a.occurredTo}T23:59:59.999Z` : undefined,
        ),
      );
      return f;
    },
  }),

  getTool({
    name: "bill_spend_get_transaction",
    title: "Spend: get transaction",
    description: "Gets one card transaction.",
    toolset: "spend",
    api: "spend",
    path: "/transactions/{id}",
    idName: "transactionId",
    idDescription: "transaction",
  }),

  listTool({
    name: "bill_spend_list_reimbursements",
    title: "Spend: list reimbursements",
    description: "Lists out-of-pocket reimbursement requests.",
    toolset: "spend",
    api: "spend",
    path: "/reimbursements",
  }),

  getTool({
    name: "bill_spend_get_reimbursement",
    title: "Spend: get reimbursement",
    description: "Gets one reimbursement request.",
    toolset: "spend",
    api: "spend",
    path: "/reimbursements/{id}",
    idName: "reimbursementId",
    idDescription: "reimbursement",
  }),
];
