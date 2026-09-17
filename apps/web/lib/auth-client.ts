// Authentication state and operations
interface AuthState {
  token: string | null;
  email: string | null;
  userId: string | null;
}

const TOKEN_KEY = 'dai_token';
const EMAIL_KEY = 'dai_email';

// Initialize auth from localStorage
export function getAuthState(): AuthState {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const email = localStorage.getItem(EMAIL_KEY);
    const userId = localStorage.getItem('dai_user_id');
    return { token, email, userId };
  } catch {
    return { token: null, email: null, userId: null };
  }
}

// Store auth after login
export function setAuthState(token: string, email: string, userId: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EMAIL_KEY, email);
    localStorage.setItem('dai_user_id', userId);
  } catch {
    throw new Error('Failed to store authentication state');
  }
}

// Clear auth on logout
export function clearAuthState(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    localStorage.removeItem('dai_user_id');
  } catch {
    // Ignore errors when clearing auth
  }
}

// Check if user is authenticated
export function isAuthenticated(): boolean {
  return localStorage.getItem(TOKEN_KEY) !== null;
}

// Protected fetch wrapper that auto-adds Authorization header
export async function fetchAuth(url: string, options?: RequestInit): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    clearAuthState();
    window.location.href = '/login';
  }

  return response;
}

// Token management utilities
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Logout function
export async function logout(): Promise<void> {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
    }
    clearAuthState();
  } catch {
    clearAuthState();
  }
}
