"use client";

// Only rendered when the signed-in user has more than one organization_members
// row (in practice, just the platform admin's support access — see
// createOrganizationAction/joinOrganizationAction). Submits immediately on
// change since switching orgs is a full navigation, not a value to save.
export function OrgSwitcher({
  orgs,
  currentOrgId,
  action,
}: {
  orgs: { id: string; name: string }[];
  currentOrgId: string;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <select
        name="org_id"
        defaultValue={currentOrgId}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        title="Switch organization"
        className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 focus:border-blue-500 focus:outline-none"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </form>
  );
}
