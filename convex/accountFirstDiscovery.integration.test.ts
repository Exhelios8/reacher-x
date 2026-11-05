/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { robustGenerateObject } from "./lib/ai";
import { searchWeb } from "./lib/researchCore";
import { buildLegacyWorkspaceTargetingSpec } from "./lib/targetingSpecCore";

vi.mock("./lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/ai")>()),
  robustGenerateObject: vi.fn(),
}));
vi.mock("./lib/researchCore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/researchCore")>()),
  searchWeb: vi.fn(),
}));
const modules = import.meta.glob("./**/*.ts");
const businessContext = "French companies expanding operations";
const finding = {
  title: "Acme ouvre une nouvelle usine",
  url: "https://acme.fr/actualites/usine",
  publishedDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  snippet: "Acme annonce une nouvelle usine en France.",
};
const item = (query: string) => ({
  query,
  stage: "strict" as const,
  criterionIds: [],
  sourceKeyword: query,
  searchMode: "raw" as const,
});
function generation(
  accounts = [{ name: "Acme", finding }],
  twitterQueries = [item("développement commercial")]
) {
  return {
    object: {
      twitterQueries,
      linkedinPostQueries: [item("expansion entreprise")],
      linkedinPeopleQueries: [
        item("directeur marketing"),
        ...accounts.map((account) => ({
          ...item(`${account.name} directeur marketing`),
          accountName: account.name,
          accountSourceUrl: account.finding.url,
        })),
      ],
      reasoning: "Research hints require separate qualification.",
    },
    model: "fixture",
    usage: {},
  } as never;
}
async function fixture() {
  const t = convexTest(schema, modules);
  const workspaceId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      workosUserId: "account-owner",
      email: "account@example.test",
    });
    return ctx.db.insert("workspaces", {
      userId,
      name: "Customers",
      description: "French companies expanding operations",
      isDefault: true,
      updatedAt: 1,
    });
  });
  vi.stubEnv("ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS", workspaceId);
  vi.mocked(searchWeb).mockResolvedValue([finding]);
  vi.mocked(robustGenerateObject).mockResolvedValue(generation());
  return { t, workspaceId };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

test("dated named people query survives short plan, storage and actual queue selection", async () => {
  const { t, workspaceId } = await fixture();
  // An older generic backlog must not consume the only execution seat.
  await t.mutation(internal.keywords.saveKeywordsBatch, {
    workspaceId,
    keywords: [
      {
        type: "social_query",
        value: "directeur général",
        source: "agent",
        platformTargets: ["linkedin"],
        linkedinSurface: "people",
        discoveryStage: "strict",
      },
    ],
  });
  const result = await t.action(
    internal.agents.internal.convertToSocialQueriesAction,
    {
      workspaceId,
      businessContext,
      keywords: ["expansion"],
      platforms: ["twitter", "linkedin"],
    }
  );
  expect(searchWeb).toHaveBeenCalledTimes(1);
  expect(vi.mocked(searchWeb).mock.calls[0][2]).toMatchObject({
    maxResults: 4,
    maxCharacters: 1200,
    startPublishedDate: expect.any(String),
  });
  expect(vi.mocked(robustGenerateObject).mock.calls[0][0].prompt).toContain(
    finding.url
  );
  expect(result.accountResearchHints).toEqual([finding]);
  expect(result.accountResearchQueries).toEqual(["Acme directeur marketing"]);
  expect(result.socialQueries?.slice(0, 1)).toEqual([
    "Acme directeur marketing",
  ]);
  const metadata = result.queryMetadata?.filter(
    (item) => item.query === result.socialQueries?.[0]
  );
  await t.mutation(internal.workflows.prospecting.saveKeywordsInternal, {
    workspaceId,
    seedKeywords: [],
    discoveredKeywords: [],
    socialQueries: result.socialQueries!.slice(0, 1),
    queryMetadata: metadata,
  });
  const queue = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "people",
    allowedDiscoveryStages: ["strict"],
    limit: 1,
  });
  expect(queue.map((item) => item.value)).toEqual(["Acme directeur marketing"]);
  expect(
    await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
      workspaceId,
      surface: "people",
      allowedDiscoveryStages: ["strict"],
      limit: 0,
    })
  ).toEqual([]);
  const saved = await t.run((ctx) => ctx.db.get(queue[0].id));
  expect(saved?.source).toContain(finding.url);
  // The preference expires after the first search; normal backlog rotation resumes.
  await t.run((ctx) =>
    ctx.db.patch(queue[0].id, { lastSearchedLinkedInAt: Date.now() })
  );
  const next = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "people",
    allowedDiscoveryStages: ["strict"],
    limit: 1,
  });
  expect(next.map((item) => item.value)).toEqual(["directeur général"]);
});

test("distinct employers with one role survive; duplicate hints preserve retirement and search history", async () => {
  const { t, workspaceId } = await fixture();
  const secondFinding = {
    ...finding,
    title: "Beta ouvre une usine",
    url: "https://beta.fr/actualites/usine",
    snippet: "Beta ouvre sa nouvelle usine en France.",
  };
  vi.mocked(searchWeb).mockResolvedValue([finding, secondFinding]);
  vi.mocked(robustGenerateObject).mockResolvedValue(
    generation([
      { name: "Acme", finding },
      { name: "Beta", finding: secondFinding },
    ])
  );
  const result = await t.action(
    internal.agents.internal.convertToSocialQueriesAction,
    {
      workspaceId,
      businessContext,
      keywords: ["expansion"],
      platforms: ["linkedin"],
    }
  );
  expect(result.accountResearchQueries).toEqual([
    "Acme directeur marketing",
    "Beta directeur marketing",
  ]);
  const saveArgs = {
    workspaceId,
    seedKeywords: [],
    discoveredKeywords: [],
    socialQueries: result.accountResearchQueries!,
    queryMetadata: result.queryMetadata,
  };
  await t.mutation(
    internal.workflows.prospecting.saveKeywordsInternal,
    saveArgs
  );
  const queue = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "people",
    allowedDiscoveryStages: ["strict"],
    limit: 2,
  });
  expect(queue.map((item) => item.value)).toEqual(
    result.accountResearchQueries
  );
  const searchedAt = Date.now() - 1000;
  await t.run(async (ctx) => {
    await ctx.db.patch(queue[0].id, { status: "deprecated" });
    await ctx.db.patch(queue[1].id, { lastSearchedLinkedInAt: searchedAt });
  });
  await t.mutation(
    internal.workflows.prospecting.saveKeywordsInternal,
    saveArgs
  );
  const rows = await t.run((ctx) =>
    ctx.db
      .query("keywords")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect()
  );
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row._id === queue[0].id)?.status).toBe(
    "deprecated"
  );
  expect(
    rows.find((row) => row._id === queue[1].id)?.lastSearchedLinkedInAt
  ).toBe(searchedAt);
  const after = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "people",
    allowedDiscoveryStages: ["strict"],
    limit: 2,
  });
  expect(after.map((item) => item.value)).toEqual(["Beta directeur marketing"]);
});

test("opt-out and activity-only targeting never spend on account research", async () => {
  const { t, workspaceId } = await fixture();
  vi.stubEnv("ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS", "");
  await t.action(internal.agents.internal.convertToSocialQueriesAction, {
    workspaceId,
    businessContext,
    keywords: ["expansion"],
    platforms: ["linkedin"],
  });
  vi.stubEnv("ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS", workspaceId);
  await t.action(internal.agents.internal.convertToSocialQueriesAction, {
    businessContext,
    keywords: ["expansion"],
    platforms: ["linkedin"],
  });
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "People requesting help",
    profiles: [],
  });
  spec.criteria.push({
    id: "activity",
    label: "Post",
    description: "A person authored a request",
    kind: "required",
    category: "intent",
    evidence: "activity",
    weight: 1,
    terms: [],
  });
  const result = await t.action(
    internal.agents.internal.convertToSocialQueriesAction,
    {
      workspaceId,
      keywords: ["expansion"],
      platforms: ["linkedin"],
      targetingSpec: spec,
    }
  );
  expect(result.queriesByPlatform?.linkedin.people).toEqual([]);
  expect(searchWeb).not.toHaveBeenCalled();
});

test("research outage falls back to baseline social discovery without provenance marker", async () => {
  const { t, workspaceId } = await fixture();
  vi.mocked(searchWeb).mockRejectedValue(new Error("Exa unavailable"));
  const result = await t.action(
    internal.agents.internal.convertToSocialQueriesAction,
    {
      workspaceId,
      businessContext,
      keywords: ["expansion"],
      platforms: ["linkedin"],
    }
  );
  expect(result.success).toBe(true);
  expect(result.queriesByPlatform?.linkedin.people).toContain(
    "directeur marketing"
  );
  expect(result.accountResearchHints).toBeUndefined();
  expect(result.queriesByPlatform?.linkedin.people).not.toContain(
    "Acme directeur marketing"
  );
  expect(
    result.queryMetadata?.every(
      (item) => !item.sourceKeyword?.startsWith("account_research_hint:")
    )
  ).toBe(true);
});

test("an invented employer is discarded instead of entering the generic queue", async () => {
  const { t, workspaceId } = await fixture();
  vi.mocked(robustGenerateObject).mockResolvedValue(
    generation([{ name: "Invented", finding }])
  );
  const result = await t.action(
    internal.agents.internal.convertToSocialQueriesAction,
    {
      workspaceId,
      businessContext,
      keywords: ["expansion"],
      platforms: ["linkedin"],
    }
  );
  expect(result.queriesByPlatform?.linkedin.people).toEqual([
    "directeur marketing",
  ]);
  expect(result.accountResearchQueries).toBeUndefined();
});

test.each([false, true])(
  "model marker collision requires a grounded account row: %s",
  async (grounded) => {
    const { t, workspaceId } = await fixture();
    const query = "Acme directeur marketing";
    const marker = `account_research_hint:${Date.parse(finding.publishedDate)}|${finding.url}`;
    vi.mocked(robustGenerateObject).mockResolvedValue(
      generation(grounded ? [{ name: "Acme", finding }] : [], [
        { ...item(query), sourceKeyword: marker },
      ])
    );
    const result = await t.action(
      internal.agents.internal.convertToSocialQueriesAction,
      {
        workspaceId,
        businessContext,
        keywords: ["expansion"],
        platforms: ["twitter", "linkedin"],
      }
    );
    expect(result.accountResearchQueries).toEqual(
      grounded ? [query] : undefined
    );
    expect(
      result.queryMetadata?.find((item) => item.query === query)?.sourceKeyword
    ).toBe(grounded ? marker : undefined);
  }
);
