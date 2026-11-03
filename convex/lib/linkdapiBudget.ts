import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  assertProviderRequestAllowed,
  type ProviderRequestContext,
} from "./providerReliability";
import { getSystemRuntimeConfig } from "./runtimeConfigHelpers";

const internalLinkdApiBudget = (internal as any).linkdapiBudget;

export const LINKDAPI_PROVIDER = "linkdapi";

export function getLinkdApiBudgetConfig() {
  return getSystemRuntimeConfig().providers.linkdApi;
}

export async function acquireLinkdApiBudget(
  ctx: ActionCtx,
  consumer: string,
  requestContext?: Omit<ProviderRequestContext, "consumer" | "endpoint">
) {
  const reservation = await ctx.runAction(
    internalLinkdApiBudget.acquireLinkdApiBudgetInternal,
    {
      consumer,
    }
  );
  // Claim a probe only when ready to send; the circuit can change while queued.
  await assertProviderRequestAllowed(ctx, "linkdapi", {
    consumer,
    endpoint: consumer,
    ...requestContext,
  });
  return reservation;
}
