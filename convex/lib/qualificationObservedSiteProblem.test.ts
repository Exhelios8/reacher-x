import { expect, test } from "vitest";
import {
  buildVerifiedQualificationSources,
  hasVerifiedGoalConflict,
  prepareQualificationCandidates,
} from "./qualificationEvidenceCore";

const now = Date.parse("2026-11-06T12:00:00Z");
const observation = {
  evidenceKind: "observed_site_problem",
  companyId: "42",
  url: "https://courses.example/news/product",
  finalUrl: "https://courses.example/news/product",
  targetUrl: "https://courses.example/docs/product",
  anchorText: "Product documentation",
  httpStatus: 404,
  observedAt: "2026-11-06T11:00:00Z",
  text: "Official page: https://courses.example/news/product\nLinked commercial or documentation URL: https://courses.example/docs/product\nLink label: Product documentation\nObserved HTTP 404, confirmed by two GET requests.\nObserved at: 2026-11-06T11:00:00Z",
};
const profileData = {
  urn: "ACo123",
  url: "https://www.linkedin.com/in/educator",
};
const employerEvidence = {
  companyId: "42",
  personUrn: "ACo123",
  relationshipSourceUrl: profileData.url,
  company: { name: "Courses", website: "https://courses.example" },
  siteProblems: [observation],
};
function candidatesFor(siteProblems = [observation]) {
  return prepareQualificationCandidates({
    platform: "linkedin",
    profileData,
    employerEvidence: { ...employerEvidence, siteProblems },
    evidencePosts: [],
    discoveryQueries: [],
    now,
  });
}

test("live site observations keep observer attribution, source and target URLs and observation time", () => {
  const candidates = candidatesFor();
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    evidenceKind: "observed_site_problem",
    contentType: "observed_site_problem",
    authorId: "observer:reacherx",
    sourceUrl: observation.url,
    evidenceUrl: observation.targetUrl,
    observedAt: observation.observedAt,
    companyId: "42",
    httpStatus: 404,
  });
  expect(candidates[0]).not.toHaveProperty("publishedAt");
  expect(candidates[0].sourceId).toMatch(/^site_problem:42:/);
  const decision = {
    candidateId: candidates[0].candidateId,
    supportsQualification: true,
    supportingQuote: "Observed HTTP 404, confirmed by two GET requests.",
  };
  for (const attributedToEmployer of [true, undefined]) {
    expect(
      buildVerifiedQualificationSources({
        candidates,
        decisions: [{ ...decision, attributedToEmployer }],
        verifiedAt: now,
      })
    ).toEqual([]);
  }
  expect(
    buildVerifiedQualificationSources({
      candidates,
      decisions: [{ ...decision, attributedToEmployer: false }],
      verifiedAt: now,
    })[0]
  ).toMatchObject({
    evidenceKind: "observed_site_problem",
    authorId: "observer:reacherx",
    sourceUrl: observation.url,
    evidenceUrl: observation.targetUrl,
    observedAt: observation.observedAt,
    httpStatus: 404,
  });
  expect(
    buildVerifiedQualificationSources({
      candidates,
      decisions: [
        {
          ...decision,
          attributedToEmployer: false,
          supportingQuote: "Invented purchase intent",
        },
      ],
      verifiedAt: now,
    })
  ).toEqual([]);
  expect(
    hasVerifiedGoalConflict(candidates, {
      verdict: "contradicted",
      candidateId: decision.candidateId,
      conflictingQuote: decision.supportingQuote,
    })
  ).toBe(false);
});

test("raw imported observations are not trusted and only one verified observation is retained", () => {
  expect(
    prepareQualificationCandidates({
      platform: "linkedin",
      profileData: { ...profileData, employerEvidence },
      evidencePosts: [],
      discoveryQueries: [],
      now,
    })
  ).toEqual([]);
  expect(
    candidatesFor([
      observation,
      { ...observation, targetUrl: `${observation.targetUrl}-2` },
    ])
  ).toHaveLength(1);
});

test.each([
  { evidenceKind: "employer_event" },
  { observedAt: "2026-10-20T11:00:00Z" },
  { observedAt: "2026-11-07T11:00:00Z" },
  { observedAt: "" },
  { httpStatus: 403 },
  { httpStatus: 429 },
  { companyId: "99" },
  { url: "https://unrelated.example/news/product" },
  { finalUrl: "https://courses.example/new/product" },
  { targetUrl: "https://unrelated.example/docs/product" },
  { anchorText: "" },
])(
  "rejects stale, unverified, unrelated or mismatched observations: %j",
  (override) => {
    expect(candidatesFor([{ ...observation, ...override }])).toEqual([]);
  }
);
