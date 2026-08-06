/**
 * Connect a Cloudflare Agent to the remote Clarity MCP server.
 *
 * This source is an integration example, not a deployment configuration.
 * Add it to an existing Agents project that already depends on `agents`.
 */
import { Agent } from "agents";

const CLARITY_ENDPOINT = "https://mcp.healthai.com";
const READ_ONLY_TOOLS = new Set([
  "check_ingredient",
  "check_stack",
  "find_alternatives",
  "strain_lookup",
  "check_interaction",
  "score_product",
  "check_recall",
]);

export class ClarityExampleAgent extends Agent {
  async onStart() {
    await this.addMcpServer("Clarity", CLARITY_ENDPOINT, {
      id: "clarity",
      transport: {
        type: "streamable-http",
      },
    });
  }

  async onRequest() {
    const connectedTools = this.mcp.listTools({ serverId: "clarity" });
    const safeToolNames = connectedTools
      .filter((tool) => READ_ONLY_TOOLS.has(tool.name))
      .map((tool) => tool.name)
      .sort();

    return Response.json({
      server: "clarity",
      endpoint: CLARITY_ENDPOINT,
      readOnlyTools: safeToolNames,
      note: "Pass these tools to your model through an explicit application workflow.",
    });
  }
}
