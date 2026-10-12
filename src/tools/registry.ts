import { z, ZodError, type ZodRawShape, type ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BillConfig, Toolset } from "../config.js";
import type { BillClient } from "../bill/client.js";
import { BillApiError, ConfigurationError, DryRunCapture } from "../bill/errors.js";
import { logger } from "../util/logger.js";

/**
 * - read:  never changes data in BILL.
 * - write: creates/updates/archives records but never moves money.
 * - money: initiates or authorizes money movement; only registered with BILL_ENABLE_MONEY_MOVEMENT=true.
 */
export type ToolKind = "read" | "write" | "money";

/** Which credentials a tool needs to be useful. Tools whose credentials are absent are not registered. */
export type ToolRequirement = "core" | "spend" | "none";

export interface ToolContext {
  client: BillClient;
  config: BillConfig;
  signal: AbortSignal;
}

export type ToolArgs<S extends ZodRawShape> = z.objectOutputType<S, ZodTypeAny>;

export interface ToolDefinition<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  kind: ToolKind;
  /** For write tools: the change is hard to undo (delete, cancel). */
  destructive?: boolean;
  /** Repeating the call with the same arguments has no additional effect. */
  idempotent?: boolean;
  requires?: ToolRequirement;
  input: S;
  handler: (args: ToolArgs<S>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Type-checks a tool's handler against its input shape, then erases the shape type so heterogeneous
 * tools can live in one array. Arguments are validated by the MCP SDK against `input` before the handler runs.
 */
export function defineTool<S extends ZodRawShape>(def: ToolDefinition<S>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

const dryRunShape = {
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "When true, nothing is changed in BILL: lookups still run, and the mutating request is returned (method, URL, body) instead of being sent.",
    ),
};

export interface RegistrationReport {
  registered: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export function shouldRegister(def: ToolDefinition, config: BillConfig): string | undefined {
  if (!config.toolsets.has(def.toolset)) return `toolset "${def.toolset}" not enabled`;
  if (config.readOnly && def.kind !== "read") return "read-only mode";
  if (def.kind === "money" && !config.enableMoneyMovement) return "money movement disabled";
  if ((def.requires ?? "core") === "spend" && !config.spendApiToken) return "BILL_SPEND_API_TOKEN not set";
  return undefined;
}

export function registerTools(
  server: McpServer,
  defs: ReadonlyArray<ToolDefinition>,
  client: BillClient,
  config: BillConfig,
): RegistrationReport {
  const report: RegistrationReport = { registered: [], skipped: [] };
  const names = new Set<string>();

  for (const def of defs) {
    if (names.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
    names.add(def.name);

    const reason = shouldRegister(def, config);
    if (reason) {
      report.skipped.push({ name: def.name, reason });
      continue;
    }

    const mutating = def.kind !== "read";
    const shape: ZodRawShape = mutating ? { ...def.input, ...dryRunShape } : def.input;
    const description = def.kind === "money" ? `[MOVES MONEY] ${def.description}` : def.description;

    server.registerTool(
      def.name,
      {
        title: def.title,
        description,
        inputSchema: shape,
        annotations: {
          title: def.title,
          readOnlyHint: !mutating,
          destructiveHint: mutating ? (def.destructive ?? false) || def.kind === "money" : false,
          idempotentHint: def.idempotent ?? !mutating,
          openWorldHint: def.requires !== "none",
        },
      },
      async (args: Record<string, unknown>, extra) => {
        const { dryRun, ...rest } = args as Record<string, unknown> & { dryRun?: boolean };
        const ctx: ToolContext = {
          client: mutating && dryRun ? client.withDryRun() : client,
          config,
          signal: extra.signal,
        };
        return executeTool(def, rest, ctx);
      },
    );
    report.registered.push(def.name);
  }
  return report;
}

export async function executeTool(def: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = await def.handler(args as ToolArgs<ZodRawShape>, ctx);
    logger.debug(`${def.name} completed in ${Date.now() - started}ms`);
    return formatResult(result, ctx.config.maxResponseChars);
  } catch (err) {
    if (err instanceof DryRunCapture) {
      return formatResult(
        { dryRun: true, message: "No changes were made. This is the request that would be sent.", request: err.request },
        ctx.config.maxResponseChars,
      );
    }
    logger.warn(`${def.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return errorResult(err);
  }
}

export function formatResult(value: unknown, maxChars: number): CallToolResult {
  let text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  if (text.length > 20_000 && typeof value !== "string") text = JSON.stringify(value);
  if (text.length > maxChars) {
    text =
      text.slice(0, maxChars) +
      `\n\n[Response truncated at ${maxChars} of ${text.length} characters. Narrow the request with filters, a smaller page size, or the "fields" parameter.]`;
  }
  return { content: [{ type: "text", text }] };
}

export function errorResult(err: unknown): CallToolResult {
  let payload: Record<string, unknown>;
  if (err instanceof BillApiError) payload = err.toJSON();
  else if (err instanceof ConfigurationError) payload = { error: err.message, type: "configuration" };
  else if (err instanceof ZodError) payload = { error: "Invalid arguments", issues: err.issues };
  else payload = { error: err instanceof Error ? err.message : String(err) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
