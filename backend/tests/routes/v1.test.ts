import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.js";
import { createFakeAdminClient, type FakeStore } from "../helpers/fake-admin-client.js";
import { createFakeAuthClient } from "../helpers/fake-auth-client.js";

/** Parses a response body as unknown first so a later `as T` is a real
 * (non-redundant) assertion rather than feeding back into `.json()`'s own
 * generic inference. */
function parseBody(res: LightMyRequestResponse): unknown {
  return res.json();
}

const OWNER_TOKEN = "token-owner";
const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_TOKEN = "token-member";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OUTSIDER_TOKEN = "token-outsider";
const OUTSIDER_ID = "33333333-3333-3333-3333-333333333333";

function buildTestApp(): { app: FastifyInstance; store: FakeStore } {
  const authClient = createFakeAuthClient({
    [OWNER_TOKEN]: { id: OWNER_ID, email: "owner@example.com" },
    [MEMBER_TOKEN]: { id: MEMBER_ID, email: "member@example.com" },
    [OUTSIDER_TOKEN]: { id: OUTSIDER_ID, email: "outsider@example.com" },
  });
  const { client: adminClient, store } = createFakeAdminClient();
  const app = buildApp({ nodeEnv: "test", supabase: { authClient, adminClient } });
  return { app, store };
}

describe("authentication", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = buildTestApp());
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Basic not-a-bearer-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid access token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("authenticates a valid access token and exposes the user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: OWNER_ID, email: "owner@example.com" });
  });
});

describe("organizations", () => {
  let app: FastifyInstance;
  beforeEach(() => {
    ({ app } = buildTestApp());
  });

  it("creates an organization for the authenticated user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { name: "Acme Inc" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ organization: { name: "Acme Inc" } });
  });

  it("lists only the authenticated user's organizations", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { name: "Owner Org" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { authorization: `Bearer ${OUTSIDER_TOKEN}` },
      payload: { name: "Outsider Org" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/organizations",
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });

    const body = parseBody(res) as { organizations: Array<{ name: string }> };
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]?.name).toBe("Owner Org");
  });

  it("requires authentication to create an organization", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name: "No Auth Org" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("TokenGuard keys and authorization", () => {
  let app: FastifyInstance;
  let store: FakeStore;
  let organizationId: string;

  beforeEach(async () => {
    ({ app, store } = buildTestApp());
    const createOrgRes = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { name: "Acme Inc" },
    });
    organizationId = (parseBody(createOrgRes) as { organization: { id: string } }).organization.id;

    // There is no invite endpoint in this step, so a plain "member" is
    // seeded directly into the store the app's admin client reads from.
    store.organization_members.push({
      id: randomUUID(),
      organization_id: organizationId,
      user_id: MEMBER_ID,
      role: "member",
      created_at: new Date().toISOString(),
    });
  });

  it("lets the owner create a TokenGuard key and returns the plaintext once", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys`,
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { name: "CI key" },
    });

    expect(res.statusCode).toBe(201);
    const body = parseBody(res) as { key: { apiKey: string; prefix: string } };
    expect(body.key.apiKey.startsWith("tg_usr_live_")).toBe(true);
    expect(body.key.prefix).toBeTruthy();
  });

  it("does not let a plain member create a key", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys`,
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
      payload: { name: "Member key" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not let an outsider create a key for another organization", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys`,
      headers: { authorization: `Bearer ${OUTSIDER_TOKEN}` },
      payload: { name: "Malicious key" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("lets the owner revoke a key", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys`,
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { name: "CI key" },
    });
    const keyId = (parseBody(createRes) as { key: { id: string } }).key.id;

    const revokeRes = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys/${keyId}/revoke`,
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json()).toMatchObject({ revoked: true });
  });

  it("does not let a plain member revoke a key", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys`,
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { name: "CI key" },
    });
    const keyId = (parseBody(createRes) as { key: { id: string } }).key.id;

    const revokeRes = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys/${keyId}/revoke`,
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });
    expect(revokeRes.statusCode).toBe(403);
  });

  it("does not let an unauthorized user revoke another organization's key", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys`,
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { name: "CI key" },
    });
    const keyId = (parseBody(createRes) as { key: { id: string } }).key.id;

    const revokeRes = await app.inject({
      method: "POST",
      url: `/v1/organizations/${organizationId}/keys/${keyId}/revoke`,
      headers: { authorization: `Bearer ${OUTSIDER_TOKEN}` },
    });
    expect(revokeRes.statusCode).toBe(403);
  });

  it("does not reveal an organization's existence to a non-member", async () => {
    const nonexistentOrgId = "99999999-9999-4999-8999-999999999999";
    const res = await app.inject({
      method: "POST",
      url: `/v1/organizations/${nonexistentOrgId}/keys`,
      headers: { authorization: `Bearer ${OUTSIDER_TOKEN}` },
      payload: { name: "key" },
    });
    // Same FORBIDDEN response whether the org exists or not.
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});
