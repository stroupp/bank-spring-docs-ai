const base = "/api/treasury/releases";

export const releaseApi = {
  list: (status?: string) => request(`${base}${status ? `?status=${status}` : ""}`),
  detail: (id: string) => request(`${base}/${id}`)
};
