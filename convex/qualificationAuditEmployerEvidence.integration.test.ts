/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { robustGenerateObject } from "./lib/ai";
import { requestLinkdApiData } from "./integrations/linkedin/linkdapiClient";
import { getLearningTargetingFingerprint } from "./lib/learningTargetingHelpers";
import { prepareQualificationCandidates } from "./lib/qualificationEvidenceCore";
import type { WorkspaceTargetingSpec } from "./lib/targetingSpecCore";

vi.mock("./lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/ai")>()),
  robustGenerateObject: vi.fn(),
}));
vi.mock("./integrations/linkedin/linkdapiClient", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./integrations/linkedin/linkdapiClient")
  >()),
  requestLinkdApiData: vi.fn(),
}));
const modules = import.meta.glob("./**/*.ts");
const problemQuote = "Our product category pages still have broken navigation.";
const affectedPageQuote = "product category pages";
const spec: WorkspaceTargetingSpec = {
  version: 1,
  summary: "Find unresolved commercial-page work",
  criteria: [
    {
      id: "need",
      label: "Unresolved work",
      description: "Actual unresolved work on commercial pages",
      kind: "required",
      category: "intent",
      evidence: "either",
      weight: 5,
      terms: [],
      requiresProblemEvidence: true,
    },
  ],
  searchHints: {
    entities: [],
    activityPhrases: [],
    roleTitles: [],
    locations: [],
    industries: [],
    companyNames: [],
    languageCodes: [],
    exclusionTerms: [],
  },
};
type Scenario =
  | "valid"
  | "old fingerprint"
  | "stale cache"
  | "wrong person"
  | "wrong source host"
  | "opt-out"
  | "unmarked workspace"
  | "required personal activity";

beforeEach(() => {
  vi.mocked(requestLinkdApiData).mockRejectedValue(
    new Error("Provider unavailable during offline test")
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    })
  );
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture(
  scenario: Scenario = "valid",
  discoverySource: "search_people" | "search_post" = "search_people"
) {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      workosUserId: "audit-owner",
      email: "audit@example.test",
    });
    const targetingSpec = {
      ...spec,
      criteria:
        scenario === "unmarked workspace"
          ? spec.criteria.map(
              ({ requiresProblemEvidence: _marker, ...criterion }) => criterion
            )
          : scenario === "required personal activity"
            ? [
                ...spec.criteria,
                {
                  ...spec.criteria[0],
                  id: "personal",
                  requiresProblemEvidence: undefined,
                  evidence: "activity" as const,
                },
              ]
            : spec.criteria,
    };
    const workspaceId = await ctx.db.insert("workspaces", {
      userId,
      name: "Audit",
      description: spec.summary,
      targetingSpec,
      icps: [],
      isDefault: true,
      updatedAt: now,
    });
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) throw new Error("Missing fixture workspace");
    const employerEvidence = {
      companyId: "42",
      personUrn: "ACo123",
      relationshipSourceUrl: "https://www.linkedin.com/in/operator",
      company: { name: "Courses", website: "https://courses.example" },
      events: [
        {
          companyId: "42",
          url: "https://courses.example/news/open-work",
          finalUrl:
            scenario === "wrong source host"
              ? "https://unrelated.example/news"
              : "https://courses.example/news/open-work",
          publishedAt: new Date(now - 86_400_000).toISOString(),
          text: problemQuote + " It has not been repaired yet.",
        },
      ],
    };
    const profile = {
      urn: "ACo123",
      username: "operator",
      url: "https://www.linkedin.com/in/operator",
      headline: "Marketing lead at Courses",
      employerEvidence,
    };
    const candidate = prepareQualificationCandidates({
      platform: "linkedin",
      evidencePosts: [],
      discoveryQueries: [],
      profileData: profile,
      employerEvidence,
      now,
    }).find((candidate) => candidate.evidenceKind === "employer_event");
    const candidateId = candidate?.candidateId ?? "invalid-source";
    vi.mocked(robustGenerateObject).mockResolvedValue({
      object: {
        goalAssessment: {
          objective: spec.summary,
          rationale: "No conflict",
          verdict: "unknown",
          candidateId: "",
          conflictingQuote: "",
        },
        criterionResults: [
          {
            criterionId: "need",
            verdict: "matched",
            confidence: 1,
            rationale: "Specific unresolved work",
            candidateIds: [candidateId],
            employerEventSupport: "operational_activity",
          },
        ],
        evidenceDecisions: [
          {
            candidateId,
            supportsQualification: true,
            supportingQuote: problemQuote,
            attributedToEmployer: true,
          },
        ],
        problemEvidence: {
          status: "unresolved",
          candidateId,
          problemQuote,
          affectedPageQuote,
          remedy: "Repair category navigation and validate affected links.",
        },
        reasoning: "Remaining work is quoted from the current employer.",
        isLikelyBot: false,
        botFlags: [],
      },
    } as Awaited<ReturnType<typeof robustGenerateObject>>);
    const prospectId = await ctx.db.insert("prospects", {
      workspaceId,
      userId,
      platform: "linkedin",
      discoverySource,
      origin: "workspace_discovery",
      externalId: "person-1",
      linkedinUserUrn: "ACo123",
      data: { urn: "ACo123", username: "operator", url: profile.url },
      socialProfiles: {
        linkedin: { urn: "ACo123", username: "operator", url: profile.url },
      },
      status: "new",
      qualificationStatus: "qualified",
      qualificationScore: 85,
      evidencePosts: [],
      qualificationProfileData: {
        ...profile,
        urn: scenario === "wrong person" ? "another-person" : profile.urn,
        qualificationContextVersion: 4,
        qualificationTargetingFingerprint:
          scenario === "old fingerprint"
            ? "previous-target"
            : getLearningTargetingFingerprint(workspace),
      },
      qualificationEvidenceFetchedAt:
        scenario === "stale cache" ? now - 2 * 86_400_000 : now,
      updatedAt: now,
    });
    return { workspaceId, prospectId };
  });
  vi.stubEnv(
    "ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS",
    scenario === "opt-out" ? "" : ids.workspaceId
  );
  const runId = await t.mutation(
    internal.workflows.qualificationAudit.createRunInternal,
    { workspaceId: ids.workspaceId, snapshotAt: now, totalProspects: 1 }
  );
  await t.action(internal.workflows.qualificationAudit.processBatchInternal, {
    runId,
    prospectIds: [ids.prospectId],
  });
  const item = await t.run((ctx) =>
    ctx.db
      .query("qualificationAuditItems")
      .withIndex("by_run_and_prospect", (q) =>
        q.eq("runId", runId).eq("prospectId", ids.prospectId)
      )
      .unique()
  );
  return { item, t, runId, ...ids };
}

test.each(["search_people", "search_post"] as const)(
  "native audit evaluates a verified employer source without personal posts: %s",
  async (discoverySource) => {
    const { item, t, prospectId } = await fixture("valid", discoverySource);
    expect(item?.outcome, JSON.stringify(item)).toBe("kept_qualified");
    expect(item?.verifiedSourceCount).toBe(1);
    expect(item?.qualificationSources[0].evidenceKind).toBe("employer_event");
    expect(
      item?.qualificationCriterionResults?.[0].problemEvidence?.problemQuote
    ).toBe(problemQuote);
    expect(requestLinkdApiData).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const prospect = await t.run((ctx) => ctx.db.get(prospectId));
    expect(prospect?.qualificationScore).toBe(85);
    expect(prospect?.evidencePosts).toEqual([]);
  },
  30_000
);

test.each(["old fingerprint", "stale cache", "wrong person"] as const)(
  "untrusted acquisition refresh fails as an audit error, not a negative need verdict: %s",
  async (scenario) => {
    const { item } = await fixture(scenario);
    expect(item?.outcome).toBe("error");
    expect(item?.failure?.stage).toBe("evidence_fetch");
    expect(item?.failure?.code).toBe("qualification_evidence_fetch_failed");
    expect(requestLinkdApiData).toHaveBeenCalledOnce();
    expect(robustGenerateObject).not.toHaveBeenCalled();
  },
  30_000
);

test("an event on a different host cannot support the problem", async () => {
  const { item } = await fixture("wrong source host");
  expect(item?.outcome).toBe("would_disqualify");
  expect(item?.verifiedSourceCount).toBe(0);
}, 30_000);

test.each([
  "opt-out",
  "unmarked workspace",
  "required personal activity",
] as const)(
  "legacy personal evidence prefetch remains unchanged: %s",
  async (scenario) => {
    const { item } = await fixture(scenario);
    expect(item?.outcome).toBe("error");
    expect(item?.failure?.code).toBe("missing_search_keywords");
    expect(robustGenerateObject).not.toHaveBeenCalled();
  },
  30_000
);

test("an older audit item without failure accepts structured error details on retry", async () => {
  const { t, item, runId, prospectId } = await fixture("opt-out");
  if (!item) throw new Error("Missing audit item");
  await t.run((ctx) => ctx.db.patch(item._id, { failure: undefined }));
  await t.action(internal.workflows.qualificationAudit.processBatchInternal, {
    runId,
    prospectIds: [prospectId],
  });
  const summary = await t.query(
    internal.workflows.qualificationAudit.getDryRunSummaryInternal,
    { runId }
  );
  if (!summary) throw new Error("Expected the completed audit summary");
  expect(summary.run.processedProspects).toBe(1);
  expect(summary.run.errored).toBe(1);
  expect(summary.errorsSample).toHaveLength(1);
  expect(summary.errorsSample[0]?.failure?.code).toBe(
    "missing_search_keywords"
  );
  const rows = await t.run((ctx) =>
    ctx.db
      .query("qualificationAuditItems")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .collect()
  );
  expect(rows).toHaveLength(1);
}, 30_000);
