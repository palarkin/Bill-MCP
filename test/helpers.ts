import { loadConfig, type BillConfig } from "../src/config.js";

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: RecordedCall) => { status?: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }>;

/**
 * A scriptable fake of the BILL gateway. Routes are matched by "METHOD /path" (path relative to
 * /connect/v3, /connect-events/v3 or /connect/v3/spend). Login succeeds by default.
 */
export class FakeBill {
  readonly calls: RecordedCall[] = [];
  private readonly routes = new Map<string, Handler[]>();
  loginCount = 0;
  inFlight = 0;
  maxInFlight = 0;
  delayMs = 0;

  constructor() {
    this.on("POST /login", () => {
      this.loginCount++;
      return { body: { sessionId: `session-${this.loginCount}`, organizationId: "00801TEST", userId: "006USER", trusted: false } };
    });
  }

  /** Registers a handler. Multiple handlers for the same route are used in order; the last one repeats. */
  on(route: string, handler: Handler): this {
    const list = this.routes.get(route) ?? [];
    list.push(handler);
    this.routes.set(route, list);
    return this;
  }

  /** Replaces all handlers for a route. */
  set(route: string, handler: Handler): this {
    this.routes.set(route, [handler]);
    return this;
  }

  callsTo(route: string): RecordedCall[] {
    const [method, path] = route.split(" ");
    return this.calls.filter((c) => c.method === method && relativePath(c.url) === path);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body) body = init.body;
    const call: RecordedCall = { method, url, headers, body };
    this.calls.push(call);

    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const key = `${method} ${relativePath(url)}`;
      const handlers = this.routes.get(key);
      if (!handlers || handlers.length === 0) {
        return json(404, [{ code: "BDC_1001", message: `No fake route for ${key}` }]);
      }
      const handler = handlers.length > 1 ? handlers.shift()! : handlers[0]!;
      const res = await handler(call);
      return json(res.status ?? 200, res.body ?? {}, res.headers);
    } finally {
      this.inFlight--;
    }
  };
}

export function relativePath(url: URL): string {
  return url.pathname.replace(/^\/connect-events\/v3/, "").replace(/^\/connect\/v3\/spend/, "").replace(/^\/connect\/v3/, "");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function testConfig(overrides: Record<string, string> = {}): BillConfig {
  return loadConfig({
    BILL_USERNAME: "user@example.com",
    BILL_PASSWORD: "secret",
    BILL_ORGANIZATION_ID: "00801TEST",
    BILL_DEV_KEY: "devkey-123",
    BILL_MAX_RETRIES: "3",
    ...overrides,
  });
}
