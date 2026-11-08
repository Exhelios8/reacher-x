import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getFunctionName, type FunctionArgs } from "convex/server";
import type { ActionCtx } from "./_generated/server";
import type { api, internal } from "./_generated/api";
import {
  searchBatch as peopleBatch,
  searchInternal,
} from "./integrations/linkedin/searchPeople";
import { searchBatch as postsBatch } from "./integrations/linkedin/searchPosts";
import {
  getRetriedActionStatus,
  runProviderActionRetried,
} from "./lib/retrier";
import { requestLinkdApiData } from "./integrations/linkedin/linkdapiClient";

vi.mock("./lib/retrier", () => ({
  getRetriedActionStatus: vi.fn(),
  runProviderActionRetried: vi.fn(),
}));
vi.mock("./integrations/linkedin/linkdapiClient", () => ({
  requestLinkdApiData: vi.fn(),
}));
const peopleHandler = (
  peopleBatch as unknown as {
    _handler: (
      ctx: ActionCtx,
      args: FunctionArgs<
        typeof api.integrations.linkedin.searchPeople.searchBatch
      >
    ) => Promise<{
      success: boolean;
      people: unknown[];
      queryStats: Array<{ success: boolean; peopleFound: number }>;
    }>;
  }
)._handler;
const postsHandler = (
  postsBatch as unknown as {
    _handler: (
      ctx: ActionCtx,
      args: FunctionArgs<
        typeof api.integrations.linkedin.searchPosts.searchBatch
      >
    ) => Promise<{
      success: boolean;
      posts: unknown[];
      queryStats: Array<{ success: boolean; postsFound: number }>;
    }>;
  }
)._handler;
const ctx = {} as ActionCtx;
const successfulPage = (empty = false) => ({
  success: true,
  people: empty
    ? []
    : Array.from({ length: 50 }, (_, index) => ({ urn: `person-${index}` })),
  posts: empty
    ? []
    : Array.from({ length: 50 }, (_, index) => ({ postID: `post-${index}` })),
  total: 1000,
  start: 0,
  count: 50,
  hasMore: true,
  searchMode: "keyword",
});

beforeEach(() => {
  vi.mocked(requestLinkdApiData).mockResolvedValue({
    results: [{ id: "france-geo" }],
  });
  vi.mocked(runProviderActionRetried).mockResolvedValue(
    "run" as Awaited<ReturnType<typeof runProviderActionRetried>>
  );
  vi.mocked(getRetriedActionStatus).mockResolvedValue({
    type: "completed",
    result: { type: "success", returnValue: successfulPage() },
  });
});
afterEach(() => vi.resetAllMocks());

test("named-employer search preserves geography and bounds pages, queries and returned people", async () => {
  const result = await peopleHandler(ctx, {
    queries: [
      "Acme directeur marketing",
      "Beta directeur marketing",
      "Gamma directeur marketing",
    ],
    count: 50,
    maxQueriesPerBatch: 10,
    location: "France",
    profileLanguage: "fr",
    accountFirstDiscovery: true,
  });
  expect(runProviderActionRetried).toHaveBeenCalledTimes(2);
  for (const [, ref, args] of vi.mocked(runProviderActionRetried).mock.calls) {
    expect(getFunctionName(ref)).toContain("searchPeople:searchInternal");
    expect(args).toMatchObject({
      searchMode: "keyword",
      geoUrn: "france-geo",
      profileLanguage: "fr",
      count: 10,
    });
    expect(args).not.toHaveProperty("start");
  }
  expect(result.success).toBe(true);
  expect(result.people).toHaveLength(10);
  expect(result.queryStats.map((item) => item.peopleFound)).toEqual([10, 10]);
});

test("unresolved requested geography never becomes a worldwide people query", async () => {
  vi.mocked(requestLinkdApiData).mockResolvedValue({ results: [] });
  await expect(
    peopleHandler(ctx, {
      queries: ["Acme directeur marketing"],
      location: "France",
      accountFirstDiscovery: true,
    })
  ).rejects.toThrow("location");
  expect(runProviderActionRetried).not.toHaveBeenCalled();
});

test("a bound current-company search uses the title filter and never falls back", async () => {
  await peopleHandler(ctx, {
    queries: ["directeur marketing"],
    currentCompany: "123",
    location: "France",
    accountFirstDiscovery: true,
  });
  expect(runProviderActionRetried).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runProviderActionRetried).mock.calls[0][2]).toMatchObject({
    query: "directeur marketing",
    searchMode: "title",
    currentCompany: "123",
    geoUrn: "france-geo",
  });
});

test("the actual native transport sends separate company and role filters", async () => {
  const handler = (
    searchInternal as unknown as {
      _handler: (
        ctx: ActionCtx,
        args: FunctionArgs<
          typeof internal.integrations.linkedin.searchPeople.searchInternal
        >
      ) => Promise<unknown>;
    }
  )._handler;
  vi.mocked(requestLinkdApiData).mockResolvedValueOnce({
    people: [],
    total: 0,
    start: 0,
    hasMore: false,
  });
  await handler(ctx, {
    query: "marketing",
    searchMode: "title",
    currentCompany: "3475985",
    count: 3,
  });
  expect(requestLinkdApiData).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      path: "/api/v1/search/people",
      query: expect.objectContaining({
        title: "marketing",
        currentCompany: "3475985",
        count: 3,
      }),
    })
  );
});

test("an empty constrained account search is successful and never broadens", async () => {
  vi.mocked(getRetriedActionStatus).mockResolvedValue({
    type: "completed",
    result: { type: "success", returnValue: successfulPage(true) },
  });
  const result = await peopleHandler(ctx, {
    queries: ["Acme directeur marketing"],
    location: "France",
    accountFirstDiscovery: true,
  });
  expect(result).toMatchObject({
    success: true,
    people: [],
    queryStats: [{ peopleFound: 0, success: true }],
  });
  expect(runProviderActionRetried).toHaveBeenCalledTimes(1);
});

test("bounded posts keep a single phrase, attempt and page even when the provider overreturns", async () => {
  const result = await postsHandler(ctx, {
    queries: ["refonte site", "migration catalogue"],
    sortBy: "date_posted",
    datePosted: "past-month",
    authorJobTitle: "Founder",
    accountFirstDiscovery: true,
  });
  expect(result.success).toBe(true);
  expect(result.posts).toHaveLength(10);
  expect(runProviderActionRetried).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runProviderActionRetried).mock.calls[0][2]).toMatchObject({
    query: "refonte site",
    datePosted: "past-month",
    authorJobTitle: "Founder",
  });
  expect(result.queryStats).toHaveLength(1);
});

test("empty recent posts are not a provider failure and do not trigger alternate queries", async () => {
  vi.mocked(getRetriedActionStatus).mockResolvedValue({
    type: "completed",
    result: { type: "success", returnValue: successfulPage(true) },
  });
  const result = await postsHandler(ctx, {
    queries: ["refonte site"],
    datePosted: "past-month",
    accountFirstDiscovery: true,
  });
  expect(result).toMatchObject({
    success: true,
    posts: [],
    queryStats: [{ postsFound: 0, success: true }],
  });
  expect(runProviderActionRetried).toHaveBeenCalledTimes(1);
});

test("ordinary people searches retain their existing unfiltered fallback", async () => {
  vi.mocked(getRetriedActionStatus).mockResolvedValue({
    type: "completed",
    result: {
      type: "success",
      returnValue: { ...successfulPage(true), hasMore: false },
    },
  });
  await peopleHandler(ctx, {
    queries: ["Acme directeur marketing"],
    location: "France",
  });
  expect(runProviderActionRetried).toHaveBeenCalledTimes(2);
  expect(vi.mocked(runProviderActionRetried).mock.calls[1][2]).toEqual({
    query: "Acme directeur marketing",
    searchMode: "keyword",
    geoUrn: undefined,
    profileLanguage: undefined,
    count: 50,
  });
});

test("invalid bounds cannot invert array slicing into a larger account search", async () => {
  const result = await peopleHandler(ctx, {
    queries: ["Acme directeur marketing"],
    count: -5,
    accountFirstDiscovery: true,
  });
  expect(result.people).toHaveLength(1);
  expect(vi.mocked(runProviderActionRetried).mock.calls[0][2]).toMatchObject({
    count: 1,
  });
  vi.mocked(runProviderActionRetried).mockClear();
  await postsHandler(ctx, {
    queries: ["refonte site", "migration catalogue"],
    maxQueriesPerBatch: -1,
    accountFirstDiscovery: true,
  });
  expect(runProviderActionRetried).not.toHaveBeenCalled();
});
