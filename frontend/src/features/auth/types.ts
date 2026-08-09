export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
  isAdmin: boolean;
  isActive: boolean;
  mustChangePassword?: boolean;
}

export interface LoginResponse {
  user: User;
  csrfToken: string;
}
