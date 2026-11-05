import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { robustGenerateObject } from "./ai";
import {
  qualifyProspectCore,
  QualificationEvaluationError,
  type QualificationCoreParams,
} from "./qualificationCore";
import { prepareQualificationCandidates } from "./qualificationEvidenceCore";
import type { WorkspaceTargetingSpec } from "./targetingSpecCore";

vi.mock("./ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai")>()),
  robustGenerateObject: vi.fn(),
}));

const problemQuote = "Our product category pages still have broken navigation.";
const affectedPageQuote = "product category pages";
const remedy =
  "Repair the category navigation and validate the affected links.";
const text = problemQuote + " We have not repaired it yet.";
const spec: WorkspaceTargetingSpec = {
  version: 1,
  summary: "Find companies with unresolved commercial-page work",
  criteria: [
    {
      id: "need",
      label: "Unresolved work",
      description: "Actual remaining work",
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

type Options = {
  kind?:
    | "social_content"
    | "employer_event"
    | "profile"
    | "observed_site_problem";
  date?: string | null;
  httpStatus?: number;
  content?: string;
  verifiedEmployer?: boolean;
  supported?: boolean;
  attributedToEmployer?: boolean;
  verdict?: "matched" | "partial";
  status?: "unresolved" | "absent_or_resolved" | "unknown";
  problemQuote?: string;
  affectedPageQuote?: string;
  remedy?: string;
  assessmentCandidate?: string;
  criterionCandidate?: string;
  decisionCandidate?: string;
  optIn?: boolean;
};

function fixture(options: Options = {}) {
  const kind = options.kind ?? "social_content";
  const isSite = kind === "observed_site_problem";
  const siteProblemQuote = `Observed HTTP ${options.httpStatus ?? 404}, confirmed by two GET requests.`;
  const content =
    options.content ??
    (isSite
      ? `Official page: https://courses.example/catalogue\nLinked commercial or documentation URL: https://courses.example/missing\nLink label: Product catalogue\n${siteProblemQuote}\nObserved at: ${options.date ?? "2026-11-04T12:00:00Z"}`
      : text);
  const date =
    options.date === null
      ? undefined
      : (options.date ?? "2026-11-04T12:00:00Z");
  const employerEvidence = {
    companyId: "42",
    personUrn: "ACo123",
    relationshipSourceUrl: "https://www.linkedin.com/in/operator",
    company: { name: "Courses", website: "https://courses.example" },
    events: [
      {
        companyId: "42",
        url: "https://courses.example/news",
        finalUrl: "https://courses.example/news",
        publishedAt: date,
        text: content,
      },
    ],
  };
  if (isSite)
    Object.assign(employerEvidence, {
      events: [],
      siteProblems: [
        {
          evidenceKind: "observed_site_problem",
          companyId: "42",
          url: "https://courses.example/catalogue",
          finalUrl: "https://courses.example/catalogue",
          targetUrl: "https://courses.example/missing",
          anchorText: "Product catalogue",
          httpStatus: options.httpStatus ?? 404,
          observedAt: date,
          text: content,
        },
      ],
    });
  const isCompany = kind === "employer_event" || isSite;
  const params: QualificationCoreParams = {
    routing: "onboarding",
    platform: isCompany ? "linkedin" : "twitter",
    profileData: isCompany
      ? {
          urn: "ACo123",
          url: "https://www.linkedin.com/in/operator",
          employerEvidence,
        }
      : { id_str: "42" },
    ...(isCompany && options.verifiedEmployer !== false
      ? { employerEvidence }
      : {}),
    ...(kind === "profile"
      ? {
          profileEvidence: {
            url: "https://x.com/operator",
            authorId: "42",
            text: content,
          },
        }
      : {}),
    evidencePosts:
      kind === "social_content"
        ? [
            {
              id_str: "123",
              url: "https://x.com/operator/status/123",
              full_text: content,
              user: { id_str: "42" },
              created_at: date,
            },
          ]
        : [],
    targetingSpec: {
      ...spec,
      criteria: spec.criteria.map((c) =>
        options.optIn === false
          ? { ...c, requiresProblemEvidence: undefined }
          : c
      ),
    },
    discoveryQueries: [],
    totalKeywords: 1,
    icpDescription: spec.summary,
  };
  const candidate = prepareQualificationCandidates(params).find(
    (c) => c.evidenceKind === kind
  );
  const candidateId = candidate?.candidateId ?? "unverified-employer-event";
  const object = {
    goalAssessment: {
      objective: spec.summary,
      rationale: "No contradictory evidence",
      verdict: "unknown",
      candidateId: "",
      conflictingQuote: "",
    },
    criterionResults: [
      {
        criterionId: "need",
        verdict: options.verdict ?? "matched",
        confidence: 1,
        rationale: "Classifier claims work exists",
        candidateIds: [options.criterionCandidate ?? candidateId],
        employerEventSupport: "operational_activity",
      },
    ],
    evidenceDecisions: [
      {
        candidateId: options.decisionCandidate ?? candidateId,
        supportsQualification: options.supported ?? true,
        supportingQuote: content,
        attributedToEmployer:
          options.attributedToEmployer ?? kind === "employer_event",
      },
    ],
    problemEvidence: {
      status: options.status ?? "unresolved",
      candidateId: options.assessmentCandidate ?? candidateId,
      problemQuote:
        options.problemQuote ?? (isSite ? siteProblemQuote : problemQuote),
      affectedPageQuote:
        options.affectedPageQuote ??
        (isSite ? "https://courses.example/missing" : affectedPageQuote),
      remedy: options.remedy ?? remedy,
    },
    reasoning: "Relevant remaining work, subject to evidence verification.",
    isLikelyBot: false,
    botFlags: [],
  };
  vi.mocked(robustGenerateObject).mockResolvedValue({ object } as Awaited<
    ReturnType<typeof robustGenerateObject>
  >);
  return { params, candidate, object };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("opt-in unresolved problem evidence", () => {
  test.each(["social_content", "employer_event"] as const)(
    "accepts verified dated %s and preserves its evidence",
    async (kind) => {
      const { params, candidate } = fixture({ kind });
      const result = await qualifyProspectCore(params);
      expect(result.qualified, JSON.stringify(result)).toBe(true);
      expect(result.criterionResults[0]).toMatchObject({
        verdict: "matched",
        sourceIds: [candidate!.sourceId],
        problemEvidence: {
          sourceId: candidate!.sourceId,
          problemQuote,
          affectedPageQuote,
          remedy,
        },
      });
      expect(
        result.qualificationSources.some(
          (s) => s.sourceId === candidate!.sourceId
        )
      ).toBe(true);
    }
  );

  test.each([
    [
      "generic award",
      {
        content: "Our product category pages won an industry award.",
        status: "absent_or_resolved",
        problemQuote: "won an industry award",
      },
    ],
    [
      "completed redesign",
      {
        content:
          "Our product category pages navigation is repaired and the redesign is complete.",
        status: "absent_or_resolved",
        problemQuote: "the redesign is complete",
      },
    ],
    ["unknown work", { status: "unknown" }],
    ["missing assessment source", { assessmentCandidate: "missing" }],
    ["different criterion source", { criterionCandidate: "missing" }],
    ["different evidence decision", { decisionCandidate: "missing" }],
    ["unsupported evidence", { supported: false }],
    ["invented problem quote", { problemQuote: "Our conversion is falling." }],
    ["invented page phrase", { affectedPageQuote: "pricing pages" }],
    ["empty remedy", { remedy: "" }],
    ["future social date", { date: "2026-11-06T12:00:00Z" }],
    ["old social date", { date: "2026-08-01T12:00:00Z" }],
    ["undated social source", { date: null }],
    ["profile only", { kind: "profile" }],
    [
      "unverified employer payload",
      { kind: "employer_event", verifiedEmployer: false },
    ],
    [
      "wrong employer attribution",
      { kind: "employer_event", attributedToEmployer: false },
    ],
    [
      "future employer date",
      { kind: "employer_event", date: "2026-11-06T12:00:00Z" },
    ],
    ["undated employer source", { kind: "employer_event", date: null }],
  ] satisfies Array<[string, Options]>)(
    "rejects %s even when the criterion claims matched",
    async (_name, options) => {
      const { params } = fixture(options);
      const result = await qualifyProspectCore(params);
      expect(result.qualified).toBe(false);
      expect(result.criterionResults[0].verdict).not.toBe("matched");
      expect(result.criterionResults[0].problemEvidence).toBeUndefined();
    }
  );

  test("partial remains ineligible even with a valid primary-source proof", async () => {
    const { params } = fixture({ verdict: "partial" });
    const result = await qualifyProspectCore(params);
    expect(result.qualified).toBe(false);
    expect(result.criterionResults[0].problemEvidence).toBeUndefined();
  });

  test("workspaces without the opt-in keep ordinary mandatory intent matching", async () => {
    const { params } = fixture({
      optIn: false,
      status: "absent_or_resolved",
      remedy: "",
    });
    const result = await qualifyProspectCore(params);
    expect(result.qualified).toBe(true);
    expect(result.criterionResults[0].verdict).toBe("matched");
    expect(result.criterionResults[0].problemEvidence).toBeUndefined();
    expect(
      vi.mocked(robustGenerateObject).mock.calls[0][0].prompt
    ).not.toContain("For the marked required need");
  });
});

describe("independent site observations", () => {
  test("accepts a recent two-GET observation only as an unresolved need", async () => {
    const { params, candidate } = fixture({ kind: "observed_site_problem" });
    expect(candidate).toMatchObject({
      authorId: "observer:reacherx",
      sourceUrl: "https://courses.example/catalogue",
      evidenceUrl: "https://courses.example/missing",
      observedAt: "2026-11-04T12:00:00Z",
    });
    expect(candidate?.publishedAt).toBeUndefined();
    const result = await qualifyProspectCore(params);
    expect(result.qualified, JSON.stringify(result)).toBe(true);
    expect(result.criterionResults[0]).toMatchObject({
      verdict: "matched",
      problemEvidence: { sourceId: candidate!.sourceId },
    });
  });
  test.each([
    ["15-day-old observation", { date: "2026-10-21T12:00:00Z" }],
    ["non-error HTTP response", { httpStatus: 200 }],
    [
      "modified observation quote",
      { problemQuote: "Observed HTTP 404, confirmed by three GET requests." },
    ],
  ] satisfies Array<[string, Options]>)(
    "rejects %s",
    async (_name, options) => {
      const { params } = fixture({ ...options, kind: "observed_site_problem" });
      expect((await qualifyProspectCore(params)).qualified).toBe(false);
    }
  );
  test("an observed defect cannot establish a required personal role", async () => {
    const { params, candidate, object } = fixture({
      kind: "observed_site_problem",
    });
    params.targetingSpec = {
      ...params.targetingSpec,
      criteria: [
        ...params.targetingSpec.criteria,
        {
          id: "role",
          label: "Current role",
          description: "Works in marketing",
          kind: "required",
          category: "profile_fit",
          evidence: "profile",
          terms: [],
          weight: 1,
        },
      ],
    };
    object.criterionResults.push({
      ...object.criterionResults[0],
      criterionId: "role",
      candidateIds: [candidate!.candidateId],
    });
    const result = await qualifyProspectCore(params);
    expect(result.qualified).toBe(false);
    expect(
      result.criterionResults.find((c) => c.criterionId === "need")?.verdict
    ).toBe("matched");
    expect(
      result.criterionResults.find((c) => c.criterionId === "role")?.verdict
    ).not.toBe("matched");
  });
});

describe("temporarily unavailable required problem sources", () => {
  test.each([
    {
      name: "unproven need retries acquisition",
      unavailable: true,
      proof: false,
      bot: false,
      retry: true,
      qualified: false,
    },
    {
      name: "valid proof survives a different source outage",
      unavailable: true,
      proof: true,
      bot: false,
      retry: false,
      qualified: true,
    },
    {
      name: "missing proof without outage is a real negative",
      unavailable: false,
      proof: false,
      bot: false,
      retry: false,
      qualified: false,
    },
    {
      name: "an independent bot rejection survives the outage",
      unavailable: true,
      proof: false,
      bot: true,
      retry: false,
      qualified: false,
    },
  ])("$name", async ({ unavailable, proof, bot, retry, qualified }) => {
    const { params, object } = fixture({
      status: proof ? "unresolved" : "unknown",
    });
    params.problemSourceUnavailable = unavailable;
    object.isLikelyBot = bot;
    const evaluation = qualifyProspectCore(params);
    if (retry) {
      await expect(evaluation).rejects.toThrow(/\[QualificationEvidence\]/);
      await expect(evaluation).rejects.not.toBeInstanceOf(
        QualificationEvaluationError
      );
    } else {
      expect((await evaluation).qualified).toBe(qualified);
    }
  });
});
