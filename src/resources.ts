import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BillClient } from "./bill/client.js";
import type { BillConfig } from "./config.js";
import type { RegistrationReport } from "./tools/registry.js";

const GUIDE = `# BILL MCP usage guide

## IDs
BILL ids carry type prefixes: vendors 009…, bills 00n…, customers 0cu…, invoices 00e…, roles 0po…, attachments att….
Resolve a name to an id with bill_find_vendors / bill_find_customers before acting on it.

## Listing, filtering, pagination
Every list tool accepts:
- filters: [{field, op, value}] combined with AND. Operators: eq, ne, gt, gte, lt, lte, in, nin, sw (starts with).
  Strings are quoted automatically; in/nin take an array. Raw strings like 'createdTime:gte:"2025-01-01T00:00:00.000Z"' also work.
  Only fields BILL marks filterable for an object are accepted (common: id, archived, createdTime, updatedTime, name, vendorId, customerId, dueDate, invoiceDate).
- sort: [{field, order}]
- max (1-100) and page (token from nextPage/prevPage)
- fetchAll + limit to gather every page; fields to project only what you need.
Archived records are excluded unless includeArchived is true.

## Money movement
Tools marked [MOVES MONEY] are only present when BILL_ENABLE_MONEY_MOVEMENT=true. In production they need an
MFA-trusted session (bill_mfa_create_challenge -> bill_mfa_validate_challenge, or BILL_REMEMBER_ME_ID).
Always confirm vendor/customer, amount, date and funding account with the user, and prefer dryRun first.

## Dry runs
Every tool that changes data accepts dryRun: true. Lookups still run; the mutating request is returned instead of sent.

## Typical workflows
- Enter a bill: bill_find_vendors -> bill_find_duplicate_bills(candidate) -> bill_list_classifications(chart-of-accounts) -> bill_create_bill -> bill_upload_document(target bill).
- Pay bills: bill_ap_aging_report or bill_cash_requirements_forecast -> bill_list_bank_accounts -> bill_create_payment / bill_create_bulk_payments (dryRun first).
- Approvals: bill_list_pending_bill_approvals -> bill_get_bill -> bill_approve_or_deny_bills.
- Invoice a customer: bill_find_customers -> bill_create_invoice(sendEmail) -> bill_record_invoice_payment when paid offline.
- Collections: bill_ar_aging_report(includeDetail) -> bill_send_invoice reminders.

## Limits
BILL allows 20,000 requests per hour per developer key and 3 concurrent requests per organization; the server
throttles and retries automatically. Sessions expire after 35 idle minutes and are renewed automatically.
`;

export function registerResources(server: McpServer, client: BillClient, config: BillConfig, report: RegistrationReport): void {
  server.registerResource(
    "usage-guide",
    "bill://guide",
    {
      title: "BILL MCP usage guide",
      description: "Conventions for ids, filtering, pagination, money movement, dry runs, and common workflows.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );

  server.registerResource(
    "server-status",
    "bill://status",
    {
      title: "BILL MCP server status",
      description: "Environment, safety modes, session state, and which tools are enabled or skipped (and why).",
      mimeType: "application/json",
    },
    async (uri) => {
      const s = client.currentSession;
      const status = {
        environment: config.environment,
        apiBaseUrl: config.apiBaseUrl,
        readOnly: config.readOnly,
        moneyMovementEnabled: config.enableMoneyMovement,
        spendApiConfigured: Boolean(config.spendApiToken),
        toolsets: [...config.toolsets],
        session: s
          ? { organizationId: s.organizationId, userId: s.userId, mfaTrusted: s.trusted, signedInAt: new Date(s.createdAt).toISOString() }
          : "not signed in yet (sign-in happens on first use)",
        tools: { enabled: report.registered.length, skipped: report.skipped },
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(status, null, 2) }] };
    },
  );
}
