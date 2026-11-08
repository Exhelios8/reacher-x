import { afterEach, describe, expect, test, vi } from "vitest";
import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReturnType,
} from "convex/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { searchLinkedInInternal } from "./workflows/prospecting";

type Args = FunctionArgs<
  typeof internal.workflows.prospecting.searchLinkedInInternal
>;
type Result = FunctionReturnType<
  typeof internal.workflows.prospecting.searchLinkedInInternal
>;
// Convex's registered _handler is used to spy on the real orchestration's
// provider boundary without performing external searches in regression tests.
const handler = (
  searchLinkedInInternal as unknown as {
    _handler: (ctx: ActionCtx, args: Args) => Promise<Result>;
  }
)._handler;
afterEach(() => vi.unstubAllEnvs());

async function execute(applyProviderFilters?: boolean) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = {
    runQuery: vi.fn(async () => ({
      userId: "test-user",
      name: "QA",
      targetingSpec: {
        searchFilters: {
          linkedinPosts: {
            authorJobTitle: "Founder",
            datePosted: "past-month",
          },
          linkedinPeople: { location: "United States", profileLanguage: "en" },
        },
      },
    })),
    runAction: async (
      ref: Parameters<typeof getFunctionName>[0],
      args: Record<string, unknown>
    ): Promise<unknown> => {
      const name = getFunctionName(ref);
      if (name === "workflows/prospecting:searchLinkedInInternal")
        return await handler(ctx as unknown as ActionCtx, args as Args);
      calls.push({ name, args });
      const queries = args.queries as string[];
      return {
        success: true,
        posts: [],
        people: [],
        matchedQueriesByPostId: {},
        matchedQueriesByPersonUrn: {},
        errors: [],
        queryStats: queries.map((query) => ({
          query,
          success: true,
          postsFound: 0,
          peopleFound: 0,
        })),
      };
    },
  };
  const result = await handler(ctx as unknown as ActionCtx, {
    workspaceId: "workspace" as Id<"workspaces">,
    postQueries: ["strict post", "balanced post", "broad post"],
    peopleQueries: ["strict person", "broad person"],
    relaxedQueries: ["balanced post", "broad post", "broad person"],
    applyProviderFilters,
  });
  return { calls, result };
}
describe("LinkedIn discovery stages at the provider boundary", () => {
  test("strict searches receive supported filters; balanced and broad do not", async () => {
    const { calls, result } = await execute();
    expect(result.success).toBe(true);
    expect(result.postQueryStats).toHaveLength(3);
    expect(result.peopleQueryStats).toHaveLength(2);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      const queries = call.args.queries as string[];
      const strict = queries[0].startsWith("strict");
      if (call.name.includes("searchPeople")) {
        expect(call.args.location).toBe(strict ? "United States" : undefined);
        expect(call.args.profileLanguage).toBe(strict ? "en" : undefined);
      } else {
        expect(call.args.authorJobTitle).toBe(strict ? "Founder" : undefined);
        expect(call.args.datePosted).toBe(strict ? "past-month" : undefined);
      }
    }
  });
  test("an explicit filters-off override is never re-enabled by stage splitting", async () => {
    const { calls, result } = await execute(false);
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls)
      for (const key of [
        "location",
        "profileLanguage",
        "authorJobTitle",
        "datePosted",
      ])
        expect(call.args[key]).toBeUndefined();
  });
});

async function executeAccountFirst(
  peopleFail = false,
  companyWebsite = "https://acme.fr",
  companyOutage = false
) {
  vi.stubEnv("ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS", "workspace");
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const workspace = {
    userId: "test-user",
    name: "QA",
    targetingSpec: {
      discoveryMode: "peer_or_site_audit",
      searchHints: { roleTitles: ["directeur marketing"] },
      searchFilters: {
        linkedinPosts: { datePosted: "past-year" },
        linkedinPeople: { location: "France", profileLanguage: "fr" },
      },
    },
  };
  const ctx = {
    runQuery: vi.fn(
      async (
        ref: Parameters<typeof getFunctionName>[0],
        args: Record<string, unknown>
      ) => {
        if (getFunctionName(ref) === "keywords:getPrioritizedLinkedInQueries") {
          const eligible =
            args.surface === "people"
              ? "Acme directeur marketing"
              : "refonte site";
          return (args.restrictToQueries as string[]).includes(eligible)
            ? [
                {
                  value: eligible,
                  source: `account_retrieval_hint:${Date.now()}|https://acme.fr/offre`,
                },
              ]
            : [];
        }
        return workspace;
      }
    ),
    runAction: async (
      ref: Parameters<typeof getFunctionName>[0],
      args: Record<string, unknown>
    ) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name === "integrations/linkedin/getCompany:getCompany")
        if (companyOutage)
          return { success: false, retryable: true, error: "HTTP 503" };
      if (name === "integrations/linkedin/getCompany:getCompany")
        return {
          success: true,
          company: { id: "123", name: "Acme", website: companyWebsite },
        };
      if (peopleFail && name.includes("searchPeople"))
        throw new Error("People provider unavailable");
      const queries = args.queries as string[];
      return {
        success: true,
        people: [],
        posts: [],
        matchedQueriesByPostId: {},
        matchedQueriesByPersonUrn: {},
        errors: [],
        queryStats: queries.map((query) => ({
          query,
          success: true,
          postsFound: 0,
          peopleFound: 0,
        })),
      };
    },
  };
  const result = await handler(ctx as unknown as ActionCtx, {
    workspaceId: "workspace" as Id<"workspaces">,
    postQueries: ["conseils marketing", "refonte site", "migration catalogue"],
    peopleQueries: ["CEO", "Acme directeur marketing", "marketing manager"],
    relaxedQueries: ["Acme directeur marketing", "refonte site"],
    applyProviderFilters: false,
  });
  return { calls, result };
}

test("account-first action rechecks named eligibility and preserves filters despite a relaxed flag", async () => {
  const { calls, result } = await executeAccountFirst();
  expect(result.success).toBe(true);
  expect(calls).toHaveLength(3);
  const people = calls.find((call) => call.name.includes("searchPeople"))!;
  const posts = calls.find((call) => call.name.includes("searchPosts"))!;
  expect(people.args).toMatchObject({
    queries: ["directeur marketing"],
    currentCompany: "123",
    count: 10,
    location: "France",
    profileLanguage: "fr",
    accountFirstDiscovery: true,
  });
  expect(posts.args).toMatchObject({
    queries: ["refonte site"],
    sortBy: "date_posted",
    datePosted: "past-month",
    accountFirstDiscovery: true,
  });
  expect(result.postQueryStats).toHaveLength(1);
  expect(result.peopleQueryStats).toHaveLength(1);
  expect(result.peopleQueryStats[0].query).toBe("Acme directeur marketing");
});

test("an unverified or homonymous company is skipped without a broad people search", async () => {
  const { calls, result } = await executeAccountFirst(
    false,
    "https://other-acme.fr"
  );
  expect(calls.some((call) => call.name.includes("searchPeople"))).toBe(false);
  expect(result.peopleQueryStats).toMatchObject([
    {
      query: "Acme directeur marketing",
      success: false,
      skipped: true,
      error: expect.stringContaining("Skipped"),
    },
  ]);
  expect(result.success).toBe(true);
});

test("a provider outage stays a retryable failure rather than a consumed identity skip", async () => {
  const { calls, result } = await executeAccountFirst(
    false,
    "https://acme.fr",
    true
  );
  expect(calls.some((call) => call.name.includes("searchPeople"))).toBe(false);
  expect(result.success).toBe(false);
  expect(result.peopleQueryStats).toMatchObject([
    {
      success: false,
      skipped: false,
      error: expect.stringContaining("temporarily unavailable"),
    },
  ]);
  expect(result.postQueryStats).toMatchObject([{ success: true }]);
});

test("a people provider failure preserves the completed post-search result", async () => {
  const { result } = await executeAccountFirst(true);
  expect(result.success).toBe(false);
  expect(result.postQueryStats).toMatchObject([
    { query: "refonte site", success: true },
  ]);
  expect(result.peopleQueryStats).toMatchObject([
    { query: "Acme directeur marketing", success: false },
  ]);
  expect(result.error).toContain("People provider unavailable");
});
