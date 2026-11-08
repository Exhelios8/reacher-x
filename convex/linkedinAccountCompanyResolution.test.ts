import { afterEach, expect, test, vi } from "vitest";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { getCompany } from "./integrations/linkedin/getCompany";
import { requestLinkdApiData } from "./integrations/linkedin/linkdapiClient";

vi.mock("./integrations/linkedin/linkdapiClient", () => ({
  requestLinkdApiData: vi.fn(),
}));
const handler = (
  getCompany as unknown as {
    _handler: (
      ctx: ActionCtx,
      args: FunctionArgs<
        typeof internal.integrations.linkedin.getCompany.getCompany
      >
    ) => Promise<
      FunctionReturnType<
        typeof internal.integrations.linkedin.getCompany.getCompany
      >
    >;
  }
)._handler;
const args = { name: "Acme", sourceUrl: "https://acme.fr/offre" };
afterEach(() => vi.resetAllMocks());

test("official company binding uses a unique native lookup ID and verifies name and domain", async () => {
  vi.mocked(requestLinkdApiData)
    .mockResolvedValueOnce({
      companies: [
        { id: "123", displayName: "Acme" },
        { id: "456", displayName: "Acme Division" },
      ],
    })
    .mockResolvedValueOnce({
      id: "123",
      name: "Acme",
      website: "https://www.acme.fr",
    });
  expect(await handler({} as ActionCtx, args)).toMatchObject({
    success: true,
    company: { id: "123" },
  });
  expect(vi.mocked(requestLinkdApiData).mock.calls[1][1]).toMatchObject({
    query: { id: "123", name: undefined },
  });
});

test.each(["https://homonym.fr", "https://parent-group.fr"])(
  "a company on %s is never bound to the observed official source",
  async (website) => {
    vi.mocked(requestLinkdApiData)
      .mockResolvedValueOnce({
        companies: [{ id: "123", displayName: "Acme" }],
      })
      .mockResolvedValueOnce({ id: "123", name: "Acme", website });
    expect(await handler({} as ActionCtx, args)).toMatchObject({
      success: false,
      error: expect.stringContaining("official source"),
    });
  }
);

test("homonyms do not become the first autocomplete match", async () => {
  vi.mocked(requestLinkdApiData).mockResolvedValueOnce({
    companies: [
      { id: "123", displayName: "Acme" },
      { id: "456", displayName: "Acme" },
    ],
  });
  expect(await handler({} as ActionCtx, args)).toMatchObject({
    success: false,
    error: expect.stringContaining("ambiguous"),
  });
  expect(requestLinkdApiData).toHaveBeenCalledOnce();
});

test("the observed Dutscher short brand binds its unique official company, while SAP divisions cannot alias SAP", async () => {
  vi.mocked(requestLinkdApiData)
    .mockResolvedValueOnce({
      companies: [{ id: "3475985", displayName: "Dominique Dutscher" }],
    })
    .mockResolvedValueOnce({
      id: "3475985",
      name: "Dominique Dutscher",
      website: "http://www.dutscher.com",
    });
  expect(
    await handler({} as ActionCtx, {
      name: "Dutscher",
      sourceUrl: "https://www.dutscher.com/ecatalogue/list?language=fr",
    })
  ).toMatchObject({ success: true, company: { id: "3475985" } });
  vi.mocked(requestLinkdApiData)
    .mockClear()
    .mockResolvedValueOnce({
      companies: [{ id: "999", displayName: "SAP France" }],
    });
  expect(
    await handler({} as ActionCtx, {
      name: "SAP",
      sourceUrl: "https://www.sap.com/france/",
    })
  ).toMatchObject({ success: false });
  expect(requestLinkdApiData).toHaveBeenCalledOnce();
});

test("a lookup outage is retryable and cannot be confused with an unknown company", async () => {
  vi.mocked(requestLinkdApiData).mockRejectedValueOnce(new Error("HTTP 503"));
  expect(await handler({} as ActionCtx, args)).toMatchObject({
    success: false,
    retryable: true,
  });
});

test("numeric lookup IDs normalize to a string and returned details must keep that identity", async () => {
  vi.mocked(requestLinkdApiData)
    .mockResolvedValueOnce({ companies: [{ id: 123, displayName: "Acme" }] })
    .mockResolvedValueOnce({
      id: 123,
      name: "Acme",
      website: "https://acme.fr",
    });
  expect(await handler({} as ActionCtx, args)).toMatchObject({
    success: true,
    company: { id: "123" },
  });
  vi.mocked(requestLinkdApiData)
    .mockResolvedValueOnce({ companies: [{ id: "123", displayName: "Acme" }] })
    .mockResolvedValueOnce({
      id: "456",
      name: "Acme",
      website: "https://acme.fr",
    });
  expect(await handler({} as ActionCtx, args)).toMatchObject({
    success: false,
  });
});
