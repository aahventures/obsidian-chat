import type { ChatSettings, ContentBlock, McpServer, UnifiedMessage } from "../types";

/** Anthropic's MCP connector: `mcp_servers` plus an `mcp_toolset` for each. */
export const MCP_BETA = "mcp-client-2025-11-20";

/** An address the API takes for a server: https, as it reaches it from the internet. */
export function isMcpAddress(url: string): boolean {
  return /^https:\/\/\S+$/.test(url.trim());
}

/** The servers a request connects to: on, and at an address the API takes. */
export function activeMcpServers(settings: Pick<ChatSettings, "mcpServers">): McpServer[] {
  return (settings.mcpServers ?? []).filter((s) => s.enabled && isMcpAddress(s.url));
}

/**
 * The name each server is sent under, which its calls come back with: its own
 * name in lowercase letters, digits and dashes, so whatever was typed is a
 * valid one. Two that come out the same get a number.
 */
export function mcpServerNames(servers: McpServer[]): Map<McpServer, string> {
  const names = new Map<McpServer, string>();
  const taken = new Set<string>();
  for (const server of servers) {
    const base = server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    names.set(server, name);
  }
  return names;
}

/** How an MCP call is labelled in the chat: the server, then the tool. */
export function mcpCallLabel(block: ContentBlock): string {
  return `${block.server ?? "mcp"}: ${block.name ?? "tool"}`;
}

const isMcp = (b: ContentBlock) => b.type === "mcp_tool_use" || b.type === "mcp_tool_result";

/**
 * The history with each MCP call to a server not in `sent` turned into text,
 * for a request that can't send it as a block: another provider, or a server
 * that's off or renamed since, which the request doesn't name. The model still
 * sees what the call found.
 */
export function mcpCallsAsText(messages: UnifiedMessage[], sent: ReadonlySet<string> = new Set()): UnifiedMessage[] {
  const stray = (b: ContentBlock) => isMcp(b) && !sent.has(b.server ?? "");
  const hasStray = (m: UnifiedMessage) => typeof m.content !== "string" && m.content.some(stray);
  if (!messages.some(hasStray)) return messages;
  return messages.map((message) => {
    if (!hasStray(message)) return message;
    const content = (message.content as ContentBlock[]).map((b): ContentBlock => {
      if (!stray(b)) return b;
      const tool = `the ${b.name} tool of the ${b.server} MCP server`;
      const text = b.type === "mcp_tool_use"
        ? `[Called ${tool} with ${JSON.stringify(b.input ?? {})}]`
        : `[${b.is_error ? "Error from" : "Result of"} ${tool}:]\n${b.content ?? ""}`;
      // Set apart, as the text around it may be joined to it.
      return { type: "text", text: `\n\n${text}\n\n` };
    });
    return { ...message, content };
  });
}
