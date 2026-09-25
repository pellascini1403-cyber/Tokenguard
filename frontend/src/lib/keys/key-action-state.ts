export interface CreateKeyActionState {
  error: string | null;
  /** Set only on success — the plaintext secret is never persisted, so
   * this is the only place the UI can ever show it. */
  createdKey: { id: string; prefix: string; apiKey: string } | null;
}

export const initialCreateKeyActionState: CreateKeyActionState = {
  error: null,
  createdKey: null,
};

export interface RevokeKeyActionState {
  error: string | null;
  success: boolean;
}

export const initialRevokeKeyActionState: RevokeKeyActionState = { error: null, success: false };
