export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
}

export interface LoginResponse {
  user: User;
  csrfToken: string;
}
