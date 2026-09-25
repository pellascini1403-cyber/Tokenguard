export interface CreateOrganizationActionState {
  error: string | null;
  createdOrganizationId: string | null;
}

export const initialCreateOrganizationActionState: CreateOrganizationActionState = {
  error: null,
  createdOrganizationId: null,
};
