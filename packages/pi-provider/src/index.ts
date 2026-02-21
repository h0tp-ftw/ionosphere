// Type wrapper to avoid hard TS errors without full pi-ai typings installed locally
type ExtensionAPI = any;

import { streamIonosphereProvider } from "./streamAdapter";

export default function (pi: ExtensionAPI) {
    pi.registerProvider("gemini-ionosphere", {
        api: "custom", // Tells pi-ai to bypass standard REST fetch wrappers
        models: [{
            id: "auto-gemini-3",
            name: "Gemini CLI Bridge",
            contextWindow: 1048576,
            maxTokens: 8192
        }],
        streamSimple: streamIonosphereProvider
    });
}
