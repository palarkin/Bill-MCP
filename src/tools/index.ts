import type { BillConfig } from "../config.js";
import type { ToolDefinition } from "./registry.js";
import { sessionTools } from "./session.js";
import { vendorTools } from "./vendors.js";
import { billTools } from "./bills.js";
import { approvalTools, paymentTools } from "./payments.js";
import { customerTools, invoiceTools, receivablePaymentTools } from "./receivables.js";
import { archiveTools, classificationTools, fundingTools, organizationTools } from "./organization.js";
import { documentTools } from "./documents.js";
import { webhookTools } from "./webhooks.js";
import { spendTools } from "./spend.js";
import { spendReceiptTools } from "./spendReceipts.js";
import { analyticsTools } from "./analytics.js";
import { rawTools } from "./raw.js";

/** Every tool the server can expose, before toolset / safety filtering. */
export function allTools(config: BillConfig): ToolDefinition[] {
  return [
    ...sessionTools,
    ...vendorTools,
    ...billTools,
    ...approvalTools,
    ...paymentTools,
    ...customerTools,
    ...invoiceTools,
    ...receivablePaymentTools,
    ...classificationTools,
    ...fundingTools,
    ...organizationTools,
    ...archiveTools,
    ...documentTools,
    ...webhookTools,
    ...spendTools,
    ...spendReceiptTools,
    ...analyticsTools,
    ...rawTools(config),
  ];
}
