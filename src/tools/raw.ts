import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import type { ApiTarget } from "../bill/client.js";
import type { BillConfig } from "../config.js";

const api = z
  .enum(["core", "events", "spend"])
  .optional()
  .describe("core = /connect/v3 (default), events = webhooks /connect-events/v3, spend = Spend & Expense /connect/v3/spend");

const pathSchema = z
  .string()
  .min(1)
  .describe("Path relative to the API base, e.g. /vendors/009abc or /bills?max=5 is NOT allowed (use query)")
  .refine((p) => p.startsWith("/"), "path must start with /")
  .refine((p) => !p.includes("..") && !p.includes("://") && !p.includes("?") && !p.includes("#"), "path must be a plain relative path; pass query parameters via `query`");

const queryRecord = z.record(z.union([z.string(), z.number(), z.boolean()])).optional();

/**
 * Endpoints that move money or change where money goes. The raw tool refuses to call them unless money
 * movement is enabled, so it cannot be used to bypass that safety switch.
 */
const MONEY_MOVEMENT_RULES: Array<{ api: ApiTarget; method: RegExp; path: RegExp }> = [
  { api: "core", method: /^POST$/, path: /^\/payments(\/bulk)?\/?$/i },
  { api: "core", method: /^POST$/, path: /^\/receivable-payments\/?$/i },
  { api: "core", method: /^(POST|PUT|PATCH|DELETE)$/, path: /^\/vendors\/[^/]+\/bank-account/i },
  { api: "core", method: /^(POST|PUT|PATCH|DELETE)$/, path: /^\/customers\/[^/]+\/(bank-accounts|charge-authorization)/i },
  { api: "core", method: /^(POST|PUT|PATCH|DELETE)$/, path: /^\/funding-accounts\//i },
  { api: "spend", method: /^(POST|PUT|PATCH|DELETE)$/, path: /^\/(cards|budgets)(\/|$)/i },
];

/** True when a request body turns on vendor autopay, which makes BILL pay future bills automatically. */
export function enablesAutopay(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return /"autoPay"\s*:\s*(true|\{)/.test(JSON.stringify(body));
}

export function isMoneyMovement(method: string, path: string, target: ApiTarget, body: unknown): boolean {
  if (MONEY_MOVEMENT_RULES.some((r) => r.api === target && r.method.test(method) && r.path.test(path))) return true;
  return target === "core" && /^(POST|PUT|PATCH)$/.test(method) && /^\/(vendors|recurringbills)(\/|$)/i.test(path) && enablesAutopay(body);
}

export function rawTools(config: BillConfig): ToolDefinition[] {
  return [
    defineTool({
      name: "bill_api_get",
      title: "BILL API GET (raw)",
      description:
        "Escape hatch: performs any GET request against the BILL v3 APIs, for endpoints without a dedicated tool. Prefer dedicated tools when one exists.",
      toolset: "raw",
      kind: "read",
      input: { path: pathSchema, query: queryRecord, api },
      handler: (args, { client }) => client.get(args.path, args.query, args.api ?? "core"),
    }),

    defineTool({
      name: "bill_api_request",
      title: "BILL API request (raw)",
      description:
        "Escape hatch: performs any POST/PUT/PATCH/DELETE against the BILL v3 APIs, for endpoints without a dedicated tool. Money-moving endpoints are refused unless money movement is enabled. Use dryRun to preview.",
      toolset: "raw",
      kind: "write",
      destructive: true,
      input: {
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        path: pathSchema,
        query: queryRecord,
        body: z.unknown().optional().describe("JSON request body (object or array)"),
        api,
        idempotencyKey: z.string().optional().describe("Value for the X-Idempotent-Key header"),
      },
      handler: (args, { client }) => {
        const target = args.api ?? "core";
        if (!config.enableMoneyMovement && isMoneyMovement(args.method, args.path, target, args.body)) {
          throw new Error(
            `${args.method} ${args.path} moves money or changes payment destinations, and money movement is disabled. Set BILL_ENABLE_MONEY_MOVEMENT=true to allow it.`,
          );
        }
        return client.request({
          method: args.method,
          path: args.path,
          query: args.query,
          body: args.body,
          api: target,
          idempotencyKey: args.idempotencyKey,
        });
      },
    }),
  ];
}
