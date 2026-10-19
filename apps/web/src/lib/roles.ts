import type { Role } from '@open-itsm/shared';

export const roleLabels: Record<Role, string> = {
  admin: 'Administrator',
  technician: 'Technician',
  end_user: 'Requester',
};
