import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool, type ToolContext, type ToolDefinition } from "./registry.js";
import { encodeId, id, isoDate } from "./common.js";
import { resolveUploadPath } from "./documents.js";
import { nameSimilarity, num, parseDate } from "./analytics.js";
import { fetchAll, type FilterInput } from "../bill/list.js";
import { BillApiError } from "../bill/errors.js";
import { toReceiptImages } from "../util/receiptImages.js";
import { logger } from "../util/logger.js";

type Rec = Record<string, unknown>;

const DAY_MS = 86_400_000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** Receipt states that mean "no receipt on this transaction yet". */
export const RECEIPT_NEEDED_STATUSES = ["MISSING", "NOT_ATTACHED"] as const;

// ---------------------------------------------------------------- transaction field accessors

export function txnAmount(t: Rec): number | undefined {
  const v = num(t.amount) ?? num(t.transactedAmount) ?? num(t.billingAmount) ?? num(t.totalAmount);
  return v === undefined ? undefined : Math.abs(v);
}

export function txnDate(t: Rec): Date | undefined {
  return parseDate(t.occurredTime) ?? parseDate(t.authorizedTime) ?? parseDate(t.transactedTime) ?? parseDate(t.createdTime);
}

function txnCurrency(t: Rec): string | undefined {
  const c = t.currency ?? t.currencyCode ?? t.billingCurrency ?? t.transactedCurrency;
  return typeof c === "string" && c ? c.toUpperCase() : undefined;
}

function isDeclined(t: Rec): boolean {
  if (t.declineReason) return true;
  return /DECLIN|VOID|REVERS|FAIL/i.test(String(t.status ?? t.transactionType ?? ""));
}

export function summarizeTransaction(t: Rec): Rec {
  const date = txnDate(t);
  const user = t.user && typeof t.user === "object" ? (t.user as Rec) : undefined;
  return {
    id: t.id ?? t.uuid,
    merchant: t.merchantName ?? t.rawMerchantName,
    rawMerchant: t.rawMerchantName,
    amount: txnAmount(t),
    currency: txnCurrency(t),
    date: date ? date.toISOString().slice(0, 10) : undefined,
    receiptStatus: t.receiptStatus,
    userId: t.userId ?? user?.id,
    userName: t.userName ?? (user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : undefined),
    cardLastFour: t.cardLastFour ?? t.lastFour,
    budgetId: t.budgetId,
  };
}

// ---------------------------------------------------------------- fetching

interface MissingReceiptQuery {
  from: string;
  to: string;
  statuses: string[];
  userId?: string;
}

export async function fetchTransactionsNeedingReceipts(ctx: ToolContext, q: MissingReceiptQuery) {
  const lo = Date.parse(`${q.from}T00:00:00.000Z`);
  const hi = Date.parse(`${q.to}T23:59:59.999Z`);
  const wanted = new Set(q.statuses.map((s) => s.toUpperCase()));
  const required: FilterInput[] = q.userId ? [{ field: "userId", op: "eq", value: q.userId }] : [];
  const optional: FilterInput[] = [
    { field: "receiptStatus", op: "in", value: [...wanted] },
    { field: "authorizedTime", op: "gte", value: `${q.from}T00:00:00.000Z` },
    { field: "authorizedTime", op: "lte", value: `${q.to}T23:59:59.999Z` },
  ];
  const keep = (t: Rec) => {
    if (isDeclined(t)) return false;
    if (!wanted.has(String(t.receiptStatus ?? "").toUpperCase())) return false;
    const d = txnDate(t);
    return !d || (d.getTime() >= lo && d.getTime() <= hi);
  };

  const cap = ctx.config.maxFetchAllRecords;
  let serverFiltered = true;
  let res;
  try {
    res = await fetchAll<Rec>(ctx.client, "/transactions", { filters: [...required, ...optional] }, cap, "spend");
  } catch (err) {
    if (!(err instanceof BillApiError) || err.status !== 400) throw err;
    // Some filters may not be supported for transactions; fall back to filtering locally.
    serverFiltered = false;
    res = await fetchAll<Rec>(ctx.client, "/transactions", { filters: required }, cap, "spend");
  }
  return { transactions: res.results.filter(keep), truncated: res.truncated, serverFiltered };
}

function defaultRange(from?: string, to?: string): { from: string; to: string } {
  const end = to ?? new Date().toISOString().slice(0, 10);
  const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - 90 * DAY_MS).toISOString().slice(0, 10);
  return { from: start, to: end };
}

// ---------------------------------------------------------------- matching

export interface InvoiceFacts {
  file: string;
  vendorName?: string;
  total?: number;
  currency?: string;
  invoiceDate?: string;
  invoiceNumber?: string;
}

export interface MatchCandidate {
  transaction: Rec;
  score: number;
  amountScore: number;
  nameScore: number;
  dateScore: number;
  reasons: string[];
}

export function scoreMatch(inv: InvoiceFacts, t: Rec): MatchCandidate | undefined {
  const reasons: string[] = [];
  const amount = txnAmount(t);
  const invCur = inv.currency?.toUpperCase();
  const tCur = txnCurrency(t);
  const currencyMismatch = Boolean(invCur && tCur && invCur !== tCur);

  let amountScore = 0;
  if (inv.total !== undefined && amount !== undefined && !currencyMismatch) {
    const diff = Math.abs(Math.abs(inv.total) - amount);
    const rel = diff / Math.max(Math.abs(inv.total), amount, 0.01);
    if (diff < 0.01) {
      amountScore = 1;
      reasons.push("exact amount");
    } else if (rel <= 0.01) {
      amountScore = 0.7;
      reasons.push(`amount within 1% (${amount.toFixed(2)} vs ${inv.total.toFixed(2)})`);
    } else if (rel <= 0.05) {
      amountScore = 0.3;
      reasons.push(`amount within 5% (${amount.toFixed(2)} vs ${inv.total.toFixed(2)})`);
    }
  }
  if (currencyMismatch) reasons.push(`different currency (${invCur} vs ${tCur})`);

  let nameScore = 0;
  if (inv.vendorName) {
    nameScore = Math.max(
      nameSimilarity(inv.vendorName, String(t.merchantName ?? "")),
      nameSimilarity(inv.vendorName, String(t.rawMerchantName ?? "")),
    );
    if (nameScore >= 0.75) reasons.push("merchant name matches");
    else if (nameScore >= 0.45) reasons.push("merchant name similar");
  }

  let dateScore = 0.3;
  const invDate = parseDate(inv.invoiceDate);
  const tDate = txnDate(t);
  if (invDate && tDate) {
    const days = Math.abs(tDate.getTime() - invDate.getTime()) / DAY_MS;
    dateScore = days <= 3 ? 1 : days <= 10 ? 0.6 : days <= 35 ? 0.3 : 0;
    reasons.push(`charged ${Math.round(days)} day(s) from invoice date`);
  }

  const plausible = amountScore > 0 || (nameScore >= 0.75 && dateScore >= 0.6);
  if (!plausible) return undefined;
  const score = 0.55 * amountScore + 0.3 * nameScore + 0.15 * dateScore;
  return { transaction: t, score, amountScore, nameScore, dateScore, reasons };
}

function confidence(c: MatchCandidate, runnerUp?: MatchCandidate): "high" | "medium" | "low" {
  const ambiguous = runnerUp !== undefined && c.score - runnerUp.score < 0.05;
  if (c.amountScore === 1 && (c.nameScore >= 0.45 || c.dateScore === 1) && c.score >= 0.7 && !ambiguous) return "high";
  if (c.score >= 0.55 && !ambiguous) return "medium";
  return "low";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Matches invoices to transactions: each invoice gets ranked candidates, then pairs are assigned greedily
 * by score so no transaction (or invoice) is used twice.
 */
export function matchInvoices(invoices: InvoiceFacts[], transactions: Rec[]) {
  const ranked = invoices.map((inv) => {
    const candidates = transactions
      .map((t) => scoreMatch(inv, t))
      .filter((c): c is MatchCandidate => c !== undefined)
      .sort((a, b) => b.score - a.score);
    return { inv, candidates };
  });

  const pairs = ranked
    .flatMap(({ inv, candidates }) => candidates.map((c, i) => ({ inv, c, runnerUp: candidates[i + 1] })))
    .sort((a, b) => b.c.score - a.c.score);

  const usedInvoices = new Set<string>();
  const usedTxns = new Set<unknown>();
  const assignments: Rec[] = [];
  for (const { inv, c, runnerUp } of pairs) {
    const tid = c.transaction.id ?? c.transaction.uuid;
    if (usedInvoices.has(inv.file) || usedTxns.has(tid)) continue;
    usedInvoices.add(inv.file);
    usedTxns.add(tid);
    assignments.push({
      file: inv.file,
      invoice: { vendorName: inv.vendorName, total: inv.total, invoiceDate: inv.invoiceDate, invoiceNumber: inv.invoiceNumber },
      transaction: summarizeTransaction(c.transaction),
      confidence: confidence(c, runnerUp),
      score: round2(c.score),
      reasons: c.reasons,
    });
  }

  const alternatives = Object.fromEntries(
    ranked
      .filter(({ candidates }) => candidates.length > 1)
      .map(({ inv, candidates }) => [
        inv.file,
        candidates.slice(0, 3).map((c) => ({ ...summarizeTransaction(c.transaction), score: round2(c.score) })),
      ]),
  );

  return {
    assignments: assignments.sort((a, b) => String(a.file).localeCompare(String(b.file))),
    unmatchedInvoices: invoices.filter((i) => !usedInvoices.has(i.file)).map((i) => i.file),
    transactionsStillMissing: transactions
      .filter((t) => !usedTxns.has(t.id ?? t.uuid))
      .map(summarizeTransaction),
    alternatives,
  };
}

// ---------------------------------------------------------------- tools

const dateRangeInput = {
  from: isoDate("Earliest transaction date (default 90 days before `to`)").optional(),
  to: isoDate("Latest transaction date (default today)").optional(),
  statuses: z
    .array(z.string())
    .optional()
    .describe(`Receipt statuses to treat as needing a receipt (default ${RECEIPT_NEEDED_STATUSES.join(", ")})`),
  userId: z.string().optional().describe("Only this cardholder's transactions"),
};

export const spendReceiptTools: ToolDefinition[] = [
  defineTool({
    name: "bill_spend_list_transactions_missing_receipts",
    title: "Spend: transactions missing receipts",
    description:
      "Lists Spend & Expense card transactions that still need a receipt/invoice (receiptStatus MISSING or NOT_ATTACHED), excluding declined transactions. Returns merchant, amount, date, and cardholder.",
    toolset: "spend",
    kind: "read",
    requires: "spend",
    input: dateRangeInput,
    handler: async (args, ctx) => {
      const range = defaultRange(args.from, args.to);
      const { transactions, truncated, serverFiltered } = await fetchTransactionsNeedingReceipts(ctx, {
        ...range,
        statuses: args.statuses ?? [...RECEIPT_NEEDED_STATUSES],
        userId: args.userId,
      });
      return {
        ...range,
        count: transactions.length,
        total: round2(transactions.reduce((s, t) => s + (txnAmount(t) ?? 0), 0)),
        ...(truncated ? { warning: "Record limit reached; raise BILL_MAX_FETCH_ALL or narrow the date range." } : {}),
        ...(serverFiltered ? {} : { note: "Receipt/date filters were applied locally." }),
        transactions: transactions.map(summarizeTransaction).sort((a, b) => String(a.date).localeCompare(String(b.date))),
      };
    },
  }),

  defineTool({
    name: "bill_spend_match_invoices",
    title: "Spend: match invoices to transactions",
    description:
      "Given facts read from invoice files (vendor, total, date, currency), finds the Spend & Expense transactions missing receipts that each invoice belongs to. Scores amount, merchant name, and date; assigns each transaction to at most one invoice; reports confidence (high/medium/low), unmatched invoices, and transactions still missing receipts.",
    toolset: "spend",
    kind: "read",
    requires: "spend",
    input: {
      invoices: z
        .array(
          z.object({
            file: z.string().min(1).describe("Invoice file path (used as the key in results)"),
            vendorName: z.string().optional(),
            total: z.number().optional().describe("Invoice total actually charged"),
            currency: z.string().optional().describe("ISO currency code, e.g. USD"),
            invoiceDate: isoDate("Invoice date").optional(),
            invoiceNumber: z.string().optional(),
          }),
        )
        .min(1)
        .max(500),
      ...dateRangeInput,
    },
    handler: async (args, ctx) => {
      const dates = args.invoices.map((i) => parseDate(i.invoiceDate)).filter((d): d is Date => Boolean(d));
      // Default window: a little before the earliest invoice through a little after the latest one.
      const fallbackFrom = dates.length
        ? new Date(Math.min(...dates.map((d) => d.getTime())) - 15 * DAY_MS).toISOString().slice(0, 10)
        : undefined;
      const fallbackTo = dates.length
        ? new Date(Math.min(Date.now(), Math.max(...dates.map((d) => d.getTime())) + 45 * DAY_MS)).toISOString().slice(0, 10)
        : undefined;
      const range = defaultRange(args.from ?? fallbackFrom, args.to ?? fallbackTo);
      const { transactions, truncated } = await fetchTransactionsNeedingReceipts(ctx, {
        ...range,
        statuses: args.statuses ?? [...RECEIPT_NEEDED_STATUSES],
        userId: args.userId,
      });
      return {
        searchedRange: range,
        transactionsConsidered: transactions.length,
        ...(truncated ? { warning: "Record limit reached; some transactions were not considered." } : {}),
        ...matchInvoices(args.invoices, transactions),
      };
    },
  }),

  defineTool({
    name: "bill_spend_attach_receipt",
    title: "Spend: attach invoice to transaction",
    description:
      "Attaches an invoice/receipt file to a Spend & Expense card transaction. PDFs are converted to images (one per page, up to maxPages) because BILL accepts JPG/PNG receipts; PNG/JPG upload as-is. Reads filePath inside BILL_UPLOAD_ROOT (or takes contentBase64), uploads, attaches, then re-reads the transaction to confirm its receipt status.",
    toolset: "spend",
    kind: "write",
    requires: "spend",
    input: {
      transactionId: id("Spend & Expense transaction"),
      filePath: z.string().optional().describe("Invoice file path inside BILL_UPLOAD_ROOT (absolute or relative to it)"),
      contentBase64: z.string().optional().describe("Alternatively, the file contents base64-encoded"),
      fileName: z.string().optional().describe("Required with contentBase64; defaults to the file's name"),
      maxPages: z.number().int().min(1).max(20).optional().describe("Max PDF pages to attach (default 5)"),
    },
    handler: async (args, ctx) => {
      if (Boolean(args.filePath) === Boolean(args.contentBase64)) throw new Error("Provide exactly one of filePath or contentBase64.");
      let data: Uint8Array;
      let fileName: string;
      if (args.filePath) {
        const resolved = await resolveUploadPath(args.filePath, ctx.config.uploadRoot);
        const info = await stat(resolved);
        if (info.size > MAX_SOURCE_BYTES) throw new Error(`${path.basename(resolved)} is larger than 20 MB.`);
        data = await readFile(resolved);
        fileName = args.fileName ?? path.basename(resolved);
      } else {
        if (!args.fileName) throw new Error("fileName is required with contentBase64.");
        data = Buffer.from(args.contentBase64!, "base64");
        fileName = args.fileName;
      }

      const converted = await toReceiptImages(data, fileName, { maxPages: args.maxPages });
      const plan = {
        transactionId: args.transactionId,
        source: fileName,
        sourceType: converted.sourceType,
        ...(converted.totalPages ? { totalPages: converted.totalPages, skippedPages: converted.skippedPages } : {}),
        images: converted.images.map((i) => ({ fileName: i.fileName, contentType: i.contentType, bytes: i.data.byteLength })),
      };
      if (ctx.client.isDryRun) {
        return { dryRun: true, message: "No changes were made. These images would be attached.", ...plan };
      }

      const attached: Rec[] = [];
      for (const image of converted.images) {
        const uploadUrl = await requestUploadUrl(ctx);
        await ctx.client.uploadToUrl(uploadUrl, image.data, image.contentType);
        const res = await addReceipt(ctx, args.transactionId, uploadUrl, image.fileName);
        attached.push({ fileName: image.fileName, response: res });
      }

      let receiptStatus: unknown;
      try {
        const txn = (await ctx.client.get(`/transactions/${encodeId(args.transactionId)}`, undefined, "spend")) as Rec;
        receiptStatus = txn.receiptStatus;
      } catch (err) {
        receiptStatus = `unknown (${err instanceof Error ? err.message : String(err)})`;
      }
      return { ...plan, attached: attached.length, receiptStatus, results: attached };
    },
  }),
];

/** Extracts the pre-signed URL from the receipt-upload-url response, whatever its field is called. */
export function extractUploadUrl(res: unknown): string | undefined {
  if (typeof res === "string" && res.startsWith("https://")) return res;
  if (!res || typeof res !== "object") return undefined;
  const obj = res as Rec;
  for (const key of ["uploadUrl", "url", "receiptUploadUrl", "presignedUrl", "signedUrl"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).startsWith("https://")) return obj[key] as string;
  }
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.startsWith("https://")) return value;
    if (value && typeof value === "object") {
      const nested = extractUploadUrl(value);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function requestUploadUrl(ctx: ToolContext): Promise<string> {
  const res = await ctx.client.post("/transactions/receipt-upload-url", undefined, { api: "spend" });
  const url = extractUploadUrl(res);
  if (!url) throw new Error(`BILL did not return a receipt upload URL: ${JSON.stringify(res).slice(0, 300)}`);
  return url;
}

/**
 * Request bodies BILL may expect when attaching an uploaded receipt. The reference documents passing the
 * upload URL but its field name was not verifiable while this was built, so known shapes are tried in
 * order. Only a 400 (request rejected, nothing attached) moves on to the next shape; the shape that works
 * is remembered for the rest of the process.
 */
const ADD_RECEIPT_BODIES: Array<(url: string, fileName: string) => unknown> = [
  (url) => ({ uploadUrl: url }),
  (url, fileName) => ({ receipts: [{ url, filename: fileName }] }),
  (url, fileName) => ({ url, filename: fileName }),
];
let workingBodyIndex: number | undefined;

export function resetReceiptBodyCache(): void {
  workingBodyIndex = undefined;
}

async function addReceipt(ctx: ToolContext, transactionId: string, uploadUrl: string, fileName: string): Promise<unknown> {
  const path = `/transactions/${encodeId(transactionId)}/receipts`;
  const order = workingBodyIndex === undefined ? ADD_RECEIPT_BODIES.map((_, i) => i) : [workingBodyIndex];
  let lastError: unknown;
  for (const index of order) {
    try {
      const res = await ctx.client.post(path, ADD_RECEIPT_BODIES[index]!(uploadUrl, fileName), { api: "spend" });
      workingBodyIndex = index;
      return res;
    } catch (err) {
      lastError = err;
      if (!(err instanceof BillApiError) || err.status !== 400) throw err;
      logger.debug(`Receipt body shape ${index} rejected: ${err.message}`);
    }
  }
  throw lastError;
}
