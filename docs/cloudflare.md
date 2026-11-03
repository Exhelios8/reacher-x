# Cloudflare deployment

The main app and isolated demo run as Cloudflare Workers through vinext. Convex hosts the database, functions, workflows, and provider credentials. No VPS is required.

## Build and deploy

Install dependencies from the committed pnpm lockfile. Authenticate the `cf` CLI against the account selected in `cloudflare.config.ts`.

```sh
npm run build:vinext
npx cf deploy --prebuilt --secrets-file /path/to/worker-secrets.json

npm run build:demo:vinext
cd demos/app
npx cf deploy --prebuilt
```

The main Worker secret file contains only `WORKOS_API_KEY` and `WORKOS_COOKIE_PASSWORD`. Keep it outside Git. Backend provider keys belong in the Convex deployment environment, not the frontend bundle.

The frontend public Convex URL is compiled into client assets. Check `.env.local` before building: running the Convex development CLI can replace it with a development URL. The Worker configuration and client bundle must both select the intended deployment.

The main build packages private blog MDX and font files into the Worker filesystem. The official KV adapter caches data; authenticated pages remain private and uncached. Generated `.cloudflare` runtime declarations are excluded from the application TypeScript program to avoid conflicting with browser and Convex globals.

Deploy the Convex backend separately:

```sh
npx convex deploy --typecheck enable
```

See [configuration.md](./configuration.md) for the native OpenAI provider and other service variables. WorkOS's application-specific issuer does not require an audience claim; its issuer and JWKS remain scoped to the configured client.

## Internal use

Public WorkOS signup is disabled for this installation. Use the existing complimentary-plan mutation for the owner's internal plan, rather than configuring a paid Polar checkout. Grants have an explicit expiry.

Both hostnames are excluded from indexing by a Cloudflare response-header rule. The demo uses synthetic data and restricts iframe embedding to the main app's origin.

`PAUSE_AUTONOMOUS_JOBS=true` pauses recurring background jobs during setup. It does not block every user-initiated operation. Review provider balances and targeting before enabling recurring discovery. X research uses SocialAPI; X posting/messaging requires separate developer credentials and is not configured for this installation.
