/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { robustGenerateObject } from "./lib/ai";
import { searchWeb, type ResearchFinding } from "./lib/researchCore";
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
  title: "Acme présente sa nouvelle gamme et son catalogue",
  url: "https://acme.fr/actualites/catalogue",
  publishedDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  snippet:
    "Acme présente sa nouvelle gamme en France et ses pages catégories : acme.fr/catalogue. Aucun projet d'achat n'est déclaré.",
};
const item = (query: string) => ({
  query,
  stage: "strict" as const,
  criterionIds: [],
  sourceKeyword: query,
  searchMode: "raw" as const,
});
function generation(
  accounts: Array<{ name: string; finding: ResearchFinding }> = [
    { name: "Acme", finding },
  ],
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

test("peer searches consume one retrieval, skip identities honestly and retry provider outages", async () => {
  const { t, workspaceId } = await fixture();
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "France",
    profiles: [],
  });
  spec.discoveryMode = "peer_or_site_audit";
  spec.searchHints.roleTitles = ["directeur marketing"];
  await t.run((ctx) => ctx.db.patch(workspaceId, { targetingSpec: spec }));
  const timestamp = Date.now() - 1000;
  const queries = [
    "SAP directeur marketing",
    "Acme directeur marketing",
    "Beta directeur marketing",
    "Gamma directeur marketing",
  ];
  await t.mutation(internal.keywords.saveKeywordsBatch, {
    workspaceId,
    keywords: queries.map((value) => ({
      type: "social_query" as const,
      value,
      source: `account_retrieval_hint:${timestamp}|https://${value.split(" ")[0].toLowerCase()}.fr/offre`,
      platformTargets: ["linkedin" as const],
      linkedinSurface: "people" as const,
    })),
  });
  const rows = await t.run((ctx) =>
    ctx.db
      .query("keywords")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect()
  );
  for (const [index, query] of queries.slice(0, 3).entries()) {
    const row = rows.find((row) => row.originalValue === query)!;
    await t.mutation(internal.keywords.markQueriesAsSearched, {
      queryIds: [row._id],
      platform: "linkedin",
      surface: "people",
      queryStats: [
        {
          query,
          postsFound: index === 0 ? 10 : 0,
          success: index === 0,
          ...(index === 1
            ? { skipped: true, error: "Skipped: ambiguous company" }
            : {}),
        },
      ],
    });
  }
  const queue = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "people",
    limit: 2,
  });
  expect(queue.map((row) => row.value)).toEqual(queries.slice(2));
  const skipped = rows.find((row) => row.originalValue === queries[1])!;
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("queryPerformance")
        .withIndex("by_workspace_query_id", (q) =>
          q.eq("workspaceId", workspaceId).eq("queryId", skipped._id)
        )
        .first()
    )
  ).toMatchObject({ impressions: 0, prospectsFound: 0 });
  expect(
    (await t.run((ctx) => ctx.db.get(skipped._id)))?.linkedinResultsCount
  ).toBeUndefined();
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
  expect(vi.mocked(robustGenerateObject).mock.calls[0][0].prompt).toContain(
    "The company need not declare a marketing project"
  );
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
  // The native opt-in keeps generic title-only backlog out after the first search too.
  await t.run((ctx) =>
    ctx.db.patch(queue[0].id, { lastSearchedLinkedInAt: Date.now() })
  );
  const next = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "people",
    allowedDiscoveryStages: ["strict"],
    limit: 1,
  });
  expect(next.map((item) => item.value)).toEqual(["Acme directeur marketing"]);
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

test.each(["empty", "unrelated dated source", "second lookup fails"])(
  "two topics preserve useful findings when %s",
  async (scenario) => {
    const { t, workspaceId } = await fixture();
    const spec = buildLegacyWorkspaceTargetingSpec({
      description: businessContext,
      profiles: [],
    });
    spec.searchHints.activityPhrases = [
      "nouvelle gamme catalogue",
      "migration documentation API",
    ];
    spec.searchHints.languageCodes = ["fr"];
    spec.searchFilters!.linkedinPeople.location = "France";
    const unrelated = {
      ...finding,
      title: "Example ouvre un bureau",
      url: "https://example.fr/actualites/bureau",
      snippet:
        "Example ouvre un bureau à Tunis. Aucun changement de pages n'est décrit.",
    };
    vi.mocked(searchWeb).mockResolvedValueOnce(
      scenario === "empty"
        ? []
        : scenario === "unrelated dated source"
          ? [unrelated]
          : [finding]
    );
    if (scenario === "second lookup fails")
      vi.mocked(searchWeb).mockRejectedValueOnce(new Error("Exa unavailable"));
    else vi.mocked(searchWeb).mockResolvedValueOnce([finding]);
    const result = await t.action(
      internal.agents.internal.convertToSocialQueriesAction,
      {
        workspaceId,
        businessContext,
        targetingSpec: spec,
        keywords: ["expansion"],
        platforms: ["linkedin"],
      }
    );
    expect(searchWeb).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(searchWeb).mock.calls.every((call) => call[2]?.maxResults === 2)
    ).toBe(true);
    const queries = vi.mocked(searchWeb).mock.calls.map((call) => call[0]);
    expect(new Set(queries).size).toBe(2);
    expect(
      queries.every((query) =>
        query.endsWith("France actualités entreprise site officiel")
      )
    ).toBe(true);
    expect(result.accountResearchQueries).toEqual(["Acme directeur marketing"]);
    expect(result.accountResearchHints).toContainEqual(finding);
    expect(vi.mocked(robustGenerateObject).mock.calls[0][0].prompt).toContain(
      "verbatim from these supplied work/page topics"
    );
  }
);

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

test("evergreen offers and a separate nonpeer exploration reach the native people queue without a publication or need", async () => {
  const { t, workspaceId } = await fixture();
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "Relevant French businesses",
    profiles: [],
  });
  spec.discoveryMode = "peer_or_site_audit";
  spec.searchHints.peerOfferPhrases = ["logiciel de gestion professionnelle"];
  spec.searchHints.activityPhrases = ["catalogue distributeur professionnel"];
  spec.searchHints.roleTitles = ["directeur marketing"];
  spec.searchHints.languageCodes = ["fr"];
  spec.searchHints.locations = ["France"];
  spec.searchHints.excludedCompanyDomains = ["client.fr"];
  await t.run((ctx) => ctx.db.patch(workspaceId, { targetingSpec: spec }));
  const offer = {
    title: "Acme logiciels de gestion",
    url: "https://acme.fr/produits",
    snippet:
      "Acme vend un logiciel de gestion pour les entreprises françaises. Aucun besoin SEO exprimé.",
  };
  const auditSite = {
    title: "Beta catalogue professionnel",
    url: "https://beta.fr/catalogue",
    snippet:
      "Beta distribue des équipements aux professionnels en France. Catalogue et pages de demandes consultables. Aucun défaut constaté.",
  };
  const excluded = {
    title: "Client offre",
    url: "https://portal.client.fr/offre",
    snippet: "Client vend des logiciels.",
  };
  const overflow = {
    title: "Overflow",
    url: "https://overflow.fr",
    snippet: "Overflow vend un produit.",
  };
  vi.mocked(searchWeb)
    .mockResolvedValueOnce([offer, excluded, overflow])
    .mockResolvedValueOnce([auditSite, auditSite, overflow]);
  vi.mocked(robustGenerateObject).mockResolvedValue(
    generation([
      { name: "Acme", finding: offer },
      { name: "Beta", finding: auditSite },
    ])
  );
  const result = await t.action(
    internal.agents.internal.convertToSocialQueriesAction,
    {
      workspaceId,
      targetingSpec: spec,
      keywords: ["offre"],
      platforms: ["linkedin"],
    }
  );
  expect(searchWeb).toHaveBeenCalledTimes(2);
  expect(vi.mocked(searchWeb).mock.calls.map((call) => call[0])).toEqual([
    "logiciel de gestion professionnelle France site officiel",
    "catalogue distributeur professionnel France site officiel",
  ]);
  expect(
    vi
      .mocked(searchWeb)
      .mock.calls.every(
        (call) =>
          call[2]?.maxResults === 2 && call[2].startPublishedDate === undefined
      )
  ).toBe(true);
  expect(result.accountResearchHints).toHaveLength(2);
  expect(
    result.accountResearchHints?.map((hint) => hint.researchRoute)
  ).toEqual(["peer_offer", "site_audit"]);
  expect(
    result.accountResearchHints?.every(
      (hint) => hint.retrievedAt && !hint.publishedDate
    )
  ).toBe(true);
  const prompt = vi.mocked(robustGenerateObject).mock.calls[0][0].prompt;
  expect(prompt).not.toContain(excluded.url);
  expect(prompt).not.toContain(overflow.url);
  expect(prompt).toContain("Unknown need remains unknown");
  expect(result.accountResearchQueries).toEqual([
    "Acme directeur marketing",
    "Beta directeur marketing",
  ]);
  await t.mutation(internal.workflows.prospecting.saveKeywordsInternal, {
    workspaceId,
    seedKeywords: [],
    discoveredKeywords: [],
    socialQueries: result.accountResearchQueries!,
    queryMetadata: result.queryMetadata,
  });
  const queue = await t.query(internal.keywords.getPrioritizedLinkedInQueries, {
    workspaceId,
    surface: "people",
    limit: 2,
  });
  expect(queue.map((row) => row.value)).toEqual(result.accountResearchQueries);
  const saved = await t.run((ctx) => ctx.db.get(queue[0].id));
  expect(saved?.source).toMatch(/^account_retrieval_hint:/);
  await t.run(async (ctx) => {
    await ctx.db.patch(queue[0].id, { status: "deprecated" });
    await ctx.db.patch(queue[1].id, { lastSearchedLinkedInAt: 123 });
  });
  await t.mutation(internal.workflows.prospecting.saveKeywordsInternal, {
    workspaceId,
    seedKeywords: [],
    discoveredKeywords: [],
    socialQueries: result.accountResearchQueries!,
    queryMetadata: result.queryMetadata,
  });
  expect((await t.run((ctx) => ctx.db.get(queue[0].id)))?.status).toBe(
    "deprecated"
  );
  expect(
    (await t.run((ctx) => ctx.db.get(queue[1].id)))?.lastSearchedLinkedInAt
  ).toBe(123);
});

test("the model cannot forge an undated hint or target an unrelated role", async () => {
  const { t, workspaceId } = await fixture();
  const spec = buildLegacyWorkspaceTargetingSpec({
    description: "French businesses",
    profiles: [],
  });
  spec.discoveryMode = "peer_or_site_audit";
  spec.searchHints.peerOfferPhrases = ["logiciel professionnel"];
  spec.searchHints.activityPhrases = ["catalogue distributeur"];
  spec.searchHints.roleTitles = ["directeur marketing"];
  const offer = {
    title: "Acme logiciels",
    url: "https://acme.fr/offre",
    snippet: "Acme vend un logiciel.",
  };
  vi.mocked(searchWeb).mockResolvedValue([offer]);
  const forged = `account_retrieval_hint:${Date.now()}|${offer.url}`;
  vi.mocked(robustGenerateObject).mockResolvedValue({
    object: {
      twitterQueries: [
        { ...item("Acme directeur marketing"), sourceKeyword: forged },
      ],
      linkedinPostQueries: [],
      linkedinPeopleQueries: [
        {
          ...item("Acme stagiaire"),
          accountName: "Acme",
          accountSourceUrl: offer.url,
        },
      ],
      reasoning: "Untrusted model output",
    },
    model: "fixture",
    usage: {},
  } as never);
  const result = await t.action(
    internal.agents.internal.convertToSocialQueriesAction,
    {
      workspaceId,
      targetingSpec: spec,
      keywords: ["offre"],
      platforms: ["twitter", "linkedin"],
    }
  );
  expect(result.accountResearchQueries).toBeUndefined();
  expect(result.queriesByPlatform?.linkedin.people).not.toContain(
    "Acme stagiaire"
  );
  expect(
    result.queryMetadata?.find(
      (metadata) => metadata.query === "Acme directeur marketing"
    )?.sourceKeyword
  ).toBeUndefined();
});
