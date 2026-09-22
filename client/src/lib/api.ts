import axios from 'axios';

export const AUTH_STORAGE_KEY = 'jeevanlocker-auth';

const getPersistedToken = (): string | null => {
  const storedAuth = localStorage.getItem(AUTH_STORAGE_KEY);

  if (!storedAuth) {
    return null;
  }

  try {
    const parsedAuth = JSON.parse(storedAuth) as { state?: { token?: string } };
    return parsedAuth.state?.token ?? null;
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
};

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api',
});

api.interceptors.request.use((config) => {
  const token = getPersistedToken();

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      window.dispatchEvent(new Event('auth:unauthorized'));
    }

    return Promise.reject(error);
  }
);

/** HTTP status of a failed request, or null when it never reached the server. Lets a caller treat a
 * specific status as a normal outcome (e.g. a 409 that just means "already done") instead of an error. */
export const getApiErrorStatus = (error: unknown): number | null =>
  axios.isAxiosError(error) ? error.response?.status ?? null : null;

export const getApiErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ERR_NETWORK') {
      return 'Server unavailable. Please check your connection.';
    }

    const data = error.response?.data as { message?: string; errors?: Record<string, string> };

    if (data?.errors && typeof data.errors === 'object') {
      const errorMessages = Object.values(data.errors);
      if (errorMessages.length > 0) {
        return `${data.message || 'Validation failed'}: ${errorMessages.join(', ')}`;
      }
    }

    if (typeof data?.message === 'string') {
      return data.message;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Something went wrong. Please try again.';
};
