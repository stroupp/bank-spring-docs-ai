import { Route, Routes } from "react-router-dom";
import { CustomerSearchPage } from "../pages/CustomerSearchPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/customers/search" element={<CustomerSearchPage />} />
    </Routes>
  );
}

export const routeDefinitions = [
  { path: "/customers/:id", element: <CustomerSearchPage /> }
];
