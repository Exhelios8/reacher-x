import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  accountId: "5f0c3f5469e68dd32b6cb13acaddea6a",
  worker: defineWorker({
    name: "pharelia-reacher-x",
    domains: ["reacher.pharelia.com"],
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
      VINEXT_KV_CACHE: bindings.kv({ id: "6b81c82a0309486d93c80966accee407" }),
      NEXT_PUBLIC_CONVEX_URL: bindings.text(
        "https://adventurous-pheasant-110.eu-west-1.convex.cloud"
      ),
      NEXT_PUBLIC_SITE_URL: bindings.text("https://reacher.pharelia.com"),
      NEXT_PUBLIC_BLOG_DEMO_ORIGIN: bindings.text(
        "https://reacher-demo.pharelia.com"
      ),
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: bindings.text(
        "https://reacher.pharelia.com/callback"
      ),
      WORKOS_CLIENT_ID: bindings.text("client_01M6F9B4X3KXZ6QCJ5P6N53N2N"),
      WORKOS_API_KEY: bindings.secret(),
      WORKOS_COOKIE_PASSWORD: bindings.secret(),
    },
  }),
});
