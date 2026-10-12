import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import { additionalFields, buildBody, encodeId, getTool, id, listTool, runList, upperEnum } from "./common.js";

// ---------------------------------------------------------------- classifications (general ledger)

export const CLASSIFICATION_TYPES = {
  "chart-of-accounts": "Chart of accounts (GL accounts)",
  "accounting-classes": "Accounting classes",
  departments: "Departments",
  employees: "Employees",
  items: "Items (products/services)",
  jobs: "Jobs / projects",
  locations: "Locations",
} as const;

const classificationType = z
  .enum(Object.keys(CLASSIFICATION_TYPES) as [keyof typeof CLASSIFICATION_TYPES, ...Array<keyof typeof CLASSIFICATION_TYPES>])
  .describe(Object.entries(CLASSIFICATION_TYPES).map(([k, v]) => `${k}: ${v}`).join("; "));

const classificationPath = (type: string, recordId?: string) =>
  `/classifications/${type}${recordId ? `/${encodeId(recordId)}` : ""}`;

export const classificationTools: ToolDefinition[] = [
  defineTool({
    name: "bill_list_classifications",
    title: "List GL classifications",
    description:
      "Lists general-ledger classification records of one type: chart of accounts, accounting classes, departments, employees, items, jobs, or locations. Use the ids on bill/invoice line item classifications.",
    toolset: "classifications",
    kind: "read",
    input: {
      type: classificationType,
      nameStartsWith: z.string().optional(),
      includeArchived: z.boolean().optional(),
      max: z.number().int().min(1).max(100).optional(),
      page: z.string().optional(),
      fetchAll: z.boolean().optional(),
      limit: z.number().int().min(1).optional(),
      fields: z.array(z.string()).optional(),
    },
    handler: (args, ctx) =>
      runList(ctx, classificationPath(args.type), args, {
        archivable: true,
        filters: args.nameStartsWith ? [{ field: "name", op: "sw", value: args.nameStartsWith }] : [],
      }),
  }),

  defineTool({
    name: "bill_get_classification",
    title: "Get GL classification",
    description: "Gets one general-ledger classification record.",
    toolset: "classifications",
    kind: "read",
    input: { type: classificationType, classificationId: id("classification") },
    handler: (args, { client }) => client.get(classificationPath(args.type, args.classificationId)),
  }),

  defineTool({
    name: "bill_create_classification",
    title: "Create GL classification",
    description:
      "Creates a general-ledger classification record (e.g. a GL account, department, or item). If BILL syncs with an accounting system, create these there instead.",
    toolset: "classifications",
    kind: "write",
    input: {
      type: classificationType,
      name: z.string().min(1),
      description: z.string().optional(),
      parentId: z.string().optional().describe("Parent record id for hierarchical types"),
      accountNumber: z.string().optional().describe("chart-of-accounts only"),
      accountType: z.string().optional().describe("chart-of-accounts only, e.g. EXPENSE, INCOME, BANK"),
      additionalFields,
    },
    handler: (args, { client }) => client.post(classificationPath(args.type), buildBody(args, ["type"])),
  }),

  defineTool({
    name: "bill_update_classification",
    title: "Update GL classification",
    description: "Updates only the supplied fields of a general-ledger classification record (PATCH).",
    toolset: "classifications",
    kind: "write",
    idempotent: true,
    input: {
      type: classificationType,
      classificationId: id("classification"),
      name: z.string().optional(),
      description: z.string().optional(),
      parentId: z.string().optional(),
      additionalFields,
    },
    handler: (args, { client }) =>
      client.patch(classificationPath(args.type, args.classificationId), buildBody(args, ["type", "classificationId"])),
  }),

  defineTool({
    name: "bill_set_classification_archived",
    title: "Archive / restore GL classification",
    description: "Archives (hides) or restores a general-ledger classification record.",
    toolset: "classifications",
    kind: "write",
    idempotent: true,
    input: {
      type: classificationType,
      classificationId: id("classification"),
      archived: z.boolean().describe("true to archive, false to restore"),
    },
    handler: (args, { client }) =>
      client.post(`${classificationPath(args.type, args.classificationId)}/${args.archived ? "archive" : "restore"}`, {}),
  }),
];

// ---------------------------------------------------------------- funding accounts

export const fundingTools: ToolDefinition[] = [
  listTool({
    name: "bill_list_bank_accounts",
    title: "List organization bank accounts",
    description: "Lists the organization's bank accounts usable to fund payments (ids are needed for fundingAccount).",
    toolset: "funding",
    path: "/funding-accounts/banks",
    archivable: true,
  }),
  getTool({
    name: "bill_get_bank_account",
    title: "Get organization bank account",
    description: "Gets one organization bank account, including verification status.",
    toolset: "funding",
    path: "/funding-accounts/banks/{id}",
    idName: "bankAccountId",
    idDescription: "bank account",
  }),
  listTool({
    name: "bill_list_card_accounts",
    title: "List organization card accounts",
    description: "Lists the organization's card funding accounts.",
    toolset: "funding",
    path: "/funding-accounts/cards",
  }),
  getTool({
    name: "bill_get_card_account",
    title: "Get organization card account",
    description: "Gets one organization card funding account.",
    toolset: "funding",
    path: "/funding-accounts/cards/{id}",
    idName: "cardAccountId",
    idDescription: "card account",
  }),
];

// ---------------------------------------------------------------- organization, users, roles

export const organizationTools: ToolDefinition[] = [
  defineTool({
    name: "bill_get_organization",
    title: "Get organization",
    description: "Gets the BILL organization's profile (defaults to the signed-in organization).",
    toolset: "organization",
    kind: "read",
    input: { organizationId: z.string().optional() },
    handler: async (args, { client }) => {
      const orgId = args.organizationId ?? (await client.ensureSession()).organizationId;
      return client.get(`/organizations/${encodeId(orgId)}`);
    },
  }),

  listTool({
    name: "bill_list_users",
    title: "List users",
    description: "Lists users of the BILL organization.",
    toolset: "organization",
    path: "/users",
    archivable: true,
  }),

  getTool({
    name: "bill_get_user",
    title: "Get user",
    description: "Gets one organization user.",
    toolset: "organization",
    path: "/users/{id}",
    idName: "userId",
    idDescription: "user",
  }),

  defineTool({
    name: "bill_create_user",
    title: "Invite user",
    description: "Creates (invites) an organization user with a role. Get role ids from bill_list_roles.",
    toolset: "organization",
    kind: "write",
    input: {
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: z.string().email(),
      roleId: z.string().min(1).describe("Role id (begins with 0po)"),
      additionalFields,
    },
    handler: (args, { client }) => client.post("/users", buildBody(args)),
  }),

  defineTool({
    name: "bill_update_user",
    title: "Update user",
    description: "Updates only the supplied fields of a user (PATCH), e.g. to change their role.",
    toolset: "organization",
    kind: "write",
    idempotent: true,
    input: {
      userId: id("user"),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      roleId: z.string().optional(),
      additionalFields,
    },
    handler: (args, { client }) => client.patch(`/users/${encodeId(args.userId)}`, buildBody(args, ["userId"])),
  }),

  listTool({
    name: "bill_list_roles",
    title: "List user roles",
    description: "Lists user roles (Administrator, Accountant, Approver, Payer, Clerk, Auditor, and custom roles).",
    toolset: "organization",
    path: "/roles",
  }),

  getTool({
    name: "bill_get_role",
    title: "Get user role",
    description: "Gets one user role and its permissions.",
    toolset: "organization",
    path: "/roles/{id}",
    idName: "roleId",
    idDescription: "role",
  }),
];

// ---------------------------------------------------------------- archive / restore

export const ARCHIVABLE_OBJECTS = {
  vendor: "/vendors",
  bill: "/bills",
  "vendor-credit": "/vendor-credits",
  "recurring-bill": "/recurringbills",
  customer: "/customers",
  invoice: "/invoices",
  user: "/users",
  "bank-account": "/funding-accounts/banks",
} as const;

const archivableType = upperEnum(
  Object.keys(ARCHIVABLE_OBJECTS).map((k) => k.toUpperCase()) as [string, ...string[]],
).transform((v) => v.toLowerCase() as keyof typeof ARCHIVABLE_OBJECTS);

export const archiveTools: ToolDefinition[] = [
  defineTool({
    name: "bill_archive_object",
    title: "Archive record",
    description:
      "Archives a vendor, bill, vendor credit, recurring bill, customer, invoice, user, or bank account. Archived records are hidden from lists and can be restored with bill_restore_object.",
    toolset: "organization",
    kind: "write",
    destructive: true,
    idempotent: true,
    input: {
      objectType: archivableType.describe(`One of: ${Object.keys(ARCHIVABLE_OBJECTS).join(", ")}`),
      objectId: id("record"),
    },
    handler: (args, { client }) =>
      client.post(`${ARCHIVABLE_OBJECTS[args.objectType]}/${encodeId(args.objectId)}/archive`, {}),
  }),

  defineTool({
    name: "bill_restore_object",
    title: "Restore archived record",
    description: "Restores a previously archived record.",
    toolset: "organization",
    kind: "write",
    idempotent: true,
    input: {
      objectType: archivableType.describe(`One of: ${Object.keys(ARCHIVABLE_OBJECTS).join(", ")}`),
      objectId: id("record"),
    },
    handler: (args, { client }) =>
      client.post(`${ARCHIVABLE_OBJECTS[args.objectType]}/${encodeId(args.objectId)}/restore`, {}),
  }),
];
