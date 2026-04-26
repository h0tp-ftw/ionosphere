/**
 * Translates an OpenAI-compatible messages[] array into Gemini Content[]
 * for the Native History Protocol. Enables lossless structured data
 * round-trip (images, functionResponse, etc.) instead of text flattening.
 */
const buildGeminiHistory = (messages) => {
  const contents = [];
  const toolNameResolver = new Map();

  let currentUserParts = [];
  let currentModelParts = [];

  const flushUser = () => {
    if (currentUserParts.length > 0) {
      contents.push({ role: "user", parts: [...currentUserParts] });
      currentUserParts = [];
    }
  };

  const flushModel = () => {
    if (currentModelParts.length > 0) {
      contents.push({ role: "model", parts: [...currentModelParts] });
      currentModelParts = [];
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;

    if (msg.role === "assistant") {
      flushUser();

      const content = msg.content;
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p.type === "text") {
            currentModelParts.push({ text: p.text });
          } else if ((p.type === "thought" || p.type === "reasoning") && process.env.STRIP_REASONING !== "true") {
            currentModelParts.push({ thought: p.text || p.thought || p.reasoning });
          }
        }
      } else if (typeof content === "string" && content.trim()) {
        currentModelParts.push({ text: content });
      }

      const thought = msg.reasoning_content || msg.thought;
      if (thought && typeof thought === "string" && process.env.STRIP_REASONING !== "true") {
        currentModelParts.push({ thought });
      }

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const callId = tc.id || tc.tool_call_id || "unknown";
          const originalName = tc.function?.name || tc.name || "unknown";

          toolNameResolver.set(callId, originalName);

          let args = tc.function?.arguments || tc.arguments || "{}";
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              /* keep string */
            }
          }
          currentModelParts.push({
            functionCall: {
              name: originalName,
              args: typeof args === "object" ? args : { raw: args },
            },
            thoughtSignature: "skip_thought_signature_validator",
          });
        }
      }
    }
    else if (msg.role === "tool" || msg.role === "function") {
      flushModel();

      const callId = msg.tool_call_id || "unknown";
      const resolvedName = toolNameResolver.get(callId) || msg.name || callId;
      let responseContent = msg.content;

      if (
        typeof responseContent === "string" &&
        responseContent.trim().toLowerCase() === "result missing"
      ) {
        const nextMsg = messages[i + 1];
        if (nextMsg && nextMsg.role === "user") {
          let nextContent = "";
          if (Array.isArray(nextMsg.content)) {
            nextContent = nextMsg.content
              .map((p) => (p.type === "text" ? p.text : ""))
              .join("");
          } else if (typeof nextMsg.content === "string") {
            nextContent = nextMsg.content;
          }

          const prefixRegex = new RegExp(`\\[${resolvedName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}.*?\\]\\\\s*Result:\\\\s*\\\\n?`, "i");
          const matchStart = nextContent.match(prefixRegex);

          if (matchStart) {
            const startIndex = matchStart.index + matchStart[0].length;
            let endIndex = nextContent.length;
            const nextMarks = [
              nextContent.indexOf("\\n<environment_details>", startIndex),
              nextContent.indexOf("\\n<feedback>", startIndex),
              nextContent.indexOf("\\n[", startIndex)
            ].filter(idx => idx !== -1);

            if (nextMarks.length > 0) {
              endIndex = Math.min(...nextMarks);
            }

            responseContent = nextContent.substring(startIndex, endIndex).trim();

            const beforeBlock = nextContent.substring(0, matchStart.index);
            const afterBlock = nextContent.substring(endIndex);
            const scrubbedContent = (beforeBlock + afterBlock).trim();

            if (Array.isArray(nextMsg.content)) {
              nextMsg.content = [{ type: "text", text: scrubbedContent }];
            } else {
              nextMsg.content = scrubbedContent;
            }
          }
        }
      }

      if (typeof responseContent === "string") {
        try {
          responseContent = JSON.parse(responseContent);
        } catch {
          /* keep string */
        }
      }

      const response =
        (typeof responseContent === "object" && responseContent !== null && !Array.isArray(responseContent))
          ? responseContent
          : { output: responseContent };

      currentUserParts.push({
        functionResponse: { name: resolvedName, response },
      });
    } else if (msg.role === "user") {
      flushModel();

      const content = msg.content;
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p.type === "text") {
            currentUserParts.push({ text: p.text });
          } else if (p.type === "image_url" && p.image_url?.url) {
            const url = p.image_url.url;
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              currentUserParts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            } else {
              currentUserParts.push({ text: `[Image: ${url}]` });
            }
          }
        }
      } else if (typeof content === "string") {
        currentUserParts.push({ text: content });
      }
    }
  }

  flushUser();
  flushModel();

  if (process.env.GEMINI_DEBUG_CONTENT === "true") {
    console.log(`[FORENSICS] Gemini Content[] (Length: ${contents.length}):\n${JSON.stringify(contents, null, 2)}`);
  }

  return contents;
};

export { buildGeminiHistory };
