import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import { additionalFields, buildBody, encodeId, id } from "./common.js";

/**
 * Verifies a BILL webhook notification. BILL signs the raw request body with the subscription's
 * securityKey using HMAC-SHA256 and sends the base64 digest in the `x-bill-sha-signature` header.
 */
export function verifyWebhookSignature(rawBody: string, signature: string, securityKey: string): boolean {
  const expected = createHmac("sha256", securityKey).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature.trim(), "base64");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const eventSchema = z
  .object({
    type: z.string().min(1).describe("Event type from bill_list_webhook_event_types, e.g. bill.created"),
    version: z.string().optional().describe("Event schema version, e.g. 1"),
  })
  .passthrough();

export const webhookTools: ToolDefinition[] = [
  defineTool({
    name: "bill_list_webhook_event_types",
    title: "List webhook event types",
    description: "Lists the webhook event types (and versions) the organization can subscribe to.",
    toolset: "webhooks",
    kind: "read",
    input: {},
    handler: (_args, { client }) => client.get("/catalog", undefined, "events"),
  }),

  defineTool({
    name: "bill_list_webhook_subscriptions",
    title: "List webhook subscriptions",
    description: "Lists the organization's webhook subscriptions.",
    toolset: "webhooks",
    kind: "read",
    input: {},
    handler: (_args, { client }) => client.get("/subscriptions", undefined, "events"),
  }),

  defineTool({
    name: "bill_get_webhook_subscription",
    title: "Get webhook subscription",
    description: "Gets one webhook subscription.",
    toolset: "webhooks",
    kind: "read",
    input: { subscriptionId: id("subscription") },
    handler: (args, { client }) => client.get(`/subscriptions/${encodeId(args.subscriptionId)}`, undefined, "events"),
  }),

  defineTool({
    name: "bill_create_webhook_subscription",
    title: "Create webhook subscription",
    description:
      "Subscribes an HTTPS endpoint to BILL events. The response contains a one-time securityKey for verifying signatures: store it securely, it is not shown again.",
    toolset: "webhooks",
    kind: "write",
    input: {
      name: z.string().min(1),
      notificationUrl: z.string().url().refine((u) => u.startsWith("https://"), "notificationUrl must use https"),
      events: z.array(eventSchema).min(1),
      enabled: z.boolean().optional().describe("Default true"),
      idempotencyKey: z.string().uuid().optional().describe("UUIDv4 to make retries safe (generated if omitted)"),
      additionalFields,
    },
    handler: (args, { client }) => {
      const body = buildBody(args, ["enabled", "idempotencyKey"]);
      body.status = { enabled: args.enabled ?? true };
      return client.post("/subscriptions", body, { api: "events", idempotencyKey: args.idempotencyKey ?? true });
    },
  }),

  defineTool({
    name: "bill_update_webhook_subscription",
    title: "Update webhook subscription",
    description: "Updates a webhook subscription's name, URL, events, or enabled status (PATCH).",
    toolset: "webhooks",
    kind: "write",
    idempotent: true,
    input: {
      subscriptionId: id("subscription"),
      name: z.string().optional(),
      notificationUrl: z.string().url().optional(),
      events: z.array(eventSchema).optional(),
      enabled: z.boolean().optional(),
      additionalFields,
    },
    handler: (args, { client }) => {
      const body = buildBody(args, ["subscriptionId", "enabled"]);
      if (args.enabled !== undefined) body.status = { enabled: args.enabled };
      return client.patch(`/subscriptions/${encodeId(args.subscriptionId)}`, body, { api: "events" });
    },
  }),

  defineTool({
    name: "bill_delete_webhook_subscription",
    title: "Delete webhook subscription",
    description: "Deletes a webhook subscription; BILL stops sending its notifications.",
    toolset: "webhooks",
    kind: "write",
    destructive: true,
    input: { subscriptionId: id("subscription") },
    handler: (args, { client }) => client.delete(`/subscriptions/${encodeId(args.subscriptionId)}`, { api: "events" }),
  }),

  defineTool({
    name: "bill_rotate_webhook_security_key",
    title: "Rotate webhook security key",
    description:
      "Generates a new securityKey for a subscription. Update your receiver with the new key promptly; the response shows it once.",
    toolset: "webhooks",
    kind: "write",
    input: { subscriptionId: id("subscription") },
    handler: (args, { client }) =>
      client.post(`/subscriptions/${encodeId(args.subscriptionId)}/security-key`, {}, { api: "events", idempotencyKey: true }),
  }),

  defineTool({
    name: "bill_verify_webhook_signature",
    title: "Verify webhook signature",
    description:
      "Checks locally whether a webhook payload's x-bill-sha-signature header matches its raw body and securityKey (HMAC-SHA256, base64). Useful when debugging a webhook receiver.",
    toolset: "webhooks",
    kind: "read",
    requires: "none",
    input: {
      rawBody: z.string().describe("The exact raw request body, byte-for-byte as received"),
      signature: z.string().min(1).describe("Value of the x-bill-sha-signature header"),
      securityKey: z.string().min(1).describe("The subscription's securityKey"),
    },
    handler: async (args) => {
      const valid = verifyWebhookSignature(args.rawBody, args.signature, args.securityKey);
      return {
        valid,
        ...(valid
          ? {}
          : {
              hint: "Make sure rawBody is the unmodified body (no re-serialized JSON, whitespace changes, or decoding) and the key belongs to this subscription.",
            }),
      };
    },
  }),
];
