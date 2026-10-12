import { randomUUID } from "node:crypto";
import type { BillConfig } from "../config.js";
import { missingCoreCredentials } from "../config.js";
import { BillApiError, ConfigurationError, DryRunCapture, parseErrorBody } from "./errors.js";
import { Semaphore, backoffDelay, sleep } from "../util/semaphore.js";
import { logger } from "../util/logger.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Which BILL API family a request targets. Each has its own base URL and auth scheme. */
export type ApiTarget = "core" | "events" | "spend";

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;

export interface RequestOptions {
  method: HttpMethod;
  /** Path relative to the API base, e.g. `/vendors/009abc`. */
  path: string;
  api?: ApiTarget;
  query?: Record<string, QueryValue>;
  /** JSON request body. */
  body?: unknown;
  /** Raw (binary) request body, used for document uploads. Mutually exclusive with `body`. */
  rawBody?: { data: Uint8Array; contentType: string };
  /** Send an `X-Idempotent-Key` header. `true` generates a UUIDv4. */
  idempotencyKey?: string | true;
  signal?: AbortSignal;
}

export interface BillSession {
  sessionId: string;
  organizationId: string;
  userId?: string;
  /** Whether BILL reports this session as MFA-trusted. */
  trusted: boolean;
  createdAt: number;
  lastUsedAt: number;
  raw: Record<string, unknown>;
}

const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set(["GET", "PUT", "DELETE"]);
const SENSITIVE_HEADERS = new Set(["sessionid", "devkey", "apitoken", "authorization"]);

type FetchLike = typeof fetch;

interface SharedState {
  coreLimiter: Semaphore;
  spendLimiter: Semaphore;
  session?: BillSession;
  loginInFlight?: Promise<BillSession>;
}

/**
 * HTTP client for the BILL v3 APIs.
 *
 * - Logs in lazily and shares one session across all calls; concurrent callers wait on a single login.
 * - Re-authenticates once when BILL reports an invalid/expired session, and proactively after idling
 *   (BILL expires sessions after 35 minutes of inactivity).
 * - Caps in-flight requests (BILL allows 3 concurrent requests per dev key per organization).
 * - Retries throttled requests and transient failures with jittered exponential backoff. Non-idempotent
 *   requests are only retried when BILL rejected them before processing (concurrency throttling), so a
 *   payment is never submitted twice because of an ambiguous timeout or 5xx.
 */
export class BillClient {
  private readonly state: SharedState;

  constructor(
    readonly config: BillConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly dryRun = false,
    state?: SharedState,
  ) {
    this.state = state ?? {
      coreLimiter: new Semaphore(config.maxConcurrency),
      // The Spend & Expense API is limited per token per minute rather than by concurrency.
      spendLimiter: new Semaphore(Math.max(1, config.maxConcurrency)),
    };
  }

  /** A client sharing this one's session and limits whose mutating requests are captured, not sent. */
  withDryRun(): BillClient {
    return new BillClient(this.config, this.fetchImpl, true, this.state);
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  get currentSession(): BillSession | undefined {
    return this.state.session;
  }

  // ---------------------------------------------------------------- convenience verbs

  get<T = unknown>(path: string, query?: RequestOptions["query"], api?: ApiTarget): Promise<T> {
    return this.request<T>({ method: "GET", path, query, api });
  }

  post<T = unknown>(path: string, body?: unknown, extra: Partial<RequestOptions> = {}): Promise<T> {
    return this.request<T>({ ...extra, method: "POST", path, body });
  }

  patch<T = unknown>(path: string, body?: unknown, extra: Partial<RequestOptions> = {}): Promise<T> {
    return this.request<T>({ ...extra, method: "PATCH", path, body });
  }

  put<T = unknown>(path: string, body?: unknown, extra: Partial<RequestOptions> = {}): Promise<T> {
    return this.request<T>({ ...extra, method: "PUT", path, body });
  }

  delete<T = unknown>(path: string, extra: Partial<RequestOptions> = {}): Promise<T> {
    return this.request<T>({ ...extra, method: "DELETE", path });
  }

  // ---------------------------------------------------------------- session management

  /** Returns a live session, logging in if there is none or the current one has idled out. */
  async ensureSession(): Promise<BillSession> {
    const s = this.state.session;
    if (s && Date.now() - s.lastUsedAt < this.config.sessionIdleMs) return s;
    if (s) logger.debug("BILL session idle beyond threshold; re-authenticating");
    this.state.session = undefined;
    return this.login();
  }

  /** Performs (or joins an in-flight) login. */
  login(): Promise<BillSession> {
    if (!this.state.loginInFlight) {
      this.state.loginInFlight = this.performLogin().finally(() => {
        this.state.loginInFlight = undefined;
      });
    }
    return this.state.loginInFlight;
  }

  invalidateSession(): void {
    this.state.session = undefined;
  }

  /** Marks the current session as MFA-trusted after a successful challenge validation or step-up. */
  markSessionTrusted(): void {
    if (this.state.session) this.state.session.trusted = true;
  }

  private async performLogin(): Promise<BillSession> {
    const missing = missingCoreCredentials(this.config);
    if (missing.length > 0) {
      throw new ConfigurationError(
        `BILL credentials are not configured. Set ${missing.join(", ")} in the MCP server environment.`,
      );
    }
    const body: Record<string, unknown> = {
      username: this.config.username,
      password: this.config.password,
      organizationId: this.config.organizationId,
      devKey: this.config.devKey,
    };
    if (this.config.rememberMeId) {
      body.rememberMeId = this.config.rememberMeId;
      body.device = this.config.deviceName;
    }

    const res = await this.send({ method: "POST", path: "/login", body }, "core", false);
    const data = (res ?? {}) as Record<string, unknown>;
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
    if (!sessionId) {
      throw new BillApiError({
        status: 200,
        method: "POST",
        path: "/login",
        details: [],
        message: "Login response did not include a sessionId",
      });
    }
    const now = Date.now();
    const session: BillSession = {
      sessionId,
      organizationId: String(data.organizationId ?? this.config.organizationId),
      userId: typeof data.userId === "string" ? data.userId : undefined,
      trusted: data.trusted === true,
      createdAt: now,
      lastUsedAt: now,
      raw: Object.fromEntries(Object.entries(data).filter(([k]) => k !== "sessionId")),
    };
    this.state.session = session;
    logger.info(
      `Signed in to BILL ${this.config.environment} (org ${session.organizationId}, MFA-trusted: ${session.trusted})`,
    );
    return session;
  }

  // ---------------------------------------------------------------- core request pipeline

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const api = opts.api ?? "core";
    if (this.dryRun && opts.method !== "GET") {
      throw new DryRunCapture(this.describe(opts, api));
    }
    return (await this.send(opts, api, true)) as T;
  }

  private async send(opts: RequestOptions, api: ApiTarget, authenticated: boolean): Promise<unknown> {
    const idempotencyKey = opts.idempotencyKey === true ? randomUUID() : opts.idempotencyKey;
    // Transient failures (5xx, network) are only retried when replaying the request cannot duplicate side
    // effects: idempotent verbs, or webhook-API calls where BILL documents X-Idempotent-Key deduplication.
    const canRetryTransient = IDEMPOTENT_METHODS.has(opts.method) || (idempotencyKey !== undefined && api === "events");
    const limiter = api === "spend" ? this.state.spendLimiter : this.state.coreLimiter;
    let reauthenticated = false;

    for (let attempt = 0; ; attempt++) {
      const headers = await this.buildHeaders(opts, api, authenticated, idempotencyKey);
      const url = this.buildUrl(api, opts.path, opts.query);
      let response: Response;

      try {
        response = await limiter.run(() => this.fetchWithTimeout(url, opts, headers));
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (canRetryTransient && attempt < this.config.maxRetries) {
          const delay = backoffDelay(attempt);
          logger.warn(`${opts.method} ${opts.path} network error (${errorMessage(err)}); retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new BillApiError({
          status: 0,
          method: opts.method,
          path: opts.path,
          details: [],
          message: `Network error: ${errorMessage(err)}`,
        });
      }

      const payload = await readBody(response);
      if (response.ok) {
        if (authenticated && api !== "spend" && this.state.session) this.state.session.lastUsedAt = Date.now();
        return payload;
      }

      const error = new BillApiError({
        status: response.status,
        method: opts.method,
        path: opts.path,
        details: parseErrorBody(payload),
      });

      if (authenticated && api !== "spend" && error.isSessionError && !error.isMfaRequired && !reauthenticated) {
        logger.info("BILL reported an invalid session; signing in again");
        reauthenticated = true;
        this.invalidateSession();
        await this.login();
        attempt--; // a re-login does not consume a retry
        continue;
      }

      if (error.isHourlyRateLimit) throw error;

      const transient = [500, 502, 503, 504].includes(response.status) && canRetryTransient;
      if ((error.isConcurrencyLimit || transient) && attempt < this.config.maxRetries) {
        const delay = retryAfterMs(response) ?? backoffDelay(attempt);
        logger.warn(`${opts.method} ${opts.path} -> ${response.status} ${error.codes.join(",")}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  /**
   * PUTs bytes to a pre-signed upload URL issued by BILL (e.g. for Spend & Expense receipts). No BILL
   * credentials are sent; the URL itself authorizes the upload. PUT is idempotent, so transient failures retry.
   */
  async uploadToUrl(uploadUrl: string, data: Uint8Array, contentType: string): Promise<void> {
    const url = new URL(uploadUrl);
    if (url.protocol !== "https:") throw new Error("Refusing to upload to a non-HTTPS URL.");
    if (this.dryRun) {
      throw new DryRunCapture({
        method: "PUT",
        url: `${url.origin}${url.pathname}`,
        headers: { "Content-Type": contentType },
        body: `<${data.byteLength} bytes>`,
      });
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      let failure: unknown;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: Buffer.from(data),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (response.ok) return;
      } catch (err) {
        failure = err;
      }
      const retryable = !response || response.status >= 500 || response.status === 429;
      if (retryable && attempt < this.config.maxRetries) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      const detail = response ? `HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 300)}` : errorMessage(failure);
      throw new BillApiError({ status: response?.status ?? 0, method: "PUT", path: url.pathname, details: [], message: `Receipt upload failed: ${detail}` });
    }
  }

  private async fetchWithTimeout(url: string, opts: RequestOptions, headers: Record<string, string>): Promise<Response> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let body: Buffer | string | undefined;
    if (opts.rawBody) body = Buffer.from(opts.rawBody.data);
    else if (opts.body !== undefined) body = JSON.stringify(opts.body);
    logger.debug(`-> ${opts.method} ${url}`);
    return this.fetchImpl(url, { method: opts.method, headers, body, signal });
  }

  private async buildHeaders(
    opts: RequestOptions,
    api: ApiTarget,
    authenticated: boolean,
    idempotencyKey: string | undefined,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.rawBody) headers["Content-Type"] = opts.rawBody.contentType;
    else if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["X-Idempotent-Key"] = idempotencyKey;

    if (!authenticated) return headers;
    if (api === "spend") {
      if (!this.config.spendApiToken) {
        throw new ConfigurationError("BILL_SPEND_API_TOKEN is not set; Spend & Expense tools are unavailable.");
      }
      headers.apiToken = this.config.spendApiToken;
      return headers;
    }
    const session = await this.ensureSession();
    headers.devKey = this.config.devKey ?? "";
    headers.sessionId = session.sessionId;
    return headers;
  }

  buildUrl(api: ApiTarget, path: string, query?: RequestOptions["query"]): string {
    const base =
      api === "spend" ? this.config.spendBaseUrl : api === "events" ? this.config.eventsBaseUrl : this.config.apiBaseUrl;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(base + normalized);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private describe(opts: RequestOptions, api: ApiTarget): DryRunCapture["request"] {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.rawBody) headers["Content-Type"] = opts.rawBody.contentType;
    if (opts.idempotencyKey) headers["X-Idempotent-Key"] = opts.idempotencyKey === true ? "<generated>" : opts.idempotencyKey;
    if (api === "spend") headers.apiToken = "<redacted>";
    else {
      headers.devKey = "<redacted>";
      headers.sessionId = "<redacted>";
    }
    return {
      method: opts.method,
      url: this.buildUrl(api, opts.path, opts.query),
      headers,
      body: opts.rawBody ? `<${opts.rawBody.data.byteLength} bytes of ${opts.rawBody.contentType}>` : opts.body,
    };
  }
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json") || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.min(30_000, Math.max(0, date - Date.now()));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "request timed out" : err.message;
  return String(err);
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, SENSITIVE_HEADERS.has(k.toLowerCase()) ? "<redacted>" : v]),
  );
}
