import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "payment_run",
    {
      title: "Plan a vendor payment run",
      description: "Builds a proposed payment run for bills due soon, for review before anything is paid.",
      argsSchema: {
        horizonDays: z.string().optional().describe("Days ahead to include (default 14)"),
        budget: z.string().optional().describe("Maximum total to pay in this run"),
      },
    },
    ({ horizonDays, budget }) =>
      user(
        `Plan a vendor payment run for bills due in the next ${horizonDays ?? "14"} days${budget ? ` within a budget of ${budget}` : ""}.
1. Call bill_cash_requirements_forecast and bill_ap_aging_report (includeDetail: true).
2. List candidate bills (overdue first, then by due date), skipping bills that are not approved or already scheduled.
3. Call bill_list_bank_accounts to pick the funding account.
4. Present a table: vendor, bill, invoice #, due date, amount, and the run total. Flag anything unusual (duplicates via bill_find_duplicate_bills, unusually large amounts, new vendors).
5. Do NOT create payments. Ask me to confirm; if I confirm and payment tools are available, run bill_create_bulk_payments with dryRun: true first and show the request.`,
      ),
  );

  server.registerPrompt(
    "enter_bill",
    {
      title: "Enter a vendor bill",
      description: "Turns invoice details into a correctly coded BILL bill, with duplicate checks.",
      argsSchema: { details: z.string().describe("Invoice details: vendor, invoice #, dates, amounts, line items") },
    },
    ({ details }) =>
      user(
        `Enter this vendor invoice as a bill in BILL:\n\n${details}\n
Steps: resolve the vendor with bill_find_vendors (ask before creating a new vendor); check bill_find_duplicate_bills with a candidate; look up GL accounts with bill_list_classifications (type chart-of-accounts) and pick the best match per line; call bill_create_bill with dryRun: true and show me the request; create it after I confirm.`,
      ),
  );

  server.registerPrompt(
    "collections_review",
    {
      title: "AR collections review",
      description: "Reviews overdue receivables and drafts follow-ups.",
      argsSchema: { minDaysPastDue: z.string().optional().describe("Only invoices at least this many days overdue (default 1)") },
    },
    ({ minDaysPastDue }) =>
      user(
        `Run a collections review. Call bill_ar_aging_report with includeDetail: true, focus on invoices at least ${minDaysPastDue ?? "1"} days past due, group them by customer, and rank customers by overdue balance. For the top customers, summarize the oldest invoices and propose a reminder plan. Only send reminders (bill_send_invoice) for the invoices I approve.`,
      ),
  );

  server.registerPrompt(
    "month_end_close",
    {
      title: "Month-end AP/AR snapshot",
      description: "Produces AP/AR balances, aging, and spend for a month-end close checklist.",
      argsSchema: { month: z.string().describe("Month to close, YYYY-MM") },
    },
    ({ month }) =>
      user(
        `Prepare a month-end close snapshot for ${month}. Use the last day of the month as asOf. Include: bill_ap_aging_report, bill_ar_aging_report, bill_vendor_spend_summary for the month, bills still pending approval (bill_list_pending_bill_approvals), and possible duplicate bills created during the month (bill_find_duplicate_bills with createdFrom). Finish with a short list of items needing attention.`,
      ),
  );
}
