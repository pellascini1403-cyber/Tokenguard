/** Mirrors the exact response of GET /v1/me. Nothing more, nothing less. */
export interface AuthenticatedUser {
  id: string;
  email: string | null;
}
