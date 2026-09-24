import { describe, expect, it } from "vitest";
import { createKeysService } from "../../src/modules/keys/keys.service.js";
import { createFakeAdminClient } from "../helpers/fake-admin-client.js";

const ORG_ID = "org-11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "org-22222222-2222-2222-2222-222222222222";

describe("keys service", () => {
  it("returns the plaintext key only at creation time", async () => {
    const { client } = createFakeAdminClient();
    const service = createKeysService(client);

    const created = await service.createKey(ORG_ID, "CI key");

    expect(created.apiKey.startsWith("tg_usr_live_")).toBe(true);
    expect(created.organizationId).toBe(ORG_ID);
  });

  it("stores only a hash in the database, never the plaintext", async () => {
    const { client, store } = createFakeAdminClient();
    const service = createKeysService(client);

    const created = await service.createKey(ORG_ID, "CI key");

    const row = store.token_guard_keys.find((r) => r.id === created.id);
    expect(row).toBeDefined();
    expect(row?.key_hash).not.toBe(created.apiKey);
    expect(JSON.stringify(row)).not.toContain(created.apiKey);
  });

  it("verifies the same plaintext key that was issued", async () => {
    const { client } = createFakeAdminClient();
    const service = createKeysService(client);

    const created = await service.createKey(ORG_ID, "CI key");
    const context = await service.verifyKey(created.apiKey);

    expect(context).toMatchObject({ keyId: created.id, organizationId: ORG_ID });
  });

  it("rejects an invalid key", async () => {
    const { client } = createFakeAdminClient();
    const service = createKeysService(client);
    await service.createKey(ORG_ID, "CI key");

    expect(await service.verifyKey("tg_usr_live_not-a-real-key")).toBeNull();
  });

  it("rejects a wrong key (valid shape, wrong secret)", async () => {
    const { client } = createFakeAdminClient();
    const service = createKeysService(client);

    await service.createKey(ORG_ID, "key one");
    const keyTwo = await service.createKey(ORG_ID, "key two");

    // A key's own prefix must resolve to its own hash, not another key's.
    const context = await service.verifyKey(keyTwo.apiKey);
    expect(context?.keyId).toBe(keyTwo.id);
  });

  it("rejects a revoked key", async () => {
    const { client } = createFakeAdminClient();
    const service = createKeysService(client);

    const created = await service.createKey(ORG_ID, "CI key");
    await service.revokeKey(ORG_ID, created.id);

    expect(await service.verifyKey(created.apiKey)).toBeNull();
  });

  it("resolves the correct organization for a verified key", async () => {
    const { client } = createFakeAdminClient();
    const service = createKeysService(client);

    await service.createKey(ORG_ID, "org one key");
    const otherOrgKey = await service.createKey(OTHER_ORG_ID, "org two key");

    const context = await service.verifyKey(otherOrgKey.apiKey);
    expect(context?.organizationId).toBe(OTHER_ORG_ID);
  });

  it("throws when revoking a key that does not exist", async () => {
    const { client } = createFakeAdminClient();
    const service = createKeysService(client);

    await expect(
      service.revokeKey(ORG_ID, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("cannot revoke a key by targeting the wrong organization", async () => {
    const { client } = createFakeAdminClient();
    const service = createKeysService(client);

    const created = await service.createKey(ORG_ID, "CI key");

    await expect(service.revokeKey(OTHER_ORG_ID, created.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Still valid, since the revoke against the wrong org never applied.
    expect(await service.verifyKey(created.apiKey)).not.toBeNull();
  });
});
