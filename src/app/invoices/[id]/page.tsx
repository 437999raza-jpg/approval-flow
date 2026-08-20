import { redirect } from "next/navigation";

export default function InvoiceDetailRedirect({ params }: { params: { id: string } }) {
  redirect(`/dashboard/${params.id}`);
}
