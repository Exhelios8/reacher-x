import assert from "node:assert/strict";
import test from "node:test";

test("WorkOS accepts application-scoped tokens without an audience", async () => {
  const previousClientId = process.env.WORKOS_CLIENT_ID;
  process.env.WORKOS_CLIENT_ID = "client_test";
  try {
    const { default: config } = await import("../convex/auth.config");
    const sharedIssuer = config.providers.find(
      (provider) => provider.issuer === "https://api.workos.com/"
    );
    const appIssuer = config.providers.find(
      (provider) =>
        provider.issuer === "https://api.workos.com/user_management/client_test"
    );
    assert.equal(sharedIssuer?.applicationID, "client_test");
    assert.ok(appIssuer);
    assert.equal(appIssuer.applicationID, undefined);
    assert.equal(appIssuer.jwks, "https://api.workos.com/sso/jwks/client_test");
    assert.equal(appIssuer.algorithm, "RS256");
  } finally {
    if (previousClientId === undefined) delete process.env.WORKOS_CLIENT_ID;
    else process.env.WORKOS_CLIENT_ID = previousClientId;
  }
});
