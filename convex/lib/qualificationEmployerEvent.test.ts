import { describe, expect, test } from "vitest";
import {
  buildVerifiedQualificationSources,
  hasVerifiedGoalConflict,
  prepareQualificationCandidates,
} from "./qualificationEvidenceCore";

const now = Date.parse("2026-11-05T12:00:00Z");
const event = {
  companyId: "42",
  url: "https://courses.example/news/migration",
  finalUrl: "https://www.courses.example/news/migration",
  publishedAt: "2026-11-04T10:00:00Z",
  text: "Courses is migrating its learning catalogue. No agencies for this project.",
};
const profileData = {
  urn: "ACo123",
  url: "https://www.linkedin.com/in/educator",
  employerEvidence: {
    companyId: "42",
    personUrn: "ACo123",
    relationshipSourceUrl: "https://www.linkedin.com/in/educator",
    company: { name: "Courses", website: "https://courses.example" },
    events: [event],
  },
};
function candidatesFor(
  events = [event],
  employer = profileData.employerEvidence
) {
  return prepareQualificationCandidates({
    platform: "linkedin",
    evidencePosts: [],
    profileData: { ...profileData, employerEvidence: { ...employer, events } },
    employerEvidence: { ...employer, events },
    discoveryQueries: [],
    now,
  });
}

describe("separately attributed employer event evidence", () => {
  test("raw imported employer fields never become trusted candidates", () => {
    expect(
      prepareQualificationCandidates({
        platform: "linkedin",
        evidencePosts: [],
        profileData,
        discoveryQueries: [],
        now,
      })
    ).toEqual([]);
    expect(
      candidatesFor([event], {
        ...profileData.employerEvidence,
        personUrn: "other-person",
      })
    ).toEqual([]);
  });
  test("uses a bounded stable company source identity and requires explicit attribution plus an exact quote", () => {
    const candidates = candidatesFor();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      evidenceKind: "employer_event",
      contentType: "employer_event",
      authorId: "company:42",
      employerName: "Courses",
      sourceUrl: event.url,
      evidenceUrl: event.finalUrl,
    });
    expect(candidates[0].candidateId.length).toBeLessThan(120);
    const decision = {
      candidateId: candidates[0].candidateId,
      supportsQualification: true,
      supportingQuote: "Courses is migrating its learning catalogue.",
    };
    expect(
      buildVerifiedQualificationSources({
        candidates,
        decisions: [decision],
        verifiedAt: now,
      })
    ).toEqual([]);
    expect(
      buildVerifiedQualificationSources({
        candidates,
        decisions: [{ ...decision, attributedToEmployer: true }],
        verifiedAt: now,
      })[0]
    ).toMatchObject({
      evidenceKind: "employer_event",
      supportingQuote: decision.supportingQuote,
    });
    expect(
      buildVerifiedQualificationSources({
        candidates,
        decisions: [
          {
            ...decision,
            attributedToEmployer: true,
            supportingQuote: "Invented purchase",
          },
        ],
        verifiedAt: now,
      })
    ).toEqual([]);
    expect(
      hasVerifiedGoalConflict(candidates, {
        verdict: "contradicted",
        candidateId: decision.candidateId,
        conflictingQuote: "No agencies for this project.",
      })
    ).toBe(false);
  });
  test.each([
    { url: "https://another.example/news/migration" },
    { finalUrl: "https://another.example/news/migration" },
    { finalUrl: "https://courses.example.evil.example/news" },
    { companyId: "99" },
    { publishedAt: "" },
    { publishedAt: "2026-11-06T10:00:00Z" },
    { publishedAt: "2025-11-04T10:00:00Z" },
    { text: "" },
  ])("rejects uncoupled, undated, future or stale evidence: %j", (override) => {
    expect(candidatesFor([{ ...event, ...override }])).toEqual([]);
  });
  test("requires the current person/employer relationship and deduplicates official pages", () => {
    expect(
      candidatesFor([event], {
        ...profileData.employerEvidence,
        relationshipSourceUrl: "https://www.linkedin.com/in/someone-else",
      })
    ).toEqual([]);
    expect(
      candidatesFor([
        event,
        event,
        { ...event, finalUrl: `${event.finalUrl}-2` },
        { ...event, finalUrl: `${event.finalUrl}-3` },
      ])
    ).toHaveLength(2);
  });
});
