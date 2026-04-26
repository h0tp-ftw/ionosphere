const MCP_SERVER_ALIAS = "io";

const AUTO_MODEL_LADDERS = {
  "auto-gemini-3": [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  "auto-gemini-2.5": [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
};

const loosenSchema = (obj) => {
  if (!obj || typeof obj !== "object") return;
  if (obj.format) {
    if (process.env.GEMINI_DEBUG_RESPONSES === "true") {
      console.log(
        `[Schema] Loosening: Removing 'format: ${obj.format}' from field.`,
      );
    }
    delete obj.format;
  }
  for (const key in obj) {
    if (typeof obj[key] === "object") {
      loosenSchema(obj[key]);
    }
  }
};

const stripMcpPrefix = (name) => {
  if (!name || typeof name !== 'string') return name;
  if (name.startsWith(`mcp_${MCP_SERVER_ALIAS}_`)) {
    return name.substring(`mcp_${MCP_SERVER_ALIAS}_`.length);
  }
  if (name.startsWith('mcp_ionosphere-tool-bridge_')) {
    return name.substring('mcp_ionosphere-tool-bridge_'.length);
  }
  if (name.startsWith('ionosphere__')) {
    return name.substring('ionosphere__'.length);
  }
  return name;
};

export { MCP_SERVER_ALIAS, AUTO_MODEL_LADDERS, loosenSchema, stripMcpPrefix };
