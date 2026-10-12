import { z, type ZodRawShape } from "zod";
import type { Toolset } from "../config.js";
import type { ApiTarget } from "../bill/client.js";
import {
  FILTER_OPERATORS,
  fetchAll,
  listPage,
  projectFields,
  type FilterInput,
  type ListParams,
} from "../bill/list.js";
import { defineTool, type ToolContext, type ToolDefinition, type ToolRequirement } from "./registry.js";

// ------------------------------------------------------------------ shared schemas

export const id = (what: string) => z.string().min(1).describe(`BILL-generated ${what} id`);

export const isoDate = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .describe(`${what} (YYYY-MM-DD)`);

export const money = (what: string) => z.number().finite().describe(`${what}, in the record's currency (e.g. 125.50)`);

export const addressSchema = z
  .object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    stateOrProvince: z.string().optional().describe("State or province code, e.g. CA"),
    zipOrPostalCode: z.string().optional(),
    country: z.string().optional().describe("ISO country code, e.g. US"),
  })
  .passthrough();

export const classificationsSchema = z
  .object({
    chartOfAccountId: z.string().optional(),
    accountingClassId: z.string().optional(),
    departmentId: z.string().optional(),
    employeeId: z.string().optional(),
    itemId: z.string().optional(),
    jobId: z.string().optional(),
    locationId: z.string().optional(),
  })
  .passthrough()
  .describe("General-ledger classifications (ids from bill_list_classifications)");

export const additionalFields = z
  .record(z.unknown())
  .optional()
  .describe(
    "Any other BILL API fields to include in the request body verbatim (merged last). Use for fields not modeled explicitly.",
  );

const filterValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]);

export const filterSchema = z.union([
  z.object({
    field: z.string().describe("Filterable field, e.g. createdTime, vendorId, dueDate, archived"),
    op: z.enum(FILTER_OPERATORS).describe("eq, ne, gt, gte, lt, lte, in, nin, sw (starts with)"),
    value: filterValue.describe("Value to compare. Use an array with in/nin."),
  }),
  z.string().describe('Raw BILL filter expression, e.g. createdTime:gte:"2025-01-01T00:00:00.000Z"'),
]);

export const listInputShape = {
  filters: z
    .array(filterSchema)
    .optional()
    .describe("Filters combined with AND. Only fields BILL marks filterable for this object are accepted."),
  sort: z
    .array(z.object({ field: z.string(), order: z.enum(["asc", "desc"]).optional() }))
    .optional()
    .describe("Sort order, e.g. [{field: 'createdTime', order: 'desc'}]"),
  max: z.number().int().min(1).max(100).optional().describe("Page size (1-100, BILL default 20)"),
  page: z.string().optional().describe("Page token from a previous response's nextPage or prevPage"),
  fetchAll: z
    .boolean()
    .optional()
    .describe("Follow pagination and return every matching record (bounded by `limit` and BILL_MAX_FETCH_ALL)"),
  limit: z.number().int().min(1).optional().describe("With fetchAll: stop after this many records"),
  fields: z
    .array(z.string())
    .optional()
    .describe("Return only these fields of each record (dotted paths allowed) to keep responses small"),
};

export interface ListArgs {
  filters?: FilterInput[];
  sort?: Array<{ field: string; order?: "asc" | "desc" }>;
  max?: number;
  page?: string;
  fetchAll?: boolean;
  limit?: number;
  fields?: string[];
  includeArchived?: boolean;
}

// ------------------------------------------------------------------ body helpers

const CONTROL_KEYS = new Set(["additionalFields", "dryRun"]);

/** Builds a JSON body from tool args: drops undefined values and control keys, then merges additionalFields. */
export function buildBody(args: Record<string, unknown>, exclude: ReadonlyArray<string> = []): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || CONTROL_KEYS.has(key) || exclude.includes(key)) continue;
    body[key] = value;
  }
  const extra = args.additionalFields;
  if (extra && typeof extra === "object") Object.assign(body, extra);
  return body;
}

export function encodeId(value: string): string {
  return encodeURIComponent(value.trim());
}

/** Runs a list operation honoring the shared list arguments. */
export async function runList(
  ctx: ToolContext,
  path: string,
  args: ListArgs,
  extra: { filters?: FilterInput[]; query?: ListParams["query"]; api?: ApiTarget; archivable?: boolean } = {},
): Promise<Record<string, unknown>> {
  const filters: FilterInput[] = [...(args.filters ?? []), ...(extra.filters ?? [])];
  const mentionsArchived = filters.some((f) => (typeof f === "string" ? /^archived:/.test(f) : f.field === "archived"));
  if (extra.archivable && !args.includeArchived && !mentionsArchived) {
    filters.push({ field: "archived", op: "eq", value: false });
  }
  const params: ListParams = { filters, sort: args.sort, max: args.max, page: args.page, query: extra.query };
  const api = extra.api ?? "core";

  if (args.fetchAll) {
    const cap = Math.min(args.limit ?? ctx.config.maxFetchAllRecords, ctx.config.maxFetchAllRecords);
    const res = await fetchAll(ctx.client, path, params, cap, api);
    return {
      count: res.results.length,
      pagesFetched: res.pagesFetched,
      truncated: res.truncated,
      ...(res.nextPage ? { nextPage: res.nextPage } : {}),
      results: projectFields(res.results, args.fields),
    };
  }
  const res = await listPage(ctx.client, path, params, api);
  return {
    count: res.results.length,
    ...(res.nextPage ? { nextPage: res.nextPage } : {}),
    ...(res.prevPage ? { prevPage: res.prevPage } : {}),
    results: projectFields(res.results, args.fields),
  };
}

// ------------------------------------------------------------------ factories

interface ListToolSpec<S extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  path: string;
  api?: ApiTarget;
  requires?: ToolRequirement;
  /** Adds `includeArchived` and filters archived records out by default. */
  archivable?: boolean;
  /** Convenience arguments that are translated into filters/query parameters. */
  convenience?: S;
  toFilters?: (args: z.objectOutputType<S, z.ZodTypeAny>) => FilterInput[];
  toQuery?: (args: z.objectOutputType<S, z.ZodTypeAny>) => ListParams["query"];
}

export function listTool<S extends ZodRawShape = ZodRawShape>(spec: ListToolSpec<S>): ToolDefinition {
  const shape: ZodRawShape = {
    ...(spec.convenience ?? {}),
    ...listInputShape,
    ...(spec.archivable
      ? { includeArchived: z.boolean().optional().describe("Include archived records (default false)") }
      : {}),
  };
  return defineTool({
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Supports filters, sorting, pagination (page tokens), fetchAll, and field projection.`,
    toolset: spec.toolset,
    kind: "read",
    requires: spec.requires ?? (spec.api === "spend" ? "spend" : "core"),
    input: shape,
    handler: (args, ctx) => {
      const typed = args as z.objectOutputType<S, z.ZodTypeAny> & ListArgs;
      return runList(ctx, spec.path, typed, {
        filters: spec.toFilters?.(typed),
        query: spec.toQuery?.(typed),
        api: spec.api,
        archivable: spec.archivable,
      });
    },
  });
}

interface GetToolSpec {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  /** Path template; `{id}` is replaced with the encoded id. */
  path: string;
  idName: string;
  idDescription: string;
  api?: ApiTarget;
  requires?: ToolRequirement;
}

export function getTool(spec: GetToolSpec): ToolDefinition {
  return defineTool({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    toolset: spec.toolset,
    kind: "read",
    requires: spec.requires ?? (spec.api === "spend" ? "spend" : "core"),
    input: { [spec.idName]: id(spec.idDescription) },
    handler: (args, ctx) => {
      const value = String((args as Record<string, unknown>)[spec.idName]);
      return ctx.client.get(spec.path.replace("{id}", encodeId(value)), undefined, spec.api);
    },
  });
}

/** Optional lowercase/uppercase-insensitive enum for convenience filters. */
export const upperEnum = <T extends [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), z.enum(values));

export function dateRangeFilters(field: string, from?: string, to?: string): FilterInput[] {
  const out: FilterInput[] = [];
  if (from) out.push({ field, op: "gte", value: from });
  if (to) out.push({ field, op: "lte", value: to });
  return out;
}
