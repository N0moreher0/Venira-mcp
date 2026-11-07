import { randomBytes } from "node:crypto";

/**
 * Identifier that binds approvals and tags audit rows for this server process.
 *
 * Set VENIRA_SESSION_ID so test/verify runs can trace their own audit rows.
 * The default prefix is client-neutral: the id is minted at module load, before
 * the MCP handshake says which client (Claude Desktop, opencode, ...) connected.
 *
 * Lives in its own module so tool handlers can import it without a cycle back
 * into tools/project.ts (which still re-exports it for existing callers).
 */
export const SESSION_ID: string =
  process.env.VENIRA_SESSION_ID ?? `mcp-${process.pid}-${randomBytes(3).toString("hex")}`;
