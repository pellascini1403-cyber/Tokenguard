/**
 * Mirrors POST /v1/organizations/:organizationId/keys's response exactly
 * (see backend/src/routes/v1/organization-keys.route.ts). `apiKey` is the
 * plaintext secret and is only ever present in this one response — the
 * backend has no endpoint that returns it again, and no endpoint that
 * lists previously created keys at all. See the frontend README's
 * "Missing backend capabilities" section.
 */
export interface CreatedTokenGuardKey {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  apiKey: string;
  createdAt: string;
}
