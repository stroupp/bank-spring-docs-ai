import axios from "axios";

const API_BASE = "/api/customers";

export const customerApi = {
  searchCustomers: (params: Record<string, string>) => axios.get(`${API_BASE}/search`, { params }),
  createCustomer: (body: unknown) => axios.post("/api/customers/search", body),
  loadCustomer: (id: string) => fetch(`/api/customers/${id}`, { method: "GET" })
};
