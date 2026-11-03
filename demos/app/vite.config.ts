import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { parentOrigin } from "./cloudflare.config";

process.env.NEXT_PUBLIC_DEMO_PARENT_ORIGIN ??= parentOrigin;

export default defineConfig({
  resolve: {
    alias: {
      "@/features/agent/lib/xChatBrowserSession": fileURLToPath(
        new URL("./runtime/demoXChatBrowserSession.ts", import.meta.url)
      ),
      "@/features/composer/hooks/useVoiceNoteRecorder": fileURLToPath(
        new URL("./runtime/useSampleVoiceNoteRecorder.ts", import.meta.url)
      ),
      "@/shared/lib/linkedin/media": fileURLToPath(
        new URL("./runtime/demoMediaHelpers.ts", import.meta.url)
      ),
    },
  },
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
