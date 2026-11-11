import { AdminPage } from "@/components/admin/AdminPage";

// Rendered inside the (app) shell; the API returns 404 for non-admins and the page shows "Not found".
export default function Admin() {
  return <AdminPage />;
}
