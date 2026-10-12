import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BillClient } from "./bill/client.js";
import { missingCoreCredentials, type BillConfig } from "./config.js";
import { allTools } from "./tools/index.js";
import { registerTools, type RegistrationReport } from "./tools/registry.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { logger } from "./util/logger.js";

export const SERVER_NAME = "bill-mcp";
export const SERVER_VERSION = "1.0.0";

export interface BuiltServer {
  server: McpServer;
  client: BillClient;
  report: RegistrationReport;
}

export function buildServer(config: BillConfig, fetchImpl?: typeof fetch): BuiltServer {
  const client = new BillClient(config, fetchImpl);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
      instructions: [
        `Tools for the BILL (Bill.com) ${config.environment} environment: accounts payable (vendors, bills, approvals, payments), accounts receivable (customers, invoices, receivable payments), general-ledger classifications, documents, webhooks${config.spendApiToken ? ", Spend & Expense" : ""}, and analytics (aging, cash forecast, duplicate detection).`,
        "Resolve names to ids with bill_find_vendors / bill_find_customers. Read bill://guide for filtering and workflow conventions.",
        config.readOnly
          ? "The server is in READ-ONLY mode: no data can be changed."
          : "Every data-changing tool accepts dryRun: true to preview the request. Confirm changes with the user before making them.",
        config.enableMoneyMovement
          ? "Money movement is ENABLED. Never pay, charge, or change bank details without explicit user confirmation of payee, amount, date and funding account."
          : "Money movement is disabled: payments, customer charges, and bank-detail changes are not available.",
      ].join("\n"),
    },
  );

  const report = registerTools(server, allTools(config), client, config);
  registerResources(server, client, config, report);
  registerPrompts(server);

  const missing = missingCoreCredentials(config);
  if (missing.length > 0) {
    logger.warn(`Missing ${missing.join(", ")}; BILL tools will report a configuration error until these are set.`);
  }
  logger.info(
    `${report.registered.length} tools enabled (${report.skipped.length} skipped) for ${config.environment}; read-only=${config.readOnly}, money-movement=${config.enableMoneyMovement}`,
  );
  return { server, client, report };
}
