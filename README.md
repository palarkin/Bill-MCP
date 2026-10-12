# Bill-MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [BILL (Bill.com) v3 API](https://developer.bill.com/docs/home). It lets Claude and other MCP clients work with accounts payable, accounts receivable, approvals, payments, general-ledger coding, documents, webhooks, and Spend & Expense. Built-in analytics cover AP/AR aging, cash forecasting, and duplicate-bill detection.

## Highlights

- **103 tools across 16 toolsets**: vendors, bills, vendor credits, recurring bills, approvals, AP payments (including international/FX), customers, invoices, AR payments, GL classifications, funding accounts, users and roles, documents, webhooks, Spend & Expense, analytics, and raw API access.
- **Safe by default.** Nothing that moves money (payments, customer charges, vendor bank-detail changes, autopay) is exposed unless you set `BILL_ENABLE_MONEY_MOVEMENT=true`. `BILL_READ_ONLY=true` exposes read tools only. The raw-request tool applies the same guard, so it can't be used to get around it.
- **Dry runs everywhere.** Every data-changing tool accepts `dryRun: true`. Lookups still run, but the request that would have changed data is returned instead of sent.
- **Robust client.**
  - Logs in lazily, and concurrent callers share a single login.
  - Re-authenticates automatically on session expiry and proactively after idling (BILL expires sessions after 35 minutes).
  - Enforces BILL's limit of 3 concurrent requests.
  - Retries throttled and transient failures with jittered backoff.
  - Never replays a non-idempotent request after an ambiguous failure, so a timeout cannot cause a double payment.
- **MFA-aware.** Includes the challenge, validate, and step-up flow. Set `BILL_REMEMBER_ME_ID` and every session is MFA-trusted, which production requires for payments.
- **LLM-friendly results.**
  - Structured filters with BILL's `field:op:value` syntax, sorting, page tokens, `fetchAll` with caps, and field projection.
  - Fuzzy name lookups, so the model can resolve "Acme" to a vendor id.
  - Actionable error hints and response-size limits.
- **Analytics.** AP and AR aging, a weekly cash-requirements forecast, vendor spend summaries, and duplicate-bill detection (including a check before you create a bill).
- **Resources and prompts.** `bill://guide` documents conventions and `bill://status` reports server state. Workflow prompts: `payment_run`, `enter_bill`, `collections_review`, and `month_end_close`.

## Quick start

Requirements: Node.js 20.3+ (22+ to run the tests) and a BILL developer account (sandbox or production) with a developer key. See [BILL's sign-up docs](https://developer.bill.com/docs/api-sandbox-sign-in).

```bash
npm install
npm run build
cp .env.example .env   # fill in credentials, for reference
node dist/index.js --list-tools
```

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "bill": {
      "command": "node",
      "args": ["/absolute/path/to/Bill-MCP/dist/index.js"],
      "env": {
        "BILL_ENVIRONMENT": "sandbox",
        "BILL_USERNAME": "you@example.com",
        "BILL_PASSWORD": "••••••••",
        "BILL_ORGANIZATION_ID": "00801XXXXXXXXXXXXXXX",
        "BILL_DEV_KEY": "01ABCDEFGHIJKLMNOPQR",
        "BILL_READ_ONLY": "false",
        "BILL_ENABLE_MONEY_MOVEMENT": "false"
      }
    }
  }
}
```

With Claude Code: `claude mcp add bill -e BILL_USERNAME=... -e BILL_PASSWORD=... -e BILL_ORGANIZATION_ID=... -e BILL_DEV_KEY=... -- node /absolute/path/to/Bill-MCP/dist/index.js`

Then ask: *"Call bill_get_session_info"* to confirm the connection.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BILL_ENVIRONMENT` | `sandbox` | `sandbox` → `gateway.stage.bill.com`, `production` → `gateway.prod.bill.com` |
| `BILL_USERNAME`, `BILL_PASSWORD` | — | BILL user credentials (required for the core API) |
| `BILL_ORGANIZATION_ID` | — | Organization id (required) |
| `BILL_DEV_KEY` | — | Developer key (required) |
| `BILL_REMEMBER_ME_ID` | — | MFA "remember me" id. Logins become MFA-trusted, which production needs for payments. |
| `BILL_DEVICE_NAME` | `bill-mcp` | Device name registered with the remember-me id |
| `BILL_SPEND_API_TOKEN` | — | Spend & Expense API token; enables the `spend` toolset |
| `BILL_READ_ONLY` | `false` | Only register read tools |
| `BILL_ENABLE_MONEY_MOVEMENT` | `false` | Register payment, charge, bank-detail, and autopay tools |
| `BILL_TOOLSETS` | `all` | Comma list: `session, vendors, bills, approvals, payments, customers, invoices, receivables, classifications, funding, organization, documents, webhooks, spend, analytics, raw` |
| `BILL_UPLOAD_ROOT` | — | Directory `bill_upload_document` may read local files from. If unset, only base64 uploads are accepted. |
| `BILL_MAX_CONCURRENCY` | `3` | Max in-flight requests (BILL allows 3 per dev key per organization) |
| `BILL_MAX_RETRIES` | `4` | Retries for throttled or transient failures |
| `BILL_TIMEOUT_MS` | `60000` | Per-request timeout |
| `BILL_SESSION_IDLE_MINUTES` | `30` | Re-login after this much idle time (BILL's limit is 35) |
| `BILL_MAX_FETCH_ALL` | `2000` | Upper bound on records gathered by `fetchAll` and analytics |
| `BILL_MAX_RESPONSE_CHARS` | `100000` | Tool responses are truncated beyond this |
| `BILL_API_HOST` | — | Override the gateway host (e.g. a proxy) |
| `BILL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` (logs go to stderr) |

## Safety model

| Kind | Examples | Registered when |
|---|---|---|
| **read** | list, get, aging reports, find, verify signature | always |
| **write** | create/update vendors, bills, invoices; approve bills; archive; record *external* payments; webhooks | not `BILL_READ_ONLY` |
| **money** | `bill_create_payment`, `bill_create_bulk_payments`, `bill_charge_customer`, `bill_authorize_customer_charge`, vendor bank-account create/delete | `BILL_ENABLE_MONEY_MOVEMENT=true` and not read-only |

Further guards:

- **Tool annotations.** Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so clients can ask for confirmation. Money tools' descriptions start with `[MOVES MONEY]`.
- **Payment destinations.** Changing where a vendor gets paid is a common fraud vector, so vendor bank-account changes and enabling `autoPay` (on vendors or recurring bills) count as money movement.
- **Raw API.** `bill_api_request` refuses money-moving endpoints while money movement is disabled.
- **Local files.** `bill_upload_document` only reads files inside `BILL_UPLOAD_ROOT`, so an injected prompt can't exfiltrate arbitrary local files.
- **Retries.** The client retries a `POST` only when BILL throttled it before processing (`BDC_1322`), never after a timeout or 5xx.

### MFA (production)

BILL requires an MFA-trusted session in production for payments, bank accounts, and autopay. To get one:

1. Call `bill_mfa_create_challenge`. BILL sends a code to the user's phone.
2. Call `bill_mfa_validate_challenge` with the `challengeId` and code (`rememberMe` defaults to true).
3. Put the returned `rememberMeId` in `BILL_REMEMBER_ME_ID`, and the device in `BILL_DEVICE_NAME`. Every later login is then trusted, for 30 days.

## Filtering cheat sheet

```jsonc
// bill_list_bills
{
  "vendorId": "009...",                          // convenience args become filters
  "paymentStatus": ["UNPAID", "PARTIAL"],
  "dueDateTo": "2025-12-31",
  "filters": [{ "field": "createdTime", "op": "gte", "value": "2025-01-01T00:00:00.000Z" }],
  "sort": [{ "field": "dueDate", "order": "asc" }],
  "max": 100,
  "fetchAll": true, "limit": 500,
  "fields": ["id", "vendorName", "dueDate", "dueAmount", "invoice.invoiceNumber"]
}
```

These are sent as `filters=vendorId:eq:"009...",paymentStatus:in:"UNPAID,PARTIAL",dueDate:lte:"2025-12-31",createdTime:gte:"...",archived:eq:false`. Archived records are excluded unless `includeArchived: true`.

## Tools

**session**

| Tool | Kind | Description |
|---|---|---|
| `bill_get_session_info` | read | Shows the signed-in BILL organization, user, MFA trust status, environment, and which safety modes this server runs with. |
| `bill_refresh_session` | read | Discards the cached BILL session and signs in again (picks up a rememberMeId for MFA trust). |
| `bill_mfa_create_challenge` | write | Sends an MFA code to the BILL user's registered phone (step 1 of making the session MFA-trusted). |
| `bill_mfa_validate_challenge` | write | Completes MFA with the code the user received, making the current session MFA-trusted. |
| `bill_mfa_step_up` | write | Marks the current session MFA-trusted using a previously issued rememberMeId (defaults to BILL_REMEMBER_ME_ID), without sending a new code. |

**vendors**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_vendors` | read | Lists vendors (payees) in the BILL organization. |
| `bill_get_vendor` | read | Gets full details of one vendor, including address, payment information, and network status. |
| `bill_create_vendor` | write | Creates a vendor. |
| `bill_update_vendor` | write | Updates only the supplied fields of a vendor (PATCH). |
| `bill_create_vendors_bulk` | write | Creates several vendors in one request. |
| `bill_get_vendor_bank_account` | read | Gets the (masked) bank account BILL pays this vendor into. |
| `bill_create_vendor_bank_account` | money | Adds the bank account BILL pays this vendor into (ACH). |
| `bill_delete_vendor_bank_account` | money | Removes a vendor's bank account. |
| `bill_get_international_payment_config` | read | Returns the fields and validation rules BILL requires to pay a vendor in a given country/currency. |

**bills**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_bills` | read | Lists AP bills (amounts owed to vendors). |
| `bill_get_bill` | read | Gets full details of one bill, including line items, approval and payment status. |
| `bill_create_bill` | write | Creates an AP bill for a vendor. |
| `bill_update_bill` | write | Updates only the supplied fields of a bill (PATCH). |
| `bill_create_bills_bulk` | write | Creates several bills in one request. |
| `bill_record_bill_payment` | write | Records a payment made OUTSIDE of BILL (e.g. |
| `bill_list_vendor_credits` | read | Lists vendor credits (amounts vendors owe you that can be applied to bills). |
| `bill_get_vendor_credit` | read | Gets one vendor credit. |
| `bill_create_vendor_credit` | write | Creates a vendor credit that can later be applied to the vendor's bills. |
| `bill_update_vendor_credit` | write | Updates only the supplied fields of a vendor credit (PATCH). |
| `bill_list_recurring_bills` | read | Lists recurring bill schedules. |
| `bill_get_recurring_bill` | read | Gets one recurring bill schedule. |
| `bill_create_recurring_bill` | write | Creates a recurring bill schedule that generates bills automatically (and optionally auto-pays them via additionalFields). |
| `bill_update_recurring_bill` | write | Updates only the supplied fields of a recurring bill schedule (PATCH). |

**approvals**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_pending_bill_approvals` | read | Lists bills waiting for the signed-in user's approval. |
| `bill_approve_or_deny_bills` | write | Approves or denies one or more bills as the signed-in approver. |
| `bill_list_approval_policies` | read | Lists the organization's bill approval policies (rules that route bills to approvers). |

**payments**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_payments` | read | Lists vendor payments (scheduled, in process, paid, cancelled, failed). |
| `bill_get_payment` | read | Gets one vendor payment, including status, funding account, disbursement and bill allocations. |
| `bill_create_payment` | money | Schedules a payment to a vendor for a bill (or creates the bill as part of the payment with createBill=true). |
| `bill_create_bulk_payments` | money | Schedules payments for multiple bills (and vendors) in one request. |
| `bill_cancel_payment` | write | Cancels a scheduled vendor payment that has not yet been processed. |
| `bill_get_exchange_rate` | read | Gets BILL's current exchange rate for paying an international vendor in a foreign currency. |

**customers**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_customers` | read | Lists AR customers. |
| `bill_get_customer` | read | Gets one customer, including balance and charge authorization status. |
| `bill_create_customer` | write | Creates an AR customer. |
| `bill_update_customer` | write | Updates only the supplied fields of a customer (PATCH). |
| `bill_authorize_customer_charge` | money | Records that the customer has authorized you to debit their bank account (sets authorizedToCharge), a prerequisite for bill_charge_customer. |

**invoices**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_invoices` | read | Lists AR invoices (amounts customers owe you). |
| `bill_get_invoice` | read | Gets one invoice with line items, amounts due and status. |
| `bill_create_invoice` | write | Creates an AR invoice for an existing customer (customerId) or a new one (customerName + customerEmail). |
| `bill_update_invoice` | write | Updates only the supplied fields of an invoice (PATCH). |
| `bill_send_invoice` | write | Emails an existing invoice (with its payment link) to one or more recipients. |
| `bill_record_invoice_payment` | write | Records a customer payment received OUTSIDE of BILL (check, cash, card elsewhere) and applies it to invoices. |

**receivables**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_receivable_payments` | read | Lists payments received from customers (through BILL or recorded). |
| `bill_get_receivable_payment` | read | Gets one customer payment. |
| `bill_charge_customer` | money | Debits a customer's bank account to pay one or more of their invoices. |

**classifications**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_classifications` | read | Lists general-ledger classification records of one type: chart of accounts, accounting classes, departments, employees, items, jobs, or locations. |
| `bill_get_classification` | read | Gets one general-ledger classification record. |
| `bill_create_classification` | write | Creates a general-ledger classification record (e.g. |
| `bill_update_classification` | write | Updates only the supplied fields of a general-ledger classification record (PATCH). |
| `bill_set_classification_archived` | write | Archives (hides) or restores a general-ledger classification record. |

**funding**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_bank_accounts` | read | Lists the organization's bank accounts usable to fund payments (ids are needed for fundingAccount). |
| `bill_get_bank_account` | read | Gets one organization bank account, including verification status. |
| `bill_list_card_accounts` | read | Lists the organization's card funding accounts. |
| `bill_get_card_account` | read | Gets one organization card funding account. |

**organization**

| Tool | Kind | Description |
|---|---|---|
| `bill_get_organization` | read | Gets the BILL organization's profile (defaults to the signed-in organization). |
| `bill_list_users` | read | Lists users of the BILL organization. |
| `bill_get_user` | read | Gets one organization user. |
| `bill_create_user` | write | Creates (invites) an organization user with a role. |
| `bill_update_user` | write | Updates only the supplied fields of a user (PATCH), e.g. |
| `bill_list_roles` | read | Lists user roles (Administrator, Accountant, Approver, Payer, Clerk, Auditor, and custom roles). |
| `bill_get_role` | read | Gets one user role and its permissions. |
| `bill_archive_object` | write | Archives a vendor, bill, vendor credit, recurring bill, customer, invoice, user, or bank account. |
| `bill_restore_object` | write | Restores a previously archived record. |

**documents**

| Tool | Kind | Description |
|---|---|---|
| `bill_upload_document` | write | Uploads a file (max 6 MB) and attaches it to a bill, vendor, customer, or invoice. |
| `bill_list_documents` | read | Lists documents/attachments on a bill, vendor, customer, or invoice, with download links. |
| `bill_get_document` | read | Gets a document or attachment's metadata and a time-limited download link. |
| `bill_get_document_upload_status` | read | Checks whether an uploaded document has finished processing. |

**webhooks**

| Tool | Kind | Description |
|---|---|---|
| `bill_list_webhook_event_types` | read | Lists the webhook event types (and versions) the organization can subscribe to. |
| `bill_list_webhook_subscriptions` | read | Lists the organization's webhook subscriptions. |
| `bill_get_webhook_subscription` | read | Gets one webhook subscription. |
| `bill_create_webhook_subscription` | write | Subscribes an HTTPS endpoint to BILL events. |
| `bill_update_webhook_subscription` | write | Updates a webhook subscription's name, URL, events, or enabled status (PATCH). |
| `bill_delete_webhook_subscription` | write | Deletes a webhook subscription; BILL stops sending its notifications. |
| `bill_rotate_webhook_security_key` | write | Generates a new securityKey for a subscription. |
| `bill_verify_webhook_signature` | read | Checks locally whether a webhook payload's x-bill-sha-signature header matches its raw body and securityKey (HMAC-SHA256, base64). |

**spend**

| Tool | Kind | Description |
|---|---|---|
| `bill_spend_get_current_user` | read | Gets the Spend & Expense user that owns the configured API token. |
| `bill_spend_list_users` | read | Lists Spend & Expense users. |
| `bill_spend_get_user` | read | Gets one Spend & Expense user. |
| `bill_spend_create_user` | write | Invites a Spend & Expense user. |
| `bill_spend_list_budgets` | read | Lists Spend & Expense budgets (spending policies with limits and reset intervals). |
| `bill_spend_get_budget` | read | Gets one budget, including its current period spend. |
| `bill_spend_create_budget` | write | Creates a Spend & Expense budget. |
| `bill_spend_list_cards` | read | Lists virtual and physical Spend & Expense cards. |
| `bill_spend_get_card` | read | Gets one card's (masked) details, limits, and status. |
| `bill_spend_list_transactions` | read | Lists card transactions with merchant, amount, budget, receipt status, and decline reason. |
| `bill_spend_get_transaction` | read | Gets one card transaction. |
| `bill_spend_list_reimbursements` | read | Lists out-of-pocket reimbursement requests. |
| `bill_spend_get_reimbursement` | read | Gets one reimbursement request. |

**analytics**

| Tool | Kind | Description |
|---|---|---|
| `bill_find_vendors` | read | Fuzzy-searches vendors by name (tolerates typos, punctuation, and suffixes like Inc/LLC) and returns the best matches with ids. |
| `bill_find_customers` | read | Fuzzy-searches customers by name (tolerates typos, punctuation, and suffixes like Inc/LLC) and returns the best matches with ids. |
| `bill_ap_aging_report` | read | Accounts-payable aging: open bill balances bucketed by days past due (current, 1-30, 31-60, 61-90, 90+), with totals and top vendors. |
| `bill_ar_aging_report` | read | Accounts-receivable aging: open invoice balances bucketed by days past due (current, 1-30, 31-60, 61-90, 90+), with totals and top customers. |
| `bill_cash_requirements_forecast` | read | Projects cash needed to pay open bills: overdue amount plus amounts due in each upcoming week over a horizon. |
| `bill_vendor_spend_summary` | read | Totals vendor payments over a date range, grouped by vendor (excludes cancelled/failed/voided payments). |
| `bill_find_duplicate_bills` | read | Detects likely duplicate bills: the same vendor with the same (normalized) invoice number, or the same amount and invoice date. |

**raw**

| Tool | Kind | Description |
|---|---|---|
| `bill_api_get` | read | Escape hatch: performs any GET request against the BILL v3 APIs, for endpoints without a dedicated tool. |
| `bill_api_request` | write | Escape hatch: performs any POST/PUT/PATCH/DELETE against the BILL v3 APIs, for endpoints without a dedicated tool. |

## API coverage notes

I built this from BILL's public v3 documentation. The sandbox could not reach `developer.bill.com` while building, so endpoint paths and payloads came from the docs, changelog, and guides found through search.

Endpoint paths, auth, pagination, filter syntax, rate limits, MFA, webhook signing, and the main AP/AR flows match the documentation. For some request bodies, BILL's reference was not fully visible while building, so their field names are best effort:

- vendor credits and recurring bills
- bulk payments
- send-invoice recipients
- approval policies
- the webhook event catalog path
- Spend & Expense create calls

To cover gaps:

- Every create/update tool accepts `additionalFields`, which is merged into the request body verbatim.
- `bill_api_get` and `bill_api_request` can call any v3 endpoint directly.
- BILL's validation errors are returned to the model with their codes and messages.

Please check these against the [API reference](https://developer.bill.com/reference) in the sandbox before production use, and open an issue or PR for any mismatch.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: client, pagination, safety gating, tools over an in-memory MCP transport, analytics
npm run build
npm run inspect     # MCP Inspector against dist/index.js
```

Project layout:

```
src/
  index.ts           CLI entry (stdio transport, --list-tools, --help)
  server.ts          McpServer assembly
  config.ts          environment parsing and validation
  bill/client.ts     HTTP client: session, MFA trust, concurrency, retries, dry run
  bill/list.ts       filter/sort serialization, pagination, field projection
  bill/errors.ts     BILL error parsing and hints
  tools/registry.ts  tool registration, safety gating, dry-run wiring, result formatting
  tools/*.ts         tool definitions by domain
  resources.ts, prompts.ts
test/                vitest suites with a scriptable fake BILL gateway
```

## License

MIT
