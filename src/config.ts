import { z } from "zod";

/** Every toolset the server knows about. `BILL_TOOLSETS` selects a subset. */
export const TOOLSETS = [
  "session",
  "vendors",
  "bills",
  "approvals",
  "payments",
  "customers",
  "invoices",
  "receivables",
  "classifications",
  "funding",
  "organization",
  "documents",
  "webhooks",
  "spend",
  "analytics",
  "raw",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

const ENVIRONMENT_HOSTS = {
  sandbox: "https://gateway.stage.bill.com",
  production: "https://gateway.prod.bill.com",
} as const;

export type BillEnvironment = keyof typeof ENVIRONMENT_HOSTS;

export interface BillConfig {
  environment: BillEnvironment;
  /** Base URL of the core v3 API, e.g. https://gateway.stage.bill.com/connect/v3 */
  apiBaseUrl: string;
  /** Base URL of the webhook (connect-events) v3 API. */
  eventsBaseUrl: string;
  /** Base URL of the Spend & Expense v3 API. */
  spendBaseUrl: string;

  username?: string;
  password?: string;
  organizationId?: string;
  devKey?: string;
  /** MFA "remember me" id; makes every login produce an MFA-trusted session. */
  rememberMeId?: string;
  /** Device name registered with the rememberMeId. */
  deviceName: string;

  /** Spend & Expense API token (sent as the `apiToken` header). */
  spendApiToken?: string;

  readOnly: boolean;
  enableMoneyMovement: boolean;
  toolsets: Set<Toolset>;

  maxConcurrency: number;
  maxRetries: number;
  timeoutMs: number;
  /** Proactively re-login after this much idle time (BILL expires sessions after 35 minutes). */
  sessionIdleMs: number;
  /** Upper bound on records gathered by any "fetch all pages" operation. */
  maxFetchAllRecords: number;
  /** Responses larger than this many characters are truncated before reaching the model. */
  maxResponseChars: number;
  /** Directory that bill_upload_document may read local files from. Unset disables filePath uploads. */
  uploadRoot?: string;
}

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return fallback;
      return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    });

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const EnvSchema = z.object({
  BILL_ENVIRONMENT: z
    .string()
    .optional()
    .transform((v) => (v ?? "sandbox").trim().toLowerCase())
    .pipe(z.enum(["sandbox", "production"])),
  BILL_API_HOST: optionalString,
  BILL_USERNAME: optionalString,
  BILL_PASSWORD: optionalString,
  BILL_ORGANIZATION_ID: optionalString,
  BILL_DEV_KEY: optionalString,
  BILL_REMEMBER_ME_ID: optionalString,
  BILL_DEVICE_NAME: optionalString,
  BILL_SPEND_API_TOKEN: optionalString,
  BILL_READ_ONLY: bool(false),
  BILL_ENABLE_MONEY_MOVEMENT: bool(false),
  BILL_TOOLSETS: optionalString,
  BILL_MAX_CONCURRENCY: int(3, 1, 10),
  BILL_MAX_RETRIES: int(4, 0, 10),
  BILL_TIMEOUT_MS: int(60_000, 1_000, 600_000),
  BILL_SESSION_IDLE_MINUTES: int(30, 1, 34),
  BILL_MAX_FETCH_ALL: int(2_000, 100, 50_000),
  BILL_MAX_RESPONSE_CHARS: int(100_000, 5_000, 2_000_000),
  BILL_UPLOAD_ROOT: optionalString,
});

function parseToolsets(raw: string | undefined): Set<Toolset> {
  if (!raw || raw.toLowerCase() === "all") return new Set(TOOLSETS);
  const requested = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = requested.filter((t) => !(TOOLSETS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    throw new Error(`Unknown toolset(s) in BILL_TOOLSETS: ${unknown.join(", ")}. Valid: ${TOOLSETS.join(", ")}`);
  }
  return new Set(requested as Toolset[]);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BillConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid BILL MCP configuration: ${details}`);
  }
  const e = parsed.data;
  const host = (e.BILL_API_HOST ?? ENVIRONMENT_HOSTS[e.BILL_ENVIRONMENT]).replace(/\/+$/, "");

  return {
    environment: e.BILL_ENVIRONMENT,
    apiBaseUrl: `${host}/connect/v3`,
    eventsBaseUrl: `${host}/connect-events/v3`,
    spendBaseUrl: `${host}/connect/v3/spend`,
    username: e.BILL_USERNAME,
    password: e.BILL_PASSWORD,
    organizationId: e.BILL_ORGANIZATION_ID,
    devKey: e.BILL_DEV_KEY,
    rememberMeId: e.BILL_REMEMBER_ME_ID,
    deviceName: e.BILL_DEVICE_NAME ?? "bill-mcp",
    spendApiToken: e.BILL_SPEND_API_TOKEN,
    readOnly: e.BILL_READ_ONLY,
    enableMoneyMovement: e.BILL_ENABLE_MONEY_MOVEMENT && !e.BILL_READ_ONLY,
    toolsets: parseToolsets(e.BILL_TOOLSETS),
    maxConcurrency: e.BILL_MAX_CONCURRENCY,
    maxRetries: e.BILL_MAX_RETRIES,
    timeoutMs: e.BILL_TIMEOUT_MS,
    sessionIdleMs: e.BILL_SESSION_IDLE_MINUTES * 60_000,
    maxFetchAllRecords: e.BILL_MAX_FETCH_ALL,
    maxResponseChars: e.BILL_MAX_RESPONSE_CHARS,
    uploadRoot: e.BILL_UPLOAD_ROOT,
  };
}

/** Names of the credentials the core (non-Spend) API needs that are missing. */
export function missingCoreCredentials(config: BillConfig): string[] {
  const missing: string[] = [];
  if (!config.username) missing.push("BILL_USERNAME");
  if (!config.password) missing.push("BILL_PASSWORD");
  if (!config.organizationId) missing.push("BILL_ORGANIZATION_ID");
  if (!config.devKey) missing.push("BILL_DEV_KEY");
  return missing;
}
