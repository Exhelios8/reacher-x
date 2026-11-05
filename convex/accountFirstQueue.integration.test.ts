/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { buildLegacyWorkspaceTargetingSpec } from "./lib/targetingSpecCore";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const t = convexTest(schema, modules);
  const targetingSpec = buildLegacyWorkspaceTargetingSpec({
    description: "Find commercial sites being redesigned",
    profiles: [],
  });
  targetingSpec.searchHints.activityPhrases = [
    "refonte site",
    "migration catalogue",
  ];
  const workspaceId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      workosUserId: "queue-owner",
      email: "queue@example.test",
    });
    return ctx.db.insert("workspaces", {
      userId,
      name: "Queue test",
      description: targetingSpec.summary,
      targetingSpec,
      isDefault: true,
      updatedAt: 1,
    });
  });
  vi.stubEnv("ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS", workspaceId);
  const now = Date.now();
  const hint = (name: string, age = 1) =>
    `account_research_hint:${now - age * 86_400_000}|https://${name.toLowerCase()}.fr/news`;
  await t.mutation(internal.keywords.saveKeywordsBatch, {
    workspaceId,
    keywords: [
      {
        type: "social_query",
        value: "directeur marketing",
        source: "agent",
        platformTargets: ["linkedin"],
        linkedinSurface: "people",
        queryStyle: "role_title",
        discoveryStage: "strict",
      },
      ...["Acme", "Beta", "Gamma", "Stale"].map((name) => ({
        type: "social_query" as const,
        value: `${name} directeur marketing`,
        source: hint(name, name === "Stale" ? 100 : 1),
        platformTargets: ["linkedin" as const],
        linkedinSurface: "people" as const,
        queryStyle: "role_title" as const,
        discoveryStage: "strict" as const,
      })),
      {
        type: "social_query",
        value: "refonte site",
        source: "agent",
        platformTargets: ["linkedin"],
        linkedinSurface: "posts",
        queryStyle: "natural_phrase",
        discoveryStage: "strict",
      },
      {
        type: "social_query",
        value: "migration catalogue",
        source: "agent",
        platformTargets: ["linkedin"],
        linkedinSurface: "posts",
        queryStyle: "natural_phrase",
        discoveryStage: "strict",
      },
      {
        type: "social_query",
        value: "conseils marketing",
        source: "agent",
        platformTargets: ["linkedin"],
        linkedinSurface: "posts",
        queryStyle: "natural_phrase",
        discoveryStage: "strict",
      },
      {
        type: "social_query",
        value: "chief executive officer",
        source: "agent",
        platformTargets: ["twitter"],
        queryStyle: "role_title",
        discoveryStage: "strict",
      },
    ],
  });
  return { t, workspaceId };
}

test("account-first people queue contains only fresh named accounts, never generic backfill", async () => {
  const { t, workspaceId } = await fixture();
  const queueArgs = {
    workspaceId,
    surface: "people" as const,
    allowedDiscoveryStages: ["strict" as const],
    limit: 20,
  };
  const queue = await t.query(
    internal.keywords.getPrioritizedLinkedInQueries,
    queueArgs
  );
  expect(queue).toHaveLength(2);
  expect(
    queue.every((row) =>
      /^(Acme|Beta|Gamma) directeur marketing$/.test(row.value)
    )
  ).toBe(true);
  const restricted = await t.query(
    internal.keywords.getPrioritizedLinkedInQueries,
    {
      ...queueArgs,
      restrictToQueries: ["directeur marketing", "Beta directeur marketing"],
    }
  );
  expect(restricted.map((row) => row.value)).toEqual([
    "Beta directeur marketing",
  ]);
  const rows = await t.run((ctx) =>
    ctx.db
      .query("keywords")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect()
  );
  await t.run(async (ctx) => {
    for (const row of rows.filter((row) =>
      row.source?.startsWith("account_research_hint:")
    ))
      await ctx.db.patch(row._id, { status: "deprecated" });
  });
  expect(
    await t.query(internal.keywords.getPrioritizedLinkedInQueries, queueArgs)
  ).toEqual([]);
  expect(
    (
      await t.run((ctx) =>
        ctx.db
          .query("keywords")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
          .collect()
      )
    ).length
  ).toBe(rows.length);
});

test("one configured work phrase still discovers posts without any account hint; X keeps its queue", async () => {
  const { t, workspaceId } = await fixture();
  const posts = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "posts",
    allowedDiscoveryStages: ["strict"],
    limit: 20,
  });
  expect(posts).toHaveLength(1);
  expect(["refonte site", "migration catalogue"]).toContain(posts[0].value);
  expect(
    (
      await t.query(internal.keywords.getPrioritizedTwitterQueries, {
        workspaceId,
        limit: 5,
      })
    ).map((row) => row.value)
  ).toEqual(["chief executive officer"]);
});

test("only executed queries change search history, and opt-out retains generic queue behavior", async () => {
  const { t, workspaceId } = await fixture();
  const queue = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "people",
    limit: 2,
  });
  await t.mutation(internal.keywords.markQueriesAsSearched, {
    queryIds: queue.map((row) => row.id),
    platform: "linkedin",
    surface: "people",
    queryStats: [{ query: queue[0].value, postsFound: 0, success: true }],
  });
  const first = await t.run((ctx) => ctx.db.get(queue[0].id));
  const second = await t.run((ctx) => ctx.db.get(queue[1].id));
  expect(first?.lastSearchedLinkedInAt).toEqual(expect.any(Number));
  expect(second?.lastSearchedLinkedInAt).toBeUndefined();
  vi.stubEnv("ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS", "");
  const normal = await t.query(
    internal.keywords.getPrioritizedLinkedInQueries,
    { workspaceId, surface: "people", limit: 20 }
  );
  expect(normal.some((row) => row.value === "directeur marketing")).toBe(true);
  expect(normal.length).toBeGreaterThan(2);
});
