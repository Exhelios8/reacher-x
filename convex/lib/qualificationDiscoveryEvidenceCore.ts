"use node";

import type { ActionCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getStringProperty, isRecord } from "./typeGuards";
import {
  resolveLinkedInProspectProfileIdentifiers,
  normalizeLinkedInProfileQueryUrn,
} from "../integrations/linkedin/profileIdentity";
import { getLearningTargetingFingerprint } from "./learningTargetingHelpers";
import { getCurrentUTCTimestamp } from "../../shared/lib/utils/time/timeUtils";
import { readWebPages } from "./researchCore";
import { classifyProviderFailure } from "./providerReliability";
import {
  sanitizeLinkedInProfileForWorkflow,
  sanitizeWorkflowString,
  sanitizeWorkflowValue,
} from "./workflowSafeProspect";

function companyId(value: unknown): string | undefined {
  const id =
    typeof value === "number" || typeof value === "string"
      ? String(value).trim()
      : "";
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

function getCurrentCompanyId(
  profile: Record<string, unknown>
): string | undefined {
  const current = Array.isArray(profile.currentPositions)
    ? profile.currentPositions.map((position) =>
        isRecord(position) && isRecord(position.company)
          ? companyId(position.company.id)
          : undefined
      )
    : (Array.isArray(profile.position) ? profile.position : [])
        .filter(isRecord)
        .filter((position) => {
          const endYear = isRecord(position.end)
            ? position.end.year
            : undefined;
          return endYear === 0 || (position.isCurrent === true && !endYear);
        })
        .map((position) => companyId(position.companyId));
  // Multiple current employers or an unidentified current employer are ambiguous.
  const ids = new Set(current);
  return ids.size === 1 && !ids.has(undefined) ? [...ids][0] : undefined;
}

function sameWebsiteHost(first: unknown, second: unknown): boolean {
  if (typeof first !== "string" || typeof second !== "string") return false;
  try {
    const a = new URL(first);
    const b = new URL(second);
    return (
      [a, b].every((url) => ["http:", "https:"].includes(url.protocol)) &&
      a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "")
    );
  } catch {
    return false;
  }
}

/** Bounded person/employer evidence acquisition before any LinkedIn fit verdict. */
export async function collectQualificationDiscoveryEvidence(
  ctx: ActionCtx,
  prospect: Doc<"prospects">
): Promise<{
  profileData: Record<string, unknown>;
  evidencePosts: Record<string, unknown>[];
} | null> {
  if (
    prospect.platform !== "linkedin" ||
    !["search_people", "search_post"].includes(
      prospect.discoverySource ?? ""
    ) ||
    prospect.prospectType === "organization"
  )
    return null;
  const linkedIn = isRecord(prospect.socialProfiles?.linkedin)
    ? prospect.socialProfiles.linkedin
    : undefined;
  const data = isRecord(prospect.data) ? prospect.data : {};
  const author = isRecord(data.author) ? data.author : {};
  if (
    [
      linkedIn?.url,
      data.url,
      data.linkedinUrl,
      author.url,
      author.profileUrl,
    ].some(
      (url) =>
        typeof url === "string" &&
        /^https?:\/\/(?:www\.)?linkedin\.com\/company\//i.test(url)
    )
  )
    return null;
  if (
    isRecord(prospect.qualificationProfileData) &&
    prospect.qualificationEvidenceFetchedAt &&
    prospect.qualificationProfileData.qualificationContextVersion === 2
  ) {
    return {
      profileData: prospect.qualificationProfileData,
      evidencePosts: (prospect.evidencePosts ?? []).filter(isRecord),
    };
  }
  const identifiers = resolveLinkedInProspectProfileIdentifiers(prospect);
  if (!identifiers.username && !identifiers.profileUrn)
    throw new Error(
      "[QualificationEvidence] LinkedIn profile identity unavailable"
    );
  const workspace = await ctx.runQuery(internal.workspaces.getById, {
    workspaceId: prospect.workspaceId,
  });
  if (!workspace)
    throw new Error("[QualificationEvidence] Workspace no longer exists");
  const result = await ctx.runAction(
    internal.integrations.linkedin.getProfile.getProfile,
    {
      username: identifiers.username,
      urn: identifiers.profileUrn,
      includeContactInfo: false,
    }
  );
  if (!result.success || !isRecord(result.profile))
    throw new Error(
      `[QualificationEvidence] ${result.error ?? "Profile fetch failed"}`
    );
  const profile = result.profile;
  const sameUsername =
    identifiers.username &&
    profile.username?.toLowerCase() === identifiers.username.toLowerCase();
  const sameUrn =
    identifiers.profileUrn &&
    [profile.urn, String(profile.id)].some(
      (id) => normalizeLinkedInProfileQueryUrn(id) === identifiers.profileUrn
    );
  // A stable known identity takes precedence over a mutable/reused username.
  if (identifiers.profileUrn ? !sameUrn : !sameUsername)
    throw new Error(
      "[QualificationEvidence] Provider returned a different profile"
    );
  const username =
    getStringProperty(profile, "username")?.trim() || identifiers.username;
  const urn = getStringProperty(profile, "urn")?.trim();
  if (!username || !/^[\p{L}\p{N}_-]+$/u.test(username) || !urn) {
    throw new Error(
      "[QualificationEvidence] Provider profile is missing a valid public username or URN"
    );
  }
  const profileUrl = `https://www.linkedin.com/in/${encodeURIComponent(username)}`;
  const profileData: Record<string, unknown> = sanitizeWorkflowValue({
    ...sanitizeLinkedInProfileForWorkflow(profile),
    // Refresh older caches once; they omitted employer identity and context.
    qualificationContextVersion: 2,
    // Retain actual responsibilities; the generic workflow sanitizer keeps only company names.
    position: (profile.position ?? []).slice(0, 5).map((position) => ({
      title: position.title ?? "",
      companyName: position.companyName ?? "",
      companyId: companyId(position.companyId),
      companyURL: position.companyURL,
      companyIndustry: position.companyIndustry,
      location: position.location,
      start: position.start,
      end: position.end,
      description: sanitizeWorkflowString(position.description ?? "").slice(
        0,
        4000
      ),
    })),
    url: profileUrl,
  });
  const employerId = getCurrentCompanyId(profile);
  if (employerId) {
    const employer = await ctx.runAction(
      internal.integrations.linkedin.getCompany.getCompany,
      { id: employerId }
    );
    if (!employer.success || !isRecord(employer.company))
      throw new Error(
        `[QualificationEvidence] ${employer.error ?? "Company fetch failed"}`
      );
    const company = employer.company;
    const sourceUrl = getStringProperty(company, "linkedinUrl")?.trim();
    if (
      companyId(company.id) !== employerId ||
      !sourceUrl ||
      !/^https:\/\/(?:www\.)?linkedin\.com\/company\/[^/?#]+\/?(?:[?#].*)?$/i.test(
        sourceUrl
      )
    )
      throw new Error(
        "[QualificationEvidence] Provider returned a different or unverifiable company"
      );
    const headquarters: Record<string, unknown> = isRecord(company.headquarter)
      ? company.headquarter
      : {};
    const cachedEmployer =
      isRecord(prospect.qualificationProfileData) &&
      isRecord(prospect.qualificationProfileData.employerEvidence)
        ? prospect.qualificationProfileData.employerEvidence
        : undefined;
    const cachedWebsite = cachedEmployer?.officialWebsiteEvidence;
    let officialWebsiteEvidence =
      companyId(cachedEmployer?.companyId) === employerId &&
      isRecord(cachedWebsite) &&
      typeof cachedWebsite.text === "string" &&
      cachedWebsite.text.trim() &&
      sameWebsiteHost(cachedWebsite.url, company.website)
        ? cachedWebsite
        : undefined;
    let websiteReadError: string | undefined;
    if (!officialWebsiteEvidence && company.website?.trim()) {
      const [page] = await readWebPages([company.website], {
        ctx,
        consumer: "qualification.employer_website",
        workspaceId: prospect.workspaceId,
        prospectId: prospect._id,
      });
      if (page?.error) {
        const { reason } = classifyProviderFailure(new Error(page.error));
        if (
          reason === "transient" ||
          reason === "rate_limit" ||
          page.error.includes("provider circuit is open")
        )
          throw new Error(
            `[QualificationEvidence] Official company website: ${page.error}`
          );
        websiteReadError = page.error.slice(0, 600);
      } else if (!page?.snippet.trim()) {
        websiteReadError = "No readable company website content was available.";
      }
      if (page?.snippet.trim()) {
        if (!sameWebsiteHost(page.url, company.website))
          throw new Error(
            "[QualificationEvidence] Provider returned a different company website"
          );
        officialWebsiteEvidence = {
          url: page.url,
          retrievedAt: new Date(getCurrentUTCTimestamp()).toISOString(),
          text: page.snippet,
        };
      }
    }
    // Company context is separate from prospect-authored profile text and social quotes.
    profileData.employerEvidence = sanitizeWorkflowValue({
      companyId: employerId,
      sourceUrl,
      fetchedAt: new Date(getCurrentUTCTimestamp()).toISOString(),
      relationshipSourceUrl: profileUrl,
      officialWebsiteEvidence,
      websiteReadError,
      company: {
        name: company.name,
        description: sanitizeWorkflowString(company.description ?? "").slice(
          0,
          8000
        ),
        website: company.website,
        headquarter: {
          city: headquarters.city,
          country: headquarters.country,
          countryCode: headquarters.countryCode,
        },
        industries: company.industriesV2,
      },
    });
  }
  const activity =
    prospect.discoverySource === "search_people"
      ? await ctx.runAction(
          internal.integrations.linkedin.getProfilePosts
            .getProfilePostsInternal,
          {
            urn,
            maxPosts: 10,
          }
        )
      : { posts: [] };
  // Empty/private activity is a successful bounded lookup; network failures throw and retry.
  const evidencePosts = [
    ...(prospect.evidencePosts ?? []).filter(isRecord),
    ...activity.posts.map((post) => ({
      ...post,
      id: post.urn,
      url: post.url ?? `https://www.linkedin.com/feed/update/${post.urn}`,
    })),
  ];
  if (prospect.qualificationStatus === "pending")
    await ctx.runMutation(
      internal.prospects.saveQualificationDiscoveryEvidenceInternal,
      {
        prospectId: prospect._id,
        workspaceId: prospect.workspaceId,
        expectedTargetingFingerprint:
          getLearningTargetingFingerprint(workspace),
        profileData,
        evidencePosts,
      }
    );
  return { profileData, evidencePosts };
}

/** Real provider profile text, not search snippets or synthetic persona data. */
export function getQualificationProfileText(
  profile: Record<string, unknown>
): string {
  const positions = Array.isArray(profile.position)
    ? profile.position.filter(isRecord).slice(0, 5)
    : [];
  return [
    getStringProperty(profile, "headline"),
    getStringProperty(profile, "summary"),
    ...positions.flatMap((position) => [
      getStringProperty(position, "title"),
      getStringProperty(position, "companyName"),
      getStringProperty(position, "description"),
    ]),
  ]
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n");
}
