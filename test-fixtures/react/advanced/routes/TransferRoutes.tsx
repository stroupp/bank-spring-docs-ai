import { Route } from "react-router-dom";
import { RoleGuard } from "../components/RoleGuard";
import { TransferDetailPage } from "../pages/TransferDetailPage";

export function TransferRoutes() {
  return (
    <Route
      path="/transfers/:id"
      element={
        <RoleGuard roles={["MAKER", "CHECKER"]}>
          <TransferDetailPage />
        </RoleGuard>
      }
    />
  );
}
