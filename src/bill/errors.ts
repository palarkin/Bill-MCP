/** One entry of the error array the BILL v3 API returns. */
export interface BillErrorDetail {
  timestamp?: string;
  code?: string;
  severity?: string;
  category?: string;
  message?: string;
  [key: string]: unknown;
}

/** Hourly request quota per developer key exhausted. Retrying before the next hour is pointless. */
export const RATE_LIMIT_HOURLY = "BDC_1144";
/** More than the allowed number of simultaneous requests for this developer key and organization. */
export const RATE_LIMIT_CONCURRENT = "BDC_1322";

/** Codes BILL returns when the session id is missing, invalid, or expired. */
const SESSION_ERROR_CODES = new Set(["BDC_1109", "BDC_1110", "BDC_1111"]);

export class BillApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly details: BillErrorDetail[];

  constructor(opts: { status: number; method: string; path: string; details: BillErrorDetail[]; message?: string }) {
    const summary =
      opts.message ??
      (opts.details.length > 0
        ? opts.details.map((d) => [d.code, d.message].filter(Boolean).join(": ")).join("; ")
        : `HTTP ${opts.status}`);
    super(`BILL API ${opts.method} ${opts.path} failed (${opts.status}): ${summary}`);
    this.name = "BillApiError";
    this.status = opts.status;
    this.method = opts.method;
    this.path = opts.path;
    this.details = opts.details;
  }

  get codes(): string[] {
    return this.details.map((d) => d.code).filter((c): c is string => typeof c === "string");
  }

  hasCode(code: string): boolean {
    return this.codes.includes(code);
  }

  get isSessionError(): boolean {
    if (this.status === 401) return true;
    if (this.codes.some((c) => SESSION_ERROR_CODES.has(c))) return true;
    return this.details.some((d) => /session (is )?(invalid|expired)|invalid session|not logged in/i.test(d.message ?? ""));
  }

  get isMfaRequired(): boolean {
    return this.details.some((d) => /\bmfa\b|multi-factor|trusted session|step[- ]?up/i.test(d.message ?? ""));
  }

  get isHourlyRateLimit(): boolean {
    return this.hasCode(RATE_LIMIT_HOURLY);
  }

  get isConcurrencyLimit(): boolean {
    return this.hasCode(RATE_LIMIT_CONCURRENT) || this.status === 429;
  }

  /** Actionable guidance appended to tool error output. */
  get hint(): string | undefined {
    if (this.isHourlyRateLimit) {
      return "The hourly request quota for this developer key is exhausted (BDC_1144). Wait until the start of the next hour, and prefer narrower filters or smaller fetchAll limits.";
    }
    if (this.isConcurrencyLimit) {
      return "BILL rejected the request because too many requests were in flight (BDC_1322). Lower BILL_MAX_CONCURRENCY or retry shortly.";
    }
    if (this.isMfaRequired) {
      return "This operation needs an MFA-trusted session. Use bill_mfa_create_challenge and bill_mfa_validate_challenge (rememberMe: true), then set BILL_REMEMBER_ME_ID so future logins are trusted, or call bill_mfa_step_up.";
    }
    if (this.isSessionError) {
      return "The BILL session was rejected. Check BILL_USERNAME, BILL_PASSWORD, BILL_ORGANIZATION_ID and BILL_DEV_KEY, and that they belong to the selected BILL_ENVIRONMENT.";
    }
    if (this.status === 404) {
      return "The object or endpoint was not found. Verify the id (BILL ids have type prefixes such as 009 vendor, 00n bill, 0cu customer, 00e invoice).";
    }
    return undefined;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      status: this.status,
      method: this.method,
      path: this.path,
      details: this.details,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

/** Normalizes the various error payload shapes (v3 array, single object, v2 envelope) into a list. */
export function parseErrorBody(body: unknown): BillErrorDetail[] {
  if (Array.isArray(body)) {
    return body.filter((x): x is BillErrorDetail => typeof x === "object" && x !== null);
  }
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.errors)) return parseErrorBody(obj.errors);
    if (obj.response_data && typeof obj.response_data === "object") {
      const rd = obj.response_data as Record<string, unknown>;
      return [{ code: String(rd.error_code ?? ""), message: String(rd.error_message ?? "") }];
    }
    if ("code" in obj || "message" in obj) return [obj as BillErrorDetail];
  }
  if (typeof body === "string" && body.trim()) {
    return [{ message: body.trim().slice(0, 2_000) }];
  }
  return [];
}

/** Thrown when a write tool is invoked with dryRun: the request is captured instead of sent. */
export class DryRunCapture extends Error {
  readonly request: { method: string; url: string; headers: Record<string, string>; body?: unknown };

  constructor(request: DryRunCapture["request"]) {
    super("dry run");
    this.name = "DryRunCapture";
    this.request = request;
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
