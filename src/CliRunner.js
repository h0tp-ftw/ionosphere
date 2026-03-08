import path from "path";
import fs from "fs";

/**
 * Handles locating the Gemini CLI and building arguments for spawn.
 */
export class CliRunner {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
  }

  /**
   * Identifies the correct executable and initial arguments for spawning the CLI.
   */
  getExecutableAndArgs() {
    let cliPath =
      process.env.GEMINI_CLI_PATH ||
      path.join(this.cwd, "node_modules", ".bin", "gemini");
      
    let executable = cliPath;
    let initialArgs = ["-y", "-o", "stream-json"];

    // Handle cases where cliPath contains the runner (e.g. "node cli.js")
    if (cliPath.includes(" ")) {
      const parts = cliPath.split(" ");
      executable = parts[0];
      initialArgs = [...parts.slice(1), ...initialArgs];
    } else if (cliPath.endsWith(".js")) {
      executable = "node";
      initialArgs = [cliPath, ...initialArgs];
    } else if (process.platform === "win32" && cliPath === "gemini") {
      executable = "gemini.cmd";
    }

    return { executable, initialArgs };
  }

  /**
   * Prepares the full argument array for a prompt turn.
   */
  buildFinalArgs(initialArgs, options) {
    const { attachments } = options;
    const finalArgs = [...initialArgs];

    if (attachments && attachments.length > 0) {
      const attachmentRefs = attachments.map((p) => `@${p}`).join(" ");
      finalArgs.push("-p", attachmentRefs);
    }

    return finalArgs;
  }

  /**
   * Prepares the environment variables for the spawned process.
   */
  prepareEnv(settingsPath, extraEnv, systemPromptPath) {
    const spawnEnv = {
      ...process.env,
      GEMINI_SETTINGS_JSON: settingsPath,
      GEMINI_PROMPT_AGENTSKILLS: "0",
      GEMINI_PROMPT_AGENTCONTEXTS: "0",
      ...extraEnv,
    };

    if (systemPromptPath) {
      spawnEnv.GEMINI_SYSTEM_MD = systemPromptPath;
    }

    return spawnEnv;
  }
}
