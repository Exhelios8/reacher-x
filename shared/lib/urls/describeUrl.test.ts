import { afterEach, expect, test, vi } from "vitest";
import {
  describeUrlWithHtmlFallback,
  validateDescribeUrlInput,
} from "./describeUrl";

afterEach(() => vi.unstubAllGlobals());

test.each([
  [
    '<meta property="article:published_time" content="2026-11-04T10:00:00Z">',
    "2026-11-04T10:00:00Z",
  ],
  [
    '<script type="application/ld+json">{"@type":"NewsArticle","url":"https://other.example/redirected","datePublished":"2026-11-03"}</script>',
    "2026-11-03",
  ],
  ["<footer>Copyright 2026. Retrieved today.</footer>", undefined],
  [
    '<script type="application/ld+json">{"@type":"NewsArticle","url":"https://other.example/related-article","datePublished":"2026-11-03"}</script>',
    undefined,
  ],
])(
  "retains the final URL and a publication field without inventing a date",
  async (metadata, expectedDate) => {
    const response = new Response(
      `<html><head><title>Company migration</title>${metadata}</head><body><p>The company is moving its commercial catalogue to a new platform this month, with its existing pages maintained.</p></body></html>`,
      { headers: { "content-type": "text/html" } }
    );
    Object.defineProperty(response, "url", {
      value: "https://other.example/redirected",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(
      await describeUrlWithHtmlFallback("https://courses.example/news")
    ).toMatchObject({
      success: true,
      finalUrl: "https://other.example/redirected",
      publishedDate: expectedDate,
    });
  }
);

test("publisher-only reads reject redirects before they can reach a private destination", async () => {
  const request = vi
    .fn()
    .mockRejectedValue(new TypeError("fetch failed on redirect"));
  vi.stubGlobal("fetch", request);
  expect(
    await describeUrlWithHtmlFallback("https://courses.example/news", {
      rejectRedirects: true,
    })
  ).toMatchObject({ success: false });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://courses.example/news",
    expect.objectContaining({ redirect: "error" })
  );
  for (const url of [
    "https://user:pass@courses.example/news",
    "http://169.254.169.254/latest",
    "http://[::1]/news",
  ]) {
    expect(validateDescribeUrlInput(url).ok).toBe(false);
  }
});
