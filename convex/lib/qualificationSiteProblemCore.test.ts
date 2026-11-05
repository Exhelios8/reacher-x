import { afterEach, expect, test, vi } from "vitest";
import {
  observeOfficialSiteProblem,
  QualificationSiteProblemRetryableError,
} from "./qualificationSiteProblemCore";

const sourceUrl = "https://acme.example/news/new-product";
const targetUrl = "https://acme.example/docs/product";
const args = {
  companyId: "42",
  officialWebsite: "https://acme.example",
  sourceUrl,
};
const sourceHtml = `<html><head><title>Acme product</title></head><body><main><p>Use our product. <a href="${targetUrl}">Product documentation</a></p></main></body></html>`;
function page(
  url: string,
  status: number,
  html = "<p>Page not found.</p>",
  headers: Record<string, string> = {}
) {
  const response = new Response(html, {
    status,
    headers: { "content-type": "text/html", ...headers },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
function requests(
  html = sourceHtml,
  first = 404,
  second = first,
  headers: Record<string, string> = {}
) {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(sourceUrl, 200, html))
    .mockResolvedValueOnce(page(targetUrl, first, undefined, headers))
    .mockResolvedValueOnce(page(targetUrl, second));
  vi.stubGlobal("fetch", request);
  return request;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([404, 410])(
  "records only a live official link confirmed HTTP %s twice",
  async (status) => {
    const request = requests(sourceHtml, status);
    const observed = await observeOfficialSiteProblem(args);
    expect(observed).toMatchObject({
      evidenceKind: "observed_site_problem",
      companyId: "42",
      url: sourceUrl,
      finalUrl: sourceUrl,
      targetUrl,
      anchorText: "Product documentation",
      httpStatus: status,
    });
    expect(Date.parse(observed!.observedAt)).toBeGreaterThan(Date.now() - 2000);
    expect(observed).not.toHaveProperty("publishedAt");
    expect(observed!.text).toContain(
      `Observed HTTP ${status}, confirmed by two GET requests.`
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      sourceUrl,
      targetUrl,
      targetUrl,
    ]);
    for (const [, options] of request.mock.calls)
      expect(options).toMatchObject({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      });
    expect(request.mock.calls[0][1].signal).toBe(
      request.mock.calls[2][1].signal
    );
  }
);

test.each([200, 301, 302, 401, 403])(
  "a target returning HTTP %s is not a missing-page observation",
  async (status) => {
    const request = requests(sourceHtml, status);
    expect(await observeOfficialSiteProblem(args)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  }
);

test("a target that recovers on confirmation is not reported", async () => {
  requests(sourceHtml, 404, 200);
  expect(await observeOfficialSiteProblem(args)).toBeUndefined();
});

test.each([
  "<p>The old documentation returned 404 last year.</p>",
  '<a href="https://third-party.example/docs/missing">Documentation</a>',
  '<footer><a href="/docs/product">Documentation</a></footer>',
  '<pre><a href="/docs/product">Example failing link</a></pre>',
  '<!-- <a href="/docs/product">Example</a> -->',
  '<a href="/products/logo.svg">Product logo</a>',
  '<a href="/products/logo%2esvg">Product logo</a>',
  '<a href="/docs/icon%2epng">Documentation icon</a>',
  '<a href="/%63heckout/services/x">Buy product</a>',
  '<a href="/docs/private/product">Private documentation</a>',
  '<a href="https://name:secret@acme.example/docs/product">Documentation</a>',
  '<a href="http://127.0.0.1/docs/product">Documentation</a>',
  '<a href="/docs/product?token=private">Documentation</a>',
  '<a data-href="/docs/product">Documentation</a>',
  "<a title=\"Click href='/docs/product'\">Documentation</a>",
  '<a href="/docs/product" href="/docs/live">Ambiguous documentation</a>',
  '<a href="/docs/product"><svg><title>Logo</title></svg></a>',
  '<a href="/products/logo"><svg><title>Logo</title></svg></a>',
  '<a href="/products/logo">Logo</a>',
  '<a href="/docs/%5ccheckout/services/x">Buy product</a>',
  '<a href="/checkout;session/services/x">Buy product</a>',
  '<a href="/docs/product" style="display:none">Documentation</a>',
  '<textarea><a href="/services/missing">Example to copy</a></textarea>',
  '<textarea><a href="/services/missing">Example to copy</a>',
  '<!-- <a href="/docs/product">Example</a>',
  "<script>const example = '<a href=\"/docs/product\">Documentation</a>';",
  '<base href="https://third-party.example/"><a href="/docs/product">Documentation</a>',
])(
  "ignores non-navigation, third-party, private, asset or ambiguous links: %s",
  async (content) => {
    const request = requests(`<html><body>${content}</body></html>`);
    expect(await observeOfficialSiteProblem(args)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  }
);

test("real href wins over data-href and an apparent href inside another attribute", async () => {
  const request = requests(
    '<main><a data-href="/docs/removed" title="Click href=\'/docs/faux\'" href="/docs/product">Documentation</a></main>',
    200
  );
  expect(await observeOfficialSiteProblem(args)).toBeUndefined();
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    sourceUrl,
    targetUrl,
  ]);
});

test.each<Record<string, string>>([
  { "www-authenticate": "Bearer" },
  { "retry-after": "30" },
  { "cf-mitigated": "challenge" },
  { location: "/products/new-product" },
])(
  "authentication, rate-limit and relocation headers never prove a missing page: %j",
  async (headers) => {
    requests(sourceHtml, 404, 404, headers);
    expect(await observeOfficialSiteProblem(args)).toBeUndefined();
  }
);

test.each([
  "<h1>Sign in to access this page</h1>",
  '<meta http-equiv="refresh" content="0;url=/docs/live">',
  '<link rel="canonical" href="/docs/live">',
  '<link rel = "canonical" href = "/docs/live">',
  '<link href="/docs/live" rel="canonical" />',
  '<p>This documentation has moved to <a href="/docs/live">the new guide</a>.</p>',
])(
  "an access page or replacement destination in an HTTP404 body is not reported",
  async (html) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(page(sourceUrl, 200, sourceHtml))
        .mockResolvedValueOnce(page(targetUrl, 404, html))
    );
    expect(await observeOfficialSiteProblem(args)).toBeUndefined();
  }
);

test("redirects and network uncertainty fail open without probing the redirected destination", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(page(sourceUrl, 200, sourceHtml))
    .mockRejectedValueOnce(new TypeError("redirect not allowed"));
  vi.stubGlobal("fetch", request);
  expect(await observeOfficialSiteProblem(args)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
  expect(
    request.mock.calls.every(([url]) => !String(url).includes("127.0.0.1"))
  ).toBe(true);
});

test("truncated source and error bodies cannot hide non-navigation or relocation controls", async () => {
  const request = requests(
    `<script>const tpl='<a href="/services/missing">Service</a>';${" ".repeat(128 * 1024)}</script><main>Live content</main>`
  );
  expect(await observeOfficialSiteProblem(args)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  const targetRequest = vi
    .fn()
    .mockResolvedValueOnce(page(sourceUrl, 200, sourceHtml))
    .mockResolvedValueOnce(
      page(
        targetUrl,
        404,
        `${" ".repeat(8 * 1024)}<meta http-equiv="refresh" content="0;url=/docs/live">`
      )
    );
  vi.stubGlobal("fetch", targetRequest);
  expect(await observeOfficialSiteProblem(args)).toBeUndefined();
  expect(targetRequest).toHaveBeenCalledTimes(2);
});

test("a shared eight-second timeout bounds the entire observation", async () => {
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(AbortSignal.abort());
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"))
  );
  await expect(observeOfficialSiteProblem(args)).rejects.toBeInstanceOf(
    QualificationSiteProblemRetryableError
  );
  expect(timeout).toHaveBeenCalledWith(8000);
});

test.each([429, 500, 503])(
  "transient HTTP%s keeps a typed retry signal without creating evidence",
  async (status) => {
    requests(sourceHtml, status, status, { "retry-after": "30" });
    await expect(observeOfficialSiteProblem(args)).rejects.toBeInstanceOf(
      QualificationSiteProblemRetryableError
    );
  }
);

test("a network failure is retryable, but an explicit anti-bot response is not", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("fetch failed"))
  );
  await expect(observeOfficialSiteProblem(args)).rejects.toBeInstanceOf(
    QualificationSiteProblemRetryableError
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      page(sourceUrl, 503, "<h1>Just a moment</h1>", {
        "cf-mitigated": "challenge",
      })
    )
  );
  expect(await observeOfficialSiteProblem(args)).toBeUndefined();
});

test.each([
  { status: 403, contentType: "text/html", html: sourceHtml },
  { status: 200, contentType: "text/plain", html: sourceHtml },
  {
    status: 200,
    contentType: "text/html",
    html: `<h1>Sign in to access this page</h1>${sourceHtml}`,
  },
])(
  "only a real public HTTP200 HTML source can be observed",
  async ({ status, contentType, html }) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        page(sourceUrl, status, html, { "content-type": contentType })
      );
    vi.stubGlobal("fetch", request);
    expect(await observeOfficialSiteProblem(args)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  }
);
