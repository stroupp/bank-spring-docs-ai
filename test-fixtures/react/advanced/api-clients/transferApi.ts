import { API_PATHS as PATHS } from "../config/apiPaths";
import { bankRequest } from "./bankRequest";

export const transferApi = {
  search: (customerId: string, status: string) => bankRequest({
    method: "GET",
    path: `${PATHS.transfers}/${customerId}?status=${status}`,
    headers: actorHeaders
  }),
  approve: (transferId: string, actorId: string) => bankingClient.post(
    `${PATHS.transfers}/${transferId}/approve`,
    { actorId },
    { headers: { "X-Actor-Id": actorId } }
  ),
  cancel: (transferId: string) => bankRequest("DELETE", `${PATHS.transfers}/${transferId}`)
};
