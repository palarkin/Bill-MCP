import type { ApiTarget, BillClient } from "./client.js";

export const FILTER_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "sw"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterValue = string | number | boolean | ReadonlyArray<string | number>;

export interface StructuredFilter {
  field: string;
  op: FilterOperator;
  value: FilterValue;
}

/** A filter is either structured or a raw `field:op:value` expression passed through verbatim. */
export type FilterInput = StructuredFilter | string;

const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]*$/;

function formatValue(op: FilterOperator, value: FilterValue): string {
  if (Array.isArray(value)) {
    if (op !== "in" && op !== "nin") {
      throw new Error(`Operator "${op}" does not accept a list of values; use "in" or "nin".`);
    }
    // BILL expects list values as one quoted, comma-separated string: currency:in:"USD,CAD"
    return `"${value.map((v) => String(v).replace(/"/g, "")).join(",")}"`;
  }
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/** Serializes filters into BILL's `filters` query parameter: `field:op:value,field:op:value`. */
export function buildFilterString(filters: ReadonlyArray<FilterInput> | undefined): string | undefined {
  if (!filters || filters.length === 0) return undefined;
  const parts = filters.map((f) => {
    if (typeof f === "string") return f.trim();
    if (!FIELD_PATTERN.test(f.field)) throw new Error(`Invalid filter field name: ${JSON.stringify(f.field)}`);
    return `${f.field}:${f.op}:${formatValue(f.op, f.value)}`;
  });
  return parts.filter(Boolean).join(",") || undefined;
}

export interface SortInput {
  field: string;
  order?: "asc" | "desc";
}

export function buildSortString(sort: ReadonlyArray<SortInput> | string | undefined): string | undefined {
  if (!sort) return undefined;
  if (typeof sort === "string") return sort.trim() || undefined;
  if (sort.length === 0) return undefined;
  return sort
    .map((s) => {
      if (!FIELD_PATTERN.test(s.field)) throw new Error(`Invalid sort field name: ${JSON.stringify(s.field)}`);
      return `${s.field}:${s.order ?? "asc"}`;
    })
    .join(",");
}

export interface ListParams {
  filters?: ReadonlyArray<FilterInput>;
  sort?: ReadonlyArray<SortInput> | string;
  /** Page size, 1-100. */
  max?: number;
  /** Opaque page token from a previous response's nextPage/prevPage. */
  page?: string;
  /** Additional, endpoint-specific query parameters. */
  query?: Record<string, string | number | boolean | undefined>;
}

export interface ListPage<T = Record<string, unknown>> {
  results: T[];
  nextPage?: string;
  prevPage?: string;
}

export function listQuery(params: ListParams): Record<string, string | number | boolean | undefined> {
  return {
    ...params.query,
    max: params.max,
    page: params.page,
    sort: buildSortString(params.sort),
    filters: buildFilterString(params.filters),
  };
}

function normalizePage<T>(raw: unknown): ListPage<T> {
  if (Array.isArray(raw)) return { results: raw as T[] };
  const obj = (raw ?? {}) as Record<string, unknown>;
  const results = Array.isArray(obj.results) ? (obj.results as T[]) : Array.isArray(obj.data) ? (obj.data as T[]) : [];
  return {
    results,
    nextPage: typeof obj.nextPage === "string" && obj.nextPage ? obj.nextPage : undefined,
    prevPage: typeof obj.prevPage === "string" && obj.prevPage ? obj.prevPage : undefined,
  };
}

export async function listPage<T = Record<string, unknown>>(
  client: BillClient,
  path: string,
  params: ListParams,
  api: ApiTarget = "core",
): Promise<ListPage<T>> {
  const raw = await client.get(path, listQuery(params), api);
  return normalizePage<T>(raw);
}

export interface FetchAllResult<T> {
  results: T[];
  pagesFetched: number;
  truncated: boolean;
  /** Token to resume from when truncated. */
  nextPage?: string;
}

/** Follows nextPage tokens (100 records per page) until exhausted or `limit` records are collected. */
export async function fetchAll<T = Record<string, unknown>>(
  client: BillClient,
  path: string,
  params: ListParams,
  limit: number,
  api: ApiTarget = "core",
): Promise<FetchAllResult<T>> {
  const results: T[] = [];
  let page = params.page;
  let pagesFetched = 0;
  const seen = new Set<string>();

  for (;;) {
    const res = await listPage<T>(client, path, { ...params, max: params.max ?? 100, page }, api);
    pagesFetched++;
    results.push(...res.results);
    if (results.length >= limit) {
      const truncated = results.length > limit || res.nextPage !== undefined;
      return { results: results.slice(0, limit), pagesFetched, truncated, nextPage: res.nextPage };
    }
    if (!res.nextPage || res.results.length === 0 || seen.has(res.nextPage)) {
      return { results, pagesFetched, truncated: false };
    }
    seen.add(res.nextPage);
    page = res.nextPage;
  }
}

/** Keeps only the requested top-level (or dotted nested) fields of each record. */
export function projectFields<T>(records: T[], fields: ReadonlyArray<string> | undefined): unknown[] {
  if (!fields || fields.length === 0) return records;
  return records.map((record) => {
    if (!record || typeof record !== "object") return record;
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = getPath(record as Record<string, unknown>, field);
      if (value !== undefined) setPath(out, field, value);
    }
    return out;
  });
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}
