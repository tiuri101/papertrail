export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
  isAdmin: boolean;
  isActive: boolean;
  mustChangePassword?: boolean;
  uiPreferences?: Record<string, unknown>;
}

export interface LoginResponse {
  user: User;
  csrfToken: string;
}
