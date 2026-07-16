export const API_ROOT = import.meta.env.VITE_API_ROOT ?? "/api";

export const API_PATHS = {
  transfers: `${API_ROOT}/transfers`
} as const;
