import { z } from "zod";
import { defineTool, type ToolContext, type ToolDefinition } from "./registry.js";
import { isoDate } from "./common.js";
import { fetchAll, type FilterInput } from "../bill/list.js";
import { BillApiError } from "../bill/errors.js";

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------- field accessors (tolerant of shape drift)

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function nested(rec: Rec, key: string, field: string): unknown {
  const obj = rec[key];
  return obj && typeof obj === "object" ? (obj as Rec)[field] : undefined;
}

/** Outstanding amount on a bill or invoice. */
export function openBalance(rec: Rec): number {
  const status = String(rec.paymentStatus ?? rec.status ?? "").toUpperCase();
  if (status === "PAID" || status === "PAID_IN_FULL" || rec.archived === true) return 0;
  const due = num(rec.dueAmount) ?? num(rec.balance) ?? num(rec.amountDue);
  if (due !== undefined) return due;
  const total = num(rec.amount) ?? num(rec.totalAmount) ?? 0;
  const paid = num(rec.paidAmount) ?? num(rec.amountPaid) ?? 0;
  return total - paid;
}

export function partyOf(rec: Rec, kind: "vendor" | "customer"): { id: string; name: string } {
  const pid = String(rec[`${kind}Id`] ?? nested(rec, kind, "id") ?? "unknown");
  const name = String(rec[`${kind}Name`] ?? nested(rec, kind, "name") ?? pid);
  return { id: pid, name };
}

export function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const DAY_MS = 86_400_000;

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(dueDate: Date | undefined, asOf: Date): AgingBucket {
  if (!dueDate) return "current";
  const daysPastDue = Math.floor((asOf.getTime() - dueDate.getTime()) / DAY_MS);
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetches all records with server-side filters, falling back to fetching without the optional filters
 * (and filtering locally) if BILL rejects them, e.g. because a field is not filterable for this object.
 */
async function gather(
  ctx: ToolContext,
  path: string,
  required: FilterInput[],
  optional: FilterInput[],
  localFilter: (r: Rec) => boolean,
): Promise<{ records: Rec[]; truncated: boolean; serverFiltered: boolean }> {
  const cap = ctx.config.maxFetchAllRecords;
  try {
    const res = await fetchAll<Rec>(ctx.client, path, { filters: [...required, ...optional] }, cap);
    return { records: res.results.filter(localFilter), truncated: res.truncated, serverFiltered: true };
  } catch (err) {
    if (!(err instanceof BillApiError) || err.status !== 400 || optional.length === 0) throw err;
    const res = await fetchAll<Rec>(ctx.client, path, { filters: required }, cap);
    return { records: res.results.filter(localFilter), truncated: res.truncated, serverFiltered: false };
  }
}

function agingReport(records: Rec[], kind: "vendor" | "customer", asOf: Date, topN: number, includeDetail: boolean) {
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  const counts = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  const byParty = new Map<string, { id: string; name: string; total: number } & Record<AgingBucket, number>>();
  const detail: Rec[] = [];

  for (const rec of records) {
    const balance = openBalance(rec);
    if (balance <= 0.005) continue;
    const due = parseDate(rec.dueDate);
    const bucket = agingBucket(due, asOf);
    totals[bucket] += balance;
    counts[bucket]++;
    const party = partyOf(rec, kind);
    const row =
      byParty.get(party.id) ??
      ({ ...party, total: 0, ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) } as {
        id: string;
        name: string;
        total: number;
      } & Record<AgingBucket, number>);
    row[bucket] += balance;
    row.total += balance;
    byParty.set(party.id, row);
    if (includeDetail) {
      detail.push({
        id: rec.id,
        [kind]: party.name,
        number: rec.invoiceNumber ?? nested(rec, "invoice", "invoiceNumber"),
        dueDate: rec.dueDate,
        daysPastDue: due ? Math.max(0, Math.floor((asOf.getTime() - due.getTime()) / DAY_MS)) : null,
        openBalance: round2(balance),
        bucket,
      });
    }
  }

  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  const parties = [...byParty.values()].sort((a, b) => b.total - a.total);
  return {
    asOf: asOf.toISOString().slice(0, 10),
    totalOutstanding: round2(grandTotal),
    pastDue: round2(grandTotal - totals.current),
    buckets: AGING_BUCKETS.map((b) => ({
      bucket: b,
      amount: round2(totals[b]),
      count: counts[b],
      percent: grandTotal > 0 ? round2((totals[b] / grandTotal) * 100) : 0,
    })),
    [`top${kind === "vendor" ? "Vendors" : "Customers"}`]: parties.slice(0, topN).map((p) => ({
      id: p.id,
      name: p.name,
      total: round2(p.total),
      ...Object.fromEntries(AGING_BUCKETS.map((b) => [b, round2(p[b])])),
    })),
    [`${kind}Count`]: parties.length,
    ...(includeDetail ? { items: detail.sort((a, b) => Number(b.daysPastDue ?? 0) - Number(a.daysPastDue ?? 0)) } : {}),
  };
}

// ---------------------------------------------------------------- fuzzy matching

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, " ");
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Similarity in [0, 1]: exact/prefix/substring matches score high, otherwise Dice coefficient on bigrams. */
export function nameSimilarity(query: string, candidate: string): number {
  const a = normalizeName(query);
  const b = normalizeName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a)) return 0.92;
  if (b.includes(a)) return 0.85;
  if (a.includes(b)) return 0.75;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  const total = [...ga.values()].reduce((x, y) => x + y, 0) + [...gb.values()].reduce((x, y) => x + y, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

export function normalizeInvoiceNumber(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^(inv|invoice)/, "")
    .replace(/^0+/, "");
}

function findTool(kind: "vendor" | "customer"): ToolDefinition {
  const plural = kind === "vendor" ? "vendors" : "customers";
  return defineTool({
    name: `bill_find_${plural}`,
    title: `Find ${plural} by name`,
    description: `Fuzzy-searches ${plural} by name (tolerates typos, punctuation, and suffixes like Inc/LLC) and returns the best matches with ids. Use to resolve a name the user mentions to a BILL ${kind} id.`,
    toolset: "analytics",
    kind: "read",
    input: {
      query: z.string().min(1).describe(`${kind} name or part of it`),
      maxResults: z.number().int().min(1).max(50).optional().describe("Default 5"),
      minScore: z.number().min(0).max(1).optional().describe("Minimum similarity 0-1 (default 0.35)"),
      includeArchived: z.boolean().optional(),
    },
    handler: async (args, ctx) => {
      const filters: FilterInput[] = args.includeArchived ? [] : [{ field: "archived", op: "eq", value: false }];
      const res = await fetchAll<Rec>(ctx.client, `/${plural}`, { filters }, ctx.config.maxFetchAllRecords);
      const scored = res.results
        .map((r) => ({ r, score: nameSimilarity(args.query, String(r.name ?? "")) }))
        .filter((x) => x.score >= (args.minScore ?? 0.35))
        .sort((a, b) => b.score - a.score)
        .slice(0, args.maxResults ?? 5)
        .map(({ r, score }) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          archived: r.archived,
          score: round2(score),
        }));
      return { query: args.query, searched: res.results.length, truncated: res.truncated, matches: scored };
    },
  });
}

// ---------------------------------------------------------------- tools

export const analyticsTools: ToolDefinition[] = [
  findTool("vendor"),
  findTool("customer"),

  defineTool({
    name: "bill_ap_aging_report",
    title: "AP aging report",
    description:
      "Accounts-payable aging: open bill balances bucketed by days past due (current, 1-30, 31-60, 61-90, 90+), with totals and top vendors.",
    toolset: "analytics",
    kind: "read",
    input: {
      asOf: isoDate("Aging date (default today)").optional(),
      vendorId: z.string().optional().describe("Limit to one vendor"),
      topN: z.number().int().min(1).max(200).optional().describe("Vendors to list (default 15)"),
      includeDetail: z.boolean().optional().describe("Include each open bill (default false)"),
    },
    handler: async (args, ctx) => {
      const asOf = parseDate(args.asOf ?? today())!;
      const required: FilterInput[] = [{ field: "archived", op: "eq", value: false }];
      if (args.vendorId) required.push({ field: "vendorId", op: "eq", value: args.vendorId });
      const { records, truncated } = await gather(ctx, "/bills", required, [], () => true);
      return {
        ...agingReport(records, "vendor", asOf, args.topN ?? 15, args.includeDetail ?? false),
        recordsScanned: records.length,
        ...(truncated ? { warning: "Record limit reached; totals may be incomplete. Raise BILL_MAX_FETCH_ALL." } : {}),
      };
    },
  }),

  defineTool({
    name: "bill_ar_aging_report",
    title: "AR aging report",
    description:
      "Accounts-receivable aging: open invoice balances bucketed by days past due (current, 1-30, 31-60, 61-90, 90+), with totals and top customers.",
    toolset: "analytics",
    kind: "read",
    input: {
      asOf: isoDate("Aging date (default today)").optional(),
      customerId: z.string().optional().describe("Limit to one customer"),
      topN: z.number().int().min(1).max(200).optional().describe("Customers to list (default 15)"),
      includeDetail: z.boolean().optional().describe("Include each open invoice (default false)"),
    },
    handler: async (args, ctx) => {
      const asOf = parseDate(args.asOf ?? today())!;
      const required: FilterInput[] = [{ field: "archived", op: "eq", value: false }];
      if (args.customerId) required.push({ field: "customerId", op: "eq", value: args.customerId });
      const { records, truncated } = await gather(ctx, "/invoices", required, [], () => true);
      return {
        ...agingReport(records, "customer", asOf, args.topN ?? 15, args.includeDetail ?? false),
        recordsScanned: records.length,
        ...(truncated ? { warning: "Record limit reached; totals may be incomplete. Raise BILL_MAX_FETCH_ALL." } : {}),
      };
    },
  }),

  defineTool({
    name: "bill_cash_requirements_forecast",
    title: "AP cash requirements forecast",
    description:
      "Projects cash needed to pay open bills: overdue amount plus amounts due in each upcoming week over a horizon. Helps plan payment runs.",
    toolset: "analytics",
    kind: "read",
    input: {
      horizonDays: z.number().int().min(1).max(365).optional().describe("Days ahead to project (default 30)"),
      asOf: isoDate("Start date (default today)").optional(),
    },
    handler: async (args, ctx) => {
      const asOf = parseDate(args.asOf ?? today())!;
      const horizon = args.horizonDays ?? 30;
      const end = new Date(asOf.getTime() + horizon * DAY_MS);
      const endStr = end.toISOString().slice(0, 10);
      const { records, truncated, serverFiltered } = await gather(
        ctx,
        "/bills",
        [{ field: "archived", op: "eq", value: false }],
        [{ field: "dueDate", op: "lte", value: endStr }],
        (r) => {
          const d = parseDate(r.dueDate);
          return !d || d.getTime() <= end.getTime();
        },
      );

      let overdue = 0;
      let overdueCount = 0;
      const weeks = new Map<string, { weekStarting: string; amount: number; count: number }>();
      for (const rec of records) {
        const balance = openBalance(rec);
        if (balance <= 0.005) continue;
        const due = parseDate(rec.dueDate) ?? asOf;
        if (due.getTime() < asOf.getTime()) {
          overdue += balance;
          overdueCount++;
          continue;
        }
        const weekIndex = Math.floor((due.getTime() - asOf.getTime()) / (7 * DAY_MS));
        const start = new Date(asOf.getTime() + weekIndex * 7 * DAY_MS).toISOString().slice(0, 10);
        const w = weeks.get(start) ?? { weekStarting: start, amount: 0, count: 0 };
        w.amount += balance;
        w.count++;
        weeks.set(start, w);
      }
      const upcoming = [...weeks.values()].sort((a, b) => a.weekStarting.localeCompare(b.weekStarting));
      const upcomingTotal = upcoming.reduce((s, w) => s + w.amount, 0);
      let running = overdue;
      return {
        asOf: asOf.toISOString().slice(0, 10),
        through: endStr,
        overdue: { amount: round2(overdue), count: overdueCount },
        weekly: upcoming.map((w) => {
          running += w.amount;
          return { ...w, amount: round2(w.amount), cumulativeIncludingOverdue: round2(running) };
        }),
        totalRequired: round2(overdue + upcomingTotal),
        ...(serverFiltered ? {} : { note: "dueDate filter unsupported server-side; filtered locally." }),
        ...(truncated ? { warning: "Record limit reached; totals may be incomplete. Raise BILL_MAX_FETCH_ALL." } : {}),
      };
    },
  }),

  defineTool({
    name: "bill_vendor_spend_summary",
    title: "Vendor spend summary",
    description:
      "Totals vendor payments over a date range, grouped by vendor (excludes cancelled/failed/voided payments). Useful for spend analysis and 1099 review.",
    toolset: "analytics",
    kind: "read",
    input: {
      from: isoDate("Start date (payments created on/after)"),
      to: isoDate("End date (payments created on/before)"),
      topN: z.number().int().min(1).max(500).optional().describe("Vendors to list (default 25)"),
    },
    handler: async (args, ctx) => {
      const fromTs = `${args.from}T00:00:00.000Z`;
      const toTs = `${args.to}T23:59:59.999Z`;
      const lo = Date.parse(fromTs);
      const hi = Date.parse(toTs);
      const { records, truncated } = await gather(
        ctx,
        "/payments",
        [],
        [
          { field: "createdTime", op: "gte", value: fromTs },
          { field: "createdTime", op: "lte", value: toTs },
        ],
        (r) => {
          const t = Date.parse(String(r.createdTime ?? r.processDate ?? ""));
          return Number.isNaN(t) || (t >= lo && t <= hi);
        },
      );
      const excluded = /CANCEL|FAIL|VOID|RETURN/i;
      const byVendor = new Map<string, { id: string; name: string; amount: number; count: number }>();
      let total = 0;
      let skipped = 0;
      for (const p of records) {
        if (excluded.test(String(p.status ?? p.paymentStatus ?? ""))) {
          skipped++;
          continue;
        }
        const amount = num(p.amount) ?? 0;
        const v = partyOf(p, "vendor");
        const row = byVendor.get(v.id) ?? { ...v, amount: 0, count: 0 };
        row.amount += amount;
        row.count++;
        byVendor.set(v.id, row);
        total += amount;
      }
      const vendors = [...byVendor.values()].sort((a, b) => b.amount - a.amount);
      return {
        from: args.from,
        to: args.to,
        totalPaid: round2(total),
        paymentCount: records.length - skipped,
        excludedPayments: skipped,
        vendorCount: vendors.length,
        vendors: vendors.slice(0, args.topN ?? 25).map((v) => ({
          ...v,
          amount: round2(v.amount),
          percent: total > 0 ? round2((v.amount / total) * 100) : 0,
        })),
        ...(truncated ? { warning: "Record limit reached; totals may be incomplete. Raise BILL_MAX_FETCH_ALL." } : {}),
      };
    },
  }),

  defineTool({
    name: "bill_find_duplicate_bills",
    title: "Find duplicate bills",
    description:
      "Detects likely duplicate bills: the same vendor with the same (normalized) invoice number, or the same amount and invoice date. Pass `candidate` to check a bill BEFORE creating it.",
    toolset: "analytics",
    kind: "read",
    input: {
      vendorId: z.string().optional().describe("Limit the scan to one vendor"),
      createdFrom: isoDate("Only bills created on/after").optional(),
      includePaid: z.boolean().optional().describe("Also consider paid bills (default true)"),
      candidate: z
        .object({
          vendorId: z.string(),
          invoiceNumber: z.string().optional(),
          amount: z.number().optional(),
          invoiceDate: isoDate("Invoice date").optional(),
        })
        .optional()
        .describe("A bill you are about to create; returns existing bills that look like it"),
    },
    handler: async (args, ctx) => {
      const vendorId = args.candidate?.vendorId ?? args.vendorId;
      const required: FilterInput[] = [{ field: "archived", op: "eq", value: false }];
      if (vendorId) required.push({ field: "vendorId", op: "eq", value: vendorId });
      const optional: FilterInput[] = args.createdFrom
        ? [{ field: "createdTime", op: "gte", value: `${args.createdFrom}T00:00:00.000Z` }]
        : [];
      const { records, truncated } = await gather(ctx, "/bills", required, optional, (r) => {
        if (args.includePaid === false && openBalance(r) <= 0.005) return false;
        if (!args.createdFrom) return true;
        const t = Date.parse(String(r.createdTime ?? ""));
        return Number.isNaN(t) || t >= Date.parse(`${args.createdFrom}T00:00:00.000Z`);
      });

      const summarize = (r: Rec) => ({
        id: r.id,
        vendor: partyOf(r, "vendor").name,
        invoiceNumber: nested(r, "invoice", "invoiceNumber") ?? r.invoiceNumber,
        invoiceDate: nested(r, "invoice", "invoiceDate") ?? r.invoiceDate,
        amount: num(r.amount) ?? num(r.totalAmount),
        dueDate: r.dueDate,
        paymentStatus: r.paymentStatus,
        createdTime: r.createdTime,
      });

      if (args.candidate) {
        const c = args.candidate;
        const cNum = normalizeInvoiceNumber(c.invoiceNumber);
        const cDate = parseDate(c.invoiceDate);
        const matches = records
          .map((r) => {
            const reasons: string[] = [];
            const s = summarize(r);
            if (cNum && normalizeInvoiceNumber(s.invoiceNumber) === cNum) reasons.push("same invoice number");
            if (c.amount !== undefined && s.amount !== undefined && Math.abs(s.amount - c.amount) < 0.01) {
              const d = parseDate(s.invoiceDate as string | undefined);
              if (!cDate || !d) reasons.push("same amount");
              else if (Math.abs(d.getTime() - cDate.getTime()) <= 3 * DAY_MS) reasons.push("same amount, invoice date within 3 days");
            }
            return { ...s, reasons };
          })
          .filter((m) => m.reasons.length > 0);
        return { candidate: c, likelyDuplicate: matches.length > 0, matches, scanned: records.length, truncated };
      }

      const groups = new Map<string, Rec[]>();
      for (const r of records) {
        const s = summarize(r);
        const v = partyOf(r, "vendor").id;
        const inv = normalizeInvoiceNumber(s.invoiceNumber);
        if (inv) {
          const key = `num|${v}|${inv}`;
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        if (s.amount !== undefined && s.invoiceDate) {
          const key = `amt|${v}|${s.amount.toFixed(2)}|${String(s.invoiceDate)}`;
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
      }
      const duplicates = [...groups.entries()]
        .filter(([key, rs]) => {
          if (rs.length < 2) return false;
          // An amount/date group whose bills share one invoice number is already reported by number.
          if (key.startsWith("amt|")) {
            const nums = new Set(rs.map((r) => normalizeInvoiceNumber(summarize(r).invoiceNumber)));
            return !(nums.size === 1 && [...nums][0] !== "");
          }
          return true;
        })
        .map(([key, rs]) => ({
          reason: key.startsWith("num|") ? "same vendor and invoice number" : "same vendor, amount, and invoice date",
          bills: rs.map(summarize),
        }));
      return { scanned: records.length, truncated, duplicateGroups: duplicates.length, duplicates };
    },
  }),
];
