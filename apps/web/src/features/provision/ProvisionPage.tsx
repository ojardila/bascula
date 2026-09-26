/** `/preparando/:slug` — the public waiting page after creating a farm. */
import { useParams } from "react-router-dom";
import { AuthLayout } from "../auth/AuthLayout";
import { ProvisionProgress } from "./ProvisionProgress";

export function ProvisionPage() {
  const { slug = "" } = useParams();
  return (
    <AuthLayout title="Su finca nueva" wide>
      <ProvisionProgress slug={slug.toLowerCase()} redirectWhenReady />
    </AuthLayout>
  );
}
