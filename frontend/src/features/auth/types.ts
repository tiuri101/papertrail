export type EmailCategory =
  | 'llm_processing'
  | 'imports'
  | 'duplicate_detection'
  | 'project_progress'
  | 'project_membership'
  | 'project_archive'
  | 'project_copies'
  | 'new_projects';

export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
  isAdmin: boolean;
  isActive: boolean;
  mustChangePassword?: boolean;
  uiPreferences?: Record<string, unknown>;
  emailPreferences?: Partial<Record<EmailCategory, boolean>>;
}

export interface LoginResponse {
  user: User;
  csrfToken: string;
}
