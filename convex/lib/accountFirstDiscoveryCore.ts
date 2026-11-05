import type { WorkspaceTargetingSpec } from "./targetingSpecCore";
import type { ResearchFinding } from "./researchCore";

export const ACCOUNT_RESEARCH_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const ACCOUNT_HINT_PREFIX = "account_research_hint:";
const EXCLUDED_DOMAINS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "crunchbase.com",
  "pappers.fr",
  "societe.com",
  "wikipedia.org",
];

export function isAccountFirstDiscoveryEnabled(workspaceId?: string): boolean {
  return Boolean(
    workspaceId &&
    process.env.ACCOUNT_FIRST_DISCOVERY_WORKSPACE_IDS?.split(",")
      .map((id) => id.trim())
      .includes(workspaceId)
  );
}

export function buildAccountResearchQuery(args: {
  businessContext?: string;
  targetingSpec?: WorkspaceTargetingSpec;
  now: number;
}): string {
  const cutoff = new Date(args.now - ACCOUNT_RESEARCH_LOOKBACK_MS)
    .toISOString()
    .slice(0, 10);
  return [
    `Find dated company announcements published after ${cutoff} on the issuing company's own official website/newsroom/blog.`,
    "Find actual operating events (launch, expansion, new location, hiring, investment), not advice, agencies selling services, directories, social profiles, or vendors' customer case studies.",
    `Target audience and required constraints: ${JSON.stringify({
      summary: args.targetingSpec?.summary,
      locations: args.targetingSpec?.searchHints.locations,
      industries: args.targetingSpec?.searchHints.industries,
      requiredCriteria: args.targetingSpec?.criteria
        .filter((criterion) => criterion.kind === "required")
        .map((criterion) => criterion.description),
      originalAudience: args.businessContext,
    }).slice(0, 6_000)}`,
  ].join("\n");
}

export function selectRecentAccountFindings(
  findings: ResearchFinding[],
  now: number
): ResearchFinding[] {
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      try {
        const url = new URL(finding.url);
        const date = Date.parse(finding.publishedDate ?? "");
        if (
          !/^https?:$/.test(url.protocol) ||
          !finding.title.trim() ||
          !finding.snippet.trim() ||
          !Number.isFinite(date) ||
          date < now - ACCOUNT_RESEARCH_LOOKBACK_MS ||
          date > now ||
          EXCLUDED_DOMAINS.some(
            (domain) =>
              url.hostname === domain || url.hostname.endsWith(`.${domain}`)
          ) ||
          /case[-_ ]?stud|cas[-_ ]client|temoignage|testimonial|portfolio/i.test(
            url.pathname
          ) ||
          seen.has(url.href)
        )
          return false;
        seen.add(url.href);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, 4)
    .map((finding) => ({
      ...finding,
      snippet: finding.snippet.slice(0, 1_200),
    }));
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Research provenance only: the qualifier still verifies employer, geography and event. */
export function groundAccountQuery<
  T extends { query: string; accountName?: string; accountSourceUrl?: string },
>(
  item: T,
  findings: ResearchFinding[]
): (T & { sourceKeyword: string }) | null {
  const finding = findings.find(
    (finding) => finding.url === item.accountSourceUrl
  );
  const name = item.accountName?.trim();
  if (
    !finding ||
    !name ||
    normalizeName(item.query) === normalizeName(name) ||
    !normalizeName(item.query).includes(normalizeName(name)) ||
    !normalizeName(`${finding.title} ${finding.snippet}`).includes(
      normalizeName(name)
    )
  )
    return null;
  const host = normalizeName(
    new URL(finding.url).hostname
      .replace(/^www\./, "")
      .split(".")
      .slice(0, -1)
      .join(" ")
  );
  const nameTokens = name
    .split(/\s+/)
    .map(normalizeName)
    .filter(
      (token) =>
        token.length >= 3 &&
        !["groupe", "group", "company", "france", "sas", "sarl"].includes(token)
    );
  if (!nameTokens.some((token) => host.includes(token))) return null;
  return {
    ...item,
    sourceKeyword: `${ACCOUNT_HINT_PREFIX}${Date.parse(finding.publishedDate ?? "")}|${finding.url}`,
  };
}

export function isFreshAccountResearchHint(
  source: string | undefined,
  now: number
): boolean {
  if (!source?.startsWith(ACCOUNT_HINT_PREFIX)) return false;
  const [date, url] = source.slice(ACCOUNT_HINT_PREFIX.length).split("|");
  const publishedAt = Number(date);
  return (
    Number.isFinite(publishedAt) &&
    publishedAt >= now - ACCOUNT_RESEARCH_LOOKBACK_MS &&
    publishedAt <= now &&
    Boolean(url && /^https?:\/\//.test(url))
  );
}

export function isAccountResearchHintFromFindings(
  source: string | undefined,
  findings: ResearchFinding[],
  now: number
): boolean {
  return (
    isFreshAccountResearchHint(source, now) &&
    findings.some(
      (finding) =>
        source ===
        `${ACCOUNT_HINT_PREFIX}${Date.parse(finding.publishedDate ?? "")}|${finding.url}`
    )
  );
}
