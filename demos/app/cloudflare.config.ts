import { bindings, defineConfig, defineWorker } from "cf/config";

export const parentOrigin = "https://reacher.pharelia.com";

export default defineConfig({
  accountId: "5f0c3f5469e68dd32b6cb13acaddea6a",
  worker: defineWorker({
    name: "pharelia-reacher-demo",
    domains: ["reacher-demo.pharelia.com"],
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-01",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      NEXT_PUBLIC_DEMO_PARENT_ORIGIN: bindings.text(parentOrigin),
    },
  }),
});
