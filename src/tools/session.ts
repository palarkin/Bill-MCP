import { z } from "zod";
import { defineTool, type ToolDefinition } from "./registry.js";
import { id } from "./common.js";

export const sessionTools: ToolDefinition[] = [
  defineTool({
    name: "bill_get_session_info",
    title: "Get BILL session info",
    description:
      "Shows the signed-in BILL organization, user, MFA trust status, environment, and which safety modes this server runs with. Call this first to confirm connectivity.",
    toolset: "session",
    kind: "read",
    input: {},
    handler: async (_args, { client, config }) => {
      const session = await client.ensureSession();
      let remote: unknown;
      try {
        remote = await client.get("/login/session");
      } catch (err) {
        remote = { unavailable: err instanceof Error ? err.message : String(err) };
      }
      return {
        environment: config.environment,
        apiBaseUrl: config.apiBaseUrl,
        organizationId: session.organizationId,
        userId: session.userId,
        mfaTrusted: session.trusted,
        rememberMeIdConfigured: Boolean(config.rememberMeId),
        readOnly: config.readOnly,
        moneyMovementEnabled: config.enableMoneyMovement,
        spendApiConfigured: Boolean(config.spendApiToken),
        toolsets: [...config.toolsets],
        sessionDetails: remote,
      };
    },
  }),

  defineTool({
    name: "bill_refresh_session",
    title: "Refresh BILL session",
    description:
      "Discards the cached BILL session and signs in again (picks up a rememberMeId for MFA trust). Sessions otherwise renew automatically.",
    toolset: "session",
    kind: "read",
    input: {},
    handler: async (_args, { client }) => {
      client.invalidateSession();
      const s = await client.login();
      return { organizationId: s.organizationId, userId: s.userId, mfaTrusted: s.trusted };
    },
  }),

  defineTool({
    name: "bill_mfa_create_challenge",
    title: "Start MFA challenge",
    description:
      "Sends an MFA code to the BILL user's registered phone (step 1 of making the session MFA-trusted). MFA trust is required in production for payments, vendor bank accounts, and enabling autopay. Follow with bill_mfa_validate_challenge.",
    toolset: "session",
    kind: "write",
    input: {
      useBackup: z.boolean().optional().describe("Send the code to the backup phone instead of the primary"),
    },
    handler: (args, { client }) => client.post("/mfa/challenge", args.useBackup === undefined ? {} : { useBackup: args.useBackup }),
  }),

  defineTool({
    name: "bill_mfa_validate_challenge",
    title: "Validate MFA challenge",
    description:
      "Completes MFA with the code the user received, making the current session MFA-trusted. With rememberMe=true BILL returns a rememberMeId (valid 30 days); store it in BILL_REMEMBER_ME_ID so future logins are trusted automatically.",
    toolset: "session",
    kind: "write",
    input: {
      challengeId: id("MFA challenge").describe("challengeId returned by bill_mfa_create_challenge"),
      token: z.string().min(4).describe("The code the user received by SMS/voice"),
      rememberMe: z.boolean().optional().describe("Return a rememberMeId for trusted future sessions (default true)"),
      device: z.string().optional().describe("Device name to register (defaults to BILL_DEVICE_NAME)"),
      machineName: z.string().optional().describe("Machine name to register"),
    },
    handler: async (args, { client, config }) => {
      const rememberMe = args.rememberMe ?? true;
      const body: Record<string, unknown> = { challengeId: args.challengeId, token: args.token, rememberMe };
      if (rememberMe) {
        body.device = args.device ?? config.deviceName;
        body.machineName = args.machineName ?? args.device ?? config.deviceName;
      }
      const res = (await client.post("/mfa/challenge/validate", body)) as Record<string, unknown>;
      client.markSessionTrusted();
      return {
        ...res,
        next:
          typeof res?.rememberMeId === "string"
            ? `Session is now MFA-trusted. To keep future sessions trusted, set BILL_REMEMBER_ME_ID=${res.rememberMeId} and BILL_DEVICE_NAME=${String(body.device)} in the server environment.`
            : "Session is now MFA-trusted.",
      };
    },
  }),

  defineTool({
    name: "bill_mfa_step_up",
    title: "Step up session to MFA-trusted",
    description:
      "Marks the current session MFA-trusted using a previously issued rememberMeId (defaults to BILL_REMEMBER_ME_ID), without sending a new code.",
    toolset: "session",
    kind: "write",
    input: {
      rememberMeId: z.string().optional().describe("rememberMeId from an earlier validation (defaults to BILL_REMEMBER_ME_ID)"),
      device: z.string().optional().describe("Device name registered with the rememberMeId (defaults to BILL_DEVICE_NAME)"),
    },
    handler: async (args, { client, config }) => {
      const rememberMeId = args.rememberMeId ?? config.rememberMeId;
      if (!rememberMeId) {
        throw new Error("No rememberMeId supplied and BILL_REMEMBER_ME_ID is not set. Run the MFA challenge flow first.");
      }
      const res = await client.post("/mfa/step-up", { rememberMeId, device: args.device ?? config.deviceName });
      client.markSessionTrusted();
      return res;
    },
  }),
];
