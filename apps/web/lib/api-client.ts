/**
 * API Client for frontend-to-backend communication
 * Uses NEXT_PUBLIC_API_URL to determine backend origin
 */

interface AuthState {
  token: string | null;
  email: string | null;
  userId: string | null;
}

const TOKEN_KEY = 'dai_token';
const EMAIL_KEY = 'dai_email';

// API base URL from environment or defaults to local API
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

/**
 * Get current authentication state from localStorage
 */
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

/**
 * Store authentication state after login
 */
export function setAuthState(token: string, email: string, userId: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EMAIL_KEY, email);
    localStorage.setItem('dai_user_id', userId);
  } catch {
    throw new Error('Failed to store authentication state');
  }
}

/**
 * Clear authentication state on logout
 */
export function clearAuthState(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    localStorage.removeItem('dai_user_id');
  } catch {
    // Ignore errors when clearing auth
  }
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return localStorage.getItem(TOKEN_KEY) !== null;
}

/**
 * Get bearer token for API requests
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Clear token (used on logout)
 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Make authenticated API request
 */
export async function fetchApi(url: string, options?: RequestInit): Promise<Response> {
  const token = getToken();
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Build full URL - if not absolute, use API_BASE
  const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url.startsWith('/') ? url : '/' + url}`;

  const response = await fetch(fullUrl, {
    ...options,
    headers,
    credentials: 'include', // For cookie-based auth
  });

  // Handle 401 - redirect to login
  if (response.status === 401) {
    clearAuthState();
    window.location.href = '/auth/login';
  }

  return response;
}

/**
 * Login function
 */
export async function login(email: string, password: string, name?: string): Promise<{ token: string; email: string; userId: string }> {
  const response = await fetchApi('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Authentication failed');
  }

  const data = await response.json();
  setAuthState(data.token, data.email, data.userId);
  return data;
}

/**
 * Logout function
 */
export async function logout(): Promise<void> {
  try {
    const token = getToken();
    if (token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'include',
      });
    }
    clearAuthState();
  } catch {
    clearAuthState();
  }
}

/**
 * Get current user info
 */
export async function getCurrentUser(): Promise<{ email: string; userId: string } | null> {
  const response = await fetchApi('/api/auth/me');
  if (!response.ok) return null;
  return response.json();
}
