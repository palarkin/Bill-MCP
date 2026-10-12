#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, TOOLSETS } from "./config.js";
import { buildServer, SERVER_VERSION } from "./server.js";
import { allTools } from "./tools/index.js";
import { shouldRegister } from "./tools/registry.js";
import { logger } from "./util/logger.js";

const HELP = `bill-mcp ${SERVER_VERSION} — MCP server for the BILL (Bill.com) v3 API

Usage: bill-mcp [--list-tools] [--help] [--version]

Runs over stdio. Configure with environment variables:
  BILL_ENVIRONMENT            sandbox (default) | production
  BILL_USERNAME, BILL_PASSWORD, BILL_ORGANIZATION_ID, BILL_DEV_KEY   (required for the core API)
  BILL_REMEMBER_ME_ID, BILL_DEVICE_NAME   MFA-trusted sessions
  BILL_SPEND_API_TOKEN        enables Spend & Expense tools
  BILL_READ_ONLY              true to expose read-only tools only
  BILL_ENABLE_MONEY_MOVEMENT  true to expose payment / charge / bank-detail tools
  BILL_TOOLSETS               comma list or "all": ${TOOLSETS.join(", ")}
  BILL_UPLOAD_ROOT            directory local document uploads may read from
  BILL_MAX_CONCURRENCY (3), BILL_MAX_RETRIES (4), BILL_TIMEOUT_MS (60000),
  BILL_SESSION_IDLE_MINUTES (30), BILL_MAX_FETCH_ALL (2000), BILL_MAX_RESPONSE_CHARS (100000),
  BILL_API_HOST (override gateway host), BILL_LOG_LEVEL (info)
`;

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.has("--version") || args.has("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const config = loadConfig();

  if (args.has("--list-tools")) {
    for (const tool of allTools(config)) {
      const reason = shouldRegister(tool, config);
      process.stdout.write(
        `${reason ? "-" : "+"} ${tool.name.padEnd(42)} ${tool.toolset.padEnd(16)} ${tool.kind.padEnd(6)}${reason ? `  (${reason})` : ""}\n`,
      );
    }
    return;
  }

  const { server } = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}; shutting down`);
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
