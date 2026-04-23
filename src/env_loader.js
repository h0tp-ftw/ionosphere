import fs from "fs";
import path from "path";

/**
 * [IONOSPHERE] Native .env loader
 * This bootstrapper must be imported at the absolute top of the entry point
 * to ensure process.env is populated before any other modules initialize.
 */
try {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf-8");
    envContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const [key, ...values] = trimmed.split("=");
        if (key && values.length > 0) {
          const val = values.join("=").trim();
          // Populate process.env if not already set by shell
          if (key.trim() && !process.env[key.trim()]) {
             process.env[key.trim()] = val;
          }
        }
      }
    });
    console.log(`[Config] Bootstrapper: .env loaded successfully.`);
  } else {
    console.warn(`[Config] Bootstrapper: .env file not found at ${envPath}`);
  }
} catch (e) {
  console.error(`[Config] Bootstrapper failed to parse .env: ${e.message}`);
}
