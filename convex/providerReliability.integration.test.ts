/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { acquireLinkdApiBudget } from "./lib/linkdapiBudget";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const requestResult = {
  provider: "socialapi" as const,
  consumer: "provider-reliability-test",
  endpoint: "/test",
  requestCount: 1,
  billableUnits: 1,
  estimatedCostUsd: 0,
  durationMs: 10,
};

describe("provider circuit write contention", () => {
  test("records healthy requests without creating or rewriting shared circuit state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const t = convexTest(schema, modules);

    await t.mutation(internal.providerReliability.recordProviderRequestResult, {
      ...requestResult,
      outcome: "success",
      healthEvidence: true,
    });
    await t.mutation(internal.providerReliability.recordProviderRequestResult, {
      ...requestResult,
      outcome: "success",
      healthEvidence: true,
    });

    const state = await t.run(async (ctx) => ({
      circuits: await ctx.db.query("providerCircuitStates").collect(),
      events: await ctx.db.query("providerRequestEvents").collect(),
    }));
    expect(state.circuits).toHaveLength(0);
    expect(state.events).toHaveLength(2);
  });

  test("writes the circuit row when health evidence closes a degraded state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const t = convexTest(schema, modules);
    const circuitId = await t.run(async (ctx) =>
      ctx.db.insert("providerCircuitStates", {
        provider: "socialapi",
        status: "open",
        reason: "transient",
        errorMessage: "Temporary provider failure",
        consecutiveFailures: 3,
        openedAt: 1_000,
        retryAfterAt: 2_000,
        lastFailureAt: 1_000,
        updatedAt: 1_000,
      })
    );

    await t.mutation(internal.providerReliability.recordProviderRequestResult, {
      ...requestResult,
      outcome: "success",
      healthEvidence: true,
    });

    expect(
      await t.run(async (ctx) => ctx.db.get("providerCircuitStates", circuitId))
    ).toMatchObject({
      status: "closed",
      consecutiveFailures: 0,
      lastSuccessAt: 20_000,
      updatedAt: 20_000,
    });
  });
});

describe("LinkdAPI circuit permission after pacing", () => {
  test("blocks a queued request when an earlier request opens the circuit", async () => {
    const t = convexTest(schema, modules);
    const waiting = deferred<void>();
    const slot = deferred<{ waitMs: number }>();
    const ctx = {
      runMutation: t.mutation,
      runAction: async () => {
        waiting.resolve();
        return slot.promise;
      },
    } as unknown as ActionCtx;
    const sendRequest = vi.fn();
    const queuedRequest = acquireLinkdApiBudget(ctx, "queued-request").then(
      sendRequest
    );
    await waiting.promise;
    await t.mutation(internal.providerReliability.recordProviderRequestResult, {
      ...requestResult,
      provider: "linkdapi",
      outcome: "error",
      circuitReason: "rate_limit",
      circuitRetryAfterMs: 60_000,
    });

    const blocked = expect(queuedRequest).rejects.toMatchObject({
      name: "ProviderCircuitOpenError",
      reason: "rate_limit",
    });
    slot.resolve({ waitMs: 10_000 });
    await blocked;
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test("starts the exclusive probe lease after its reserved wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    vi.stubEnv("PROVIDER_CIRCUIT_PROBE_LEASE_SECONDS", "30");
    const t = convexTest(schema, modules);
    const circuitId = await t.run(async (ctx) =>
      ctx.db.insert("providerCircuitStates", {
        provider: "linkdapi",
        status: "open",
        reason: "rate_limit",
        consecutiveFailures: 1,
        retryAfterAt: 10_000,
        updatedAt: 10_000,
      })
    );
    const waiting = deferred<void>();
    const slot = deferred<{ waitMs: number }>();
    const ctx = {
      runMutation: t.mutation,
      runAction: async () => {
        waiting.resolve();
        return slot.promise;
      },
    } as unknown as ActionCtx;
    const probe = acquireLinkdApiBudget(ctx, "queued-probe");
    await waiting.promise;
    expect(await t.run((ctx) => ctx.db.get(circuitId))).toMatchObject({
      status: "open",
    });

    vi.setSystemTime(60_000);
    slot.resolve({ waitMs: 40_000 });
    expect(await probe).toEqual({ waitMs: 40_000 });
    expect(await t.run((ctx) => ctx.db.get(circuitId))).toMatchObject({
      status: "half_open",
      probeLeaseUntil: 90_000,
    });
    expect(
      await t.mutation(
        internal.providerReliability.acquireProviderCircuitPermission,
        { provider: "linkdapi", consumer: "second-probe", endpoint: "/test" }
      )
    ).toMatchObject({ allowed: false });
  });
});
