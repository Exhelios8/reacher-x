import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  qualifyProspectCore,
  type QualificationCoreParams,
} from "./qualificationCore";
import { evaluateQualificationWithExternalArticles } from "./qualificationEvaluationCore";
import { prepareQualificationCandidates } from "./qualificationEvidenceCore";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { robustGenerateObject } from "./ai";
import type { PeerRouteProposal } from "./peerQualificationCore";
import type { WorkspaceTargetingSpec } from "./targetingSpecCore";

vi.mock("./ai", async (original) => ({
  ...(await original<typeof import("./ai")>()),
  robustGenerateObject: vi.fn(),
}));
const now = "2026-11-06T12:00:00Z";
const profileUrl = "https://www.linkedin.com/in/marie-example";
const siteUrl = "https://acme.example/solutions";
const profile = { urn: "ACo123", url: profileUrl };
const text = "Directrice marketing chez Acme.";
const quote = "Gestion documentaire pour les directions juridiques";
const page = {
  url: siteUrl,
  finalUrl: siteUrl,
  observedAt: now,
  text: quote,
  httpStatus: 200,
  provenance: "native_http",
};
const employer = {
  companyId: "42",
  personUrn: profile.urn,
  relationshipSourceUrl: profileUrl,
  sourceUrl: "https://www.linkedin.com/company/acme",
  fetchedAt: now,
  company: {
    name: "Acme",
    website: "https://acme.example",
    description: quote,
  },
  reviewedPages: [page],
};
const spec: WorkspaceTargetingSpec = {
  version: 1,
  discoveryMode: "peer_or_site_audit",
  summary: "Business customers in France.",
  criteria: [
    "france",
    "commercial_site",
    "role",
    "peer_fit",
    "need",
    "recency",
    "suppression",
  ].map((id) => ({
    id,
    label: id,
    description: id,
    terms: [],
    weight: 1,
    category:
      id === "need" ? "intent" : id === "recency" ? "timing" : "profile_fit",
    evidence: id === "recency" ? "activity" : "profile",
    kind:
      id === "suppression"
        ? "exclusion"
        : ["france", "commercial_site", "role"].includes(id)
          ? "required"
          : "preferred",
  })),
  searchHints: {
    entities: [],
    locations: [],
    industries: [],
    roleTitles: [],
    companyNames: [],
    languageCodes: [],
    exclusionTerms: [],
    excludedCompanyDomains: ["client.example"],
  },
};
const proposal: PeerRouteProposal = {
  route: "peer",
  sourceUrl: siteUrl,
  sourceQuote: quote,
  rationale: "Same legal buyers and document-management workflow.",
  offerOrRemedy: "Review the legal product pages and their documentation.",
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function evaluate(
  opts: {
    route?: PeerRouteProposal["route"];
    peer?: boolean;
    reference?: boolean;
    unverified?: boolean;
    stale?: boolean;
    otherQuote?: boolean;
    exclude?: boolean;
    noRole?: boolean;
    uncitedRole?: boolean;
    legacy?: boolean;
    outage?: boolean;
    goalConflict?: boolean;
    measured?: boolean;
    nativeContext?: ActionCtx;
    xOnly?: boolean;
  } = {}
) {
  const route = opts.route ?? "peer";
  const candidateId = `profile:linkedin:${profile.urn}`;
  const measuredQuote = "Observed HTTP 404, confirmed by two GET requests.";
  const measuredText = `Official page: ${siteUrl}\nLinked commercial or documentation URL: https://acme.example/docs/missing\nLink label: Documentation API\n${measuredQuote}\nObserved at: ${now}`;
  const enrichedEmployer = {
    ...employer,
    siteProblems: opts.measured
      ? [
          {
            evidenceKind: "observed_site_problem",
            companyId: "42",
            url: siteUrl,
            finalUrl: siteUrl,
            targetUrl: "https://acme.example/docs/missing",
            anchorText: "Documentation API",
            httpStatus: 404,
            observedAt: now,
            text: measuredText,
          },
        ]
      : [],
  };
  const measuredCandidate =
    opts.measured &&
    prepareQualificationCandidates({
      platform: "linkedin",
      profileData: profile,
      employerEvidence: enrichedEmployer,
      evidencePosts: [],
      discoveryQueries: [],
    }).find((c) => c.evidenceKind === "observed_site_problem");
  const verdict = (id: string) =>
    id === "role" && opts.noRole
      ? "unknown"
      : id === "suppression"
        ? opts.exclude
          ? "matched"
          : "not_matched"
        : ["need", "recency"].includes(id)
          ? "unknown"
          : id === "peer_fit" && opts.peer === false
            ? "not_matched"
            : "matched";
  vi.mocked(robustGenerateObject).mockResolvedValue({
    object: {
      goalAssessment: {
        objective: "Sales",
        rationale: "",
        verdict: opts.goalConflict ? "contradicted" : "unknown",
        candidateId: opts.goalConflict ? candidateId : "",
        conflictingQuote: opts.goalConflict ? text : "",
      },
      isLikelyBot: false,
      botFlags: [],
      reasoning: "Evaluate the evidence available.",
      routeAssessment: {
        ...proposal,
        route,
        sourceQuote: opts.otherQuote
          ? "Invented quote"
          : opts.measured
            ? measuredQuote
            : quote,
      },
      evidenceDecisions: [
        ...(measuredCandidate
          ? [
              {
                candidateId: measuredCandidate.candidateId,
                supportsQualification: true,
                supportingQuote: measuredQuote,
                attributedToEmployer: false,
              },
            ]
          : []),
        {
          candidateId,
          supportsQualification: true,
          supportingQuote: text,
          attributedToEmployer: false,
        },
      ],
      criterionResults: spec.criteria.map((c) => ({
        criterionId: c.id,
        verdict: verdict(c.id),
        confidence: 1,
        rationale: "Test fixture",
        candidateIds: c.id === "role" && !opts.uncitedRole ? [candidateId] : [],
        employerEventSupport: "none",
      })),
    },
    model: "test",
    usage: {},
  } as Awaited<ReturnType<typeof robustGenerateObject>>);
  const params: QualificationCoreParams = {
    platform: opts.xOnly ? "twitter" : "linkedin",
    profileData: profile,
    profileEvidence: { url: profileUrl, authorId: profile.urn, text },
    evidencePosts: [],
    discoveryQueries: [],
    totalKeywords: 0,
    routing: "onboarding",
    problemSourceUnavailable: opts.outage,
    targetingSpec: {
      ...spec,
      discoveryMode: opts.legacy ? undefined : spec.discoveryMode,
    },
    employerEvidence: opts.unverified
      ? undefined
      : {
          ...enrichedEmployer,
          company: {
            ...employer.company,
            website: opts.reference
              ? "https://sub.client.example"
              : employer.company.website,
          },
          reviewedPages: [
            { ...page, observedAt: opts.stale ? "2024-01-01" : now },
          ],
          siteProblemFetchRetryable: opts.outage,
        },
  };
  if (opts.nativeContext)
    return evaluateQualificationWithExternalArticles(opts.nativeContext, {
      ...params,
      employerEvidence: undefined,
      profileEvidence: undefined,
      profileData: {},
      workspaceId: "workspace" as Id<"workspaces">,
      prospectId: "prospect" as Id<"prospects">,
    });
  return qualifyProspectCore(params);
}

test("actual qualification entry collects a French employer's healthy offer page and qualifies a profile with no social posts", async () => {
  vi.stubEnv("ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS", "workspace");
  const rawProspect = {
    _id: "prospect",
    workspaceId: "workspace",
    platform: "linkedin",
    discoverySource: "search_people",
    qualificationStatus: "pending",
    linkedinUsername: "marie-example",
    linkedinUserUrn: profile.urn,
    data: { username: "marie-example", urn: profile.urn },
    evidencePosts: [],
  };
  const runQuery = vi
    .fn()
    .mockResolvedValueOnce(rawProspect)
    .mockResolvedValue({
      description: spec.summary,
      targetingSpec: spec,
      icps: [],
    });
  const runAction = vi
    .fn()
    .mockResolvedValueOnce({
      success: true,
      profile: {
        ...profile,
        id: 123,
        username: "marie-example",
        headline: text,
        summary: text,
        currentPositions: [{ company: { id: "42" } }],
        position: [
          {
            title: text,
            companyName: "Acme",
            companyId: "42",
            end: { year: 0 },
          },
        ],
      },
    })
    .mockResolvedValueOnce({
      success: true,
      company: {
        id: "42",
        name: "Acme",
        linkedinUrl: employer.sourceUrl,
        website: "https://acme.example",
        description: quote,
        headquarter: { countryCode: "FR" },
      },
    })
    .mockResolvedValueOnce({ posts: [] });
  const fetchStub = vi.fn(async (url: string) => {
    const html = `<html><title>Acme</title><main><h1>${quote}</h1><p>Services documentaires proposés par Acme aux professionnels français.</p><a href="/solutions">Solutions Acme</a></main></html>`;
    const response = new Response(html, {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(response, "url", { value: new URL(url).href });
    return response;
  });
  vi.stubGlobal("fetch", fetchStub);
  const runMutation = vi.fn().mockResolvedValue(null);
  const result = await evaluate({
    nativeContext: { runQuery, runAction, runMutation } as unknown as ActionCtx,
  });
  expect(result).toMatchObject({
    qualified: true,
    qualificationVerification: {
      routeAssessment: {
        route: "peer",
        sourceUrl: siteUrl,
        sourceQuote: quote,
        needStatus: "unknown",
      },
    },
  });
  expect(fetchStub.mock.calls.map((c) => new URL(c[0]).hostname)).toContain(
    "acme.example"
  );
  expect(fetchStub.mock.calls.length).toBeLessThanOrEqual(3);
  expect(runMutation).toHaveBeenCalled();
});
test("confirmed current-site problem qualifies a non-peer and X-only records stay research-only", async () => {
  const verified = await evaluate({
    route: "observed_problem",
    measured: true,
    peer: false,
  });
  expect(verified).toMatchObject({
    qualified: true,
    qualificationVerification: {
      routeAssessment: { route: "observed_problem", needStatus: "confirmed" },
    },
  });
  expect(await evaluate({ xOnly: true })).toMatchObject({
    qualified: false,
    qualificationVerification: {
      routeAssessment: { route: "none", needsContactVerification: true },
    },
  });
});
test("verified peer can receive a manual pitch with zero posts, unknown need and score below 70", async () => {
  const result = await evaluate({ outage: true });
  expect(result.qualified).toBe(true);
  expect(result.score).toBeLessThan(70);
  expect(result.scoreBreakdown.intentStrength).toBe(0);
  expect(result.qualificationSources.map((s) => s.evidenceKind)).toEqual([
    "profile",
  ]);
  expect(result.qualificationVerification.routeAssessment).toMatchObject({
    route: "peer",
    needStatus: "unknown",
    sourceUrl: siteUrl,
    sourceQuote: quote,
  });
});
test("a site outage without a grounded route is an acquisition failure, not a missing buyer declaration", async () => {
  await expect(
    evaluate({ route: "none", peer: false, outage: true })
  ).rejects.toThrow("account's site is temporarily unavailable");
});
test.each(["testable_opportunity", "exploration"] as const)(
  "a real healthy page can support %s outside the peer group",
  async (route) => {
    const result = await evaluate({ route, peer: false });
    expect(result.qualified).toBe(true);
    expect(result.qualificationVerification.routeAssessment?.needStatus).toBe(
      route === "exploration" ? "unknown" : "hypothesis"
    );
  }
);
test.each([
  { otherQuote: true },
  { stale: true },
  { reference: true },
  { unverified: true },
  { peer: false },
  { noRole: true },
  { uncitedRole: true },
  { exclude: true },
  { goalConflict: true },
  { legacy: true },
  { route: "observed_problem" as const },
  { route: "none" as const },
])("no unsupported pitch or score override: %j", async (opts) => {
  expect((await evaluate(opts)).qualified).toBe(false);
});
