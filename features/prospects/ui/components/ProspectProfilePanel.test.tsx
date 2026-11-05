import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { normalizeProspectProfileData } from "../../lib/normalizeProspectProfileData";
import { EvidencePostsList } from "./EvidencePostsList";
import { ProspectProfilePanel } from "./ProspectProfilePanel";
import { RelevantActivityTab } from "./tabs/RelevantActivityTab";
import type { ProspectDetailsCardProps } from "./ProspectDetailsCard";
import type { PainSolutionGridProps } from "./PainSolutionGrid";
import type { UnifiedPost } from "@/shared/lib/platforms/types";

const captured = vi.hoisted(() => ({
  details: {} as ProspectDetailsCardProps,
  pain: {} as PainSolutionGridProps,
}));
vi.mock("@/shared/hooks", () => ({
  useActiveUseCaseLabels: () => ({ entitySingular: "Prospect" }),
}));
vi.mock("../../contexts/PanelStackContext", () => ({
  usePanelStack: () => ({ popPanel: vi.fn(), pushPanel: vi.fn() }),
}));
vi.mock(
  "@/features/webapp/ui/components/tweet/useTwitterProfileNavigation",
  () => ({
    useTwitterProfileNavigation: () => ({ openProfile: vi.fn() }),
  })
);
vi.mock("@/shared/ui/hooks/useMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/features/webapp/ui/components", () => {
  const Content = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { PageLayout: Content, PageHeader: () => null, PageContent: Content };
});
vi.mock("@/shared/ui/components/ScrollArea", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/shared/ui/components/Tabs", () => {
  const Content = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Tabs: Content,
    TabsContent: Content,
    TabsList: Content,
    TabsTrigger: Content,
  };
});
vi.mock("./ProspectProfileHeader", () => ({
  ProspectProfileHeader: () => null,
}));
vi.mock("./PipelineTimeline", () => ({ PipelineTimeline: () => null }));
vi.mock("./ProspectDetailsCard", () => ({
  ProspectDetailsCard: (props: ProspectDetailsCardProps) => {
    captured.details = props;
    return null;
  },
}));
vi.mock("./PainSolutionGrid", () => ({
  PainSolutionGrid: (props: PainSolutionGridProps) => {
    captured.pain = props;
    return null;
  },
}));
vi.mock("./SocialProfileLinks", () => ({ SocialProfileLinks: () => null }));
vi.mock("./OutreachPlanSection", () => ({ OutreachPlanSection: () => null }));
vi.mock("./tabs/YourInteractionsTab", () => ({
  YourInteractionsTab: () => null,
}));
vi.mock("./tabs/ActivityLogTab", () => ({ ActivityLogTab: () => null }));
vi.mock("../../lib/uiPreviewData", () => ({
  UI_PREVIEW_ACTIVITY: [],
  UI_PREVIEW_INTERACTIONS: [],
  UI_PREVIEW_LINKEDIN_THREAD_SCENARIOS: {},
}));
vi.mock("@/shared/ui/components/InfiniteScrollTrigger", () => ({
  InfiniteScrollTrigger: () => null,
}));
vi.mock("@/shared/hooks/useHydratedTwitterPosts", () => ({
  useHydratedTwitterPosts: () => ({ tweetsById: {}, resultsById: {} }),
}));
vi.mock("@/shared/hooks/useTwitterTimelineEngagementMerge", () => ({
  useTwitterTimelineEngagementMerge: (posts: unknown[]) => posts,
}));
vi.mock("@/shared/hooks/useLinkedInPostEngagementMerge", () => ({
  useLinkedInPostEngagementMerge: (posts: unknown[]) => posts,
}));
vi.mock("@/features/webapp/ui/components/tweet", () => ({
  Tweet: () => null,
  TweetSkeleton: () => null,
}));
vi.mock("@/features/webapp/ui/components/linkedin", () => ({
  LinkedInPostCard: ({ post }: { post: UnifiedPost }) => (
    <article>
      {post.text}
      <button>Reply</button>
    </article>
  ),
  LinkedInCommentThread: () => null,
}));

const personalPost = {
  id: "urn:li:activity:123",
  platform: "linkedin",
  url: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
  author: { name: "Alex Example" },
  text: "My own product announcement.",
  createdAt: 1793692800000,
};
const employerEvent = {
  sourceId: "employer:42:hash",
  evidenceKind: "employer_event",
  contentType: "employer_event",
  platform: "linkedin",
  authorId: "company:42",
  employerName: "Example Company",
  sourceUrl: "https://example.com/old-news",
  evidenceUrl: "https://example.com/news/migration",
  text: "Our company is migrating its catalogue.",
  supportingQuote: "migrating its catalogue",
  publishedAt: "2026-11-03T08:00:00Z",
  verifiedAt: Date.parse("2026-11-05T10:00:00Z"),
  sourcePost: {
    ...personalPost,
    id: "employer:42:hash",
    text: "This is company context, never a personal post.",
  },
};
const personalSource = {
  sourceId: personalPost.id,
  evidenceKind: "social_post",
  sourceUrl: personalPost.url,
  sourcePost: personalPost,
};

beforeEach(() => {
  captured.details = {};
  captured.pain = {} as PainSolutionGridProps;
});

it("renders dated company evidence separately while preserving personal post actions", () => {
  const prospect = normalizeProspectProfileData({
    _id: "person",
    platform: "linkedin",
    displayName: "Alex Example",
    qualificationSources: [
      employerEvent,
      personalSource,
      { evidenceKind: "profile", sourceId: "profile:person" },
    ],
    evidencePosts: [employerEvent, personalPost],
    painPoints: [
      {
        pain: "Catalogue migration",
        evidencePosts: [employerEvent, personalPost],
      },
    ],
    finance: {
      displayValue: "Unknown",
      evidencePosts: [employerEvent, personalPost],
    },
  });
  expect(prospect?.qualificationSources?.[0]?.sourcePost).toBeUndefined();
  expect(prospect?.evidencePosts).toHaveLength(1);
  expect(prospect?.painPoints?.[0]?.evidencePosts).toHaveLength(1);
  expect(prospect?.finance?.evidencePosts).toHaveLength(1);
  const onOpenEvidencePosts = vi.fn();
  const html = renderToStaticMarkup(
    <ProspectProfilePanel
      prospect={prospect!}
      onOpenEvidencePosts={onOpenEvidencePosts}
    />
  );
  expect(html).toContain("Company event");
  expect(html).toContain("Example Company");
  expect(html).toContain('href="https://example.com/news/migration"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain("Published 2026-11-03");
  expect(html).toContain("Verified 2026-11-05");
  expect(html).toContain("migrating its catalogue");
  expect(html).toContain("Individual buying intent is unconfirmed.");
  expect(html).not.toContain("never a personal post");
  expect(html.match(/<button>Reply<\/button>/g)).toHaveLength(1);
  expect(captured.details.qualificationSourceCount).toBe(1);
  captured.details.onQualificationSourcesClick?.();
  expect(onOpenEvidencePosts.mock.lastCall?.[0].posts).toHaveLength(1);
  captured.pain.onPainClick?.(prospect!.painPoints![0], 0);
  expect(onOpenEvidencePosts.mock.lastCall?.[0].posts).toHaveLength(1);
});

it.each([
  "javascript:alert(1)",
  "http://127.0.0.1/news",
  "http://[::1]/news",
  "https://user:secret@example.com/news",
])("does not make unsafe company evidence clickable: %s", (evidenceUrl) => {
  const prospect = normalizeProspectProfileData({
    _id: "person",
    platform: "linkedin",
    qualificationSources: [{ ...employerEvent, evidenceUrl }],
  });
  const html = renderToStaticMarkup(
    <ProspectProfilePanel prospect={prospect!} />
  );
  expect(html).toContain("Company event");
  expect(html).not.toContain("Official company source</a>");
});

it("excludes tagged, wrapped and employer-ID evidence from direct post-list actions", () => {
  const posts = [
    employerEvent,
    { raw: employerEvent },
    employerEvent.sourcePost,
    personalPost,
  ];
  for (const element of [
    <EvidencePostsList key="evidence" platform="linkedin" posts={posts} />,
    <RelevantActivityTab
      key="activity"
      prospectId="person"
      platform="linkedin"
      evidencePosts={posts}
    />,
  ]) {
    const html = renderToStaticMarkup(element);
    expect(html).toContain(personalPost.text);
    expect(html).not.toContain(employerEvent.text);
    expect(html).not.toContain("never a personal post");
    expect(html.match(/<button>Reply<\/button>/g)).toHaveLength(1);
  }
});

it("shows independent site checks without publication or personal post actions", () => {
  const observation = {
    ...employerEvent,
    sourceId: "site_problem:42:hash",
    evidenceKind: "observed_site_problem",
    contentType: "observed_site_problem",
    authorId: "observer:reacherx",
    sourceUrl: "https://example.com/catalogue",
    evidenceUrl: "https://example.com/missing-category",
    observedAt: "2026-11-05T09:00:00Z",
    httpStatus: 404,
    sourcePost: {
      ...employerEvent.sourcePost,
      id: "site_problem:42:hash",
      evidenceKind: "observed_site_problem",
    },
  };
  const prospect = normalizeProspectProfileData({
    _id: "person",
    platform: "linkedin",
    displayName: "Alex Example",
    qualificationSources: [observation, personalSource],
    evidencePosts: [observation, { raw: observation }, personalPost],
    painPoints: [
      { pain: "Navigation", evidencePosts: [observation, personalPost] },
    ],
    finance: {
      displayValue: "Unknown",
      evidencePosts: [observation, personalPost],
    },
  });
  expect(prospect?.evidencePosts).toHaveLength(1);
  expect(prospect?.painPoints?.[0].evidencePosts).toHaveLength(1);
  expect(prospect?.finance?.evidencePosts).toHaveLength(1);
  expect(prospect?.qualificationSources?.[0].sourcePost).toBeUndefined();
  const onOpenEvidencePosts = vi.fn();
  const html = renderToStaticMarkup(
    <ProspectProfilePanel
      prospect={prospect!}
      onOpenEvidencePosts={onOpenEvidencePosts}
    />
  );
  expect(html).toContain("Website issue observed by ReacherX");
  expect(html).toContain("Observed 2026-11-05");
  expect(html).toContain("Verified 2026-11-05");
  expect(html).toContain("Linked destination (HTTP 404)");
  expect(html).toContain("not a statement by this person");
  expect(html).not.toContain("Published");
  expect(html.indexOf('href="https://example.com/catalogue"')).toBeLessThan(
    html.indexOf('href="https://example.com/missing-category"')
  );
  expect(html.match(/<button>Reply<\/button>/g)).toHaveLength(1);
  captured.details.onQualificationSourcesClick?.();
  expect(onOpenEvidencePosts.mock.lastCall?.[0].posts).toHaveLength(1);
});
