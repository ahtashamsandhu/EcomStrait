import type { Metadata } from "next";
import { createAdminClient } from "@ecomstrait/db/admin";
import type { UserRole } from "@ecomstrait/db/types";
import { getUser } from "@ecomstrait/auth/session";
import { RoleSelect } from "@/components/admin/role-select";
import { SearchBar } from "@/components/app/search-bar";
import { Pagination } from "@/components/app/pagination";
import { clampPage, pageSlice, parseTableParams, type RawParams } from "@/lib/table-params";

export const metadata: Metadata = { title: "Users — Admin" };

/** Accounts are read through the auth admin API, which has no search or
 *  server-side filter — so we page through it and filter in memory. This caps
 *  how far we'll walk; beyond it the list is truncated and says so. */
const AUTH_PER_PAGE = 200;
const AUTH_MAX_PAGES = 10;

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const { q, page: wanted, size } = parseTableParams(params);

  const client = createAdminClient();
  if (!client) return <p className="text-sm text-red-600">Server is not configured.</p>;

  const me = await getUser();

  // Emails live in auth.users → use the admin API, then merge roles from profiles.
  const authUsers: { id: string; email: string | undefined; user_metadata: Record<string, unknown> }[] = [];
  let truncated = false;
  for (let p = 1; p <= AUTH_MAX_PAGES; p++) {
    const { data } = await client.auth.admin.listUsers({ page: p, perPage: AUTH_PER_PAGE });
    const batch = data?.users ?? [];
    authUsers.push(
      ...batch.map((u) => ({ id: u.id, email: u.email, user_metadata: u.user_metadata ?? {} })),
    );
    if (batch.length < AUTH_PER_PAGE) break;
    if (p === AUTH_MAX_PAGES) truncated = true;
  }

  const { data: profiles } = await client.from("profiles").select("user_id, role, full_name");

  const roleById = new Map<string, UserRole>();
  const nameById = new Map<string, string | null>();
  (profiles ?? []).forEach((p) => {
    roleById.set(p.user_id, p.role);
    nameById.set(p.user_id, p.full_name);
  });

  const all = authUsers.map((u) => ({
    id: u.id,
    email: u.email ?? "—",
    name: nameById.get(u.id) ?? ((u.user_metadata?.full_name as string) || ""),
    role: roleById.get(u.id) ?? ("customer" as UserRole),
  }));

  const needle = q.toLowerCase();
  const filtered = needle
    ? all.filter(
        (u) =>
          u.email.toLowerCase().includes(needle) ||
          u.name.toLowerCase().includes(needle) ||
          u.role.toLowerCase().includes(needle),
      )
    : all;

  const total = filtered.length;
  const page = clampPage(wanted, total, size);
  const users = pageSlice(filtered, page, size);

  const summary =
    total > 0 ? `${(page - 1) * size + 1}–${(page - 1) * size + users.length} of ${total}` : undefined;

  return (
    <div>
      <h1 className="text-2xl font-bold text-ink-950">Users</h1>
      <p className="mt-1 text-sm text-ink-500">
        {all.length} account{all.length === 1 ? "" : "s"}. Change a role to grant access.
      </p>
      {truncated && (
        <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
          Showing the first {AUTH_PER_PAGE * AUTH_MAX_PAGES} accounts — search covers only these.
        </p>
      )}

      <div className="mt-6">
        <SearchBar placeholder="Search email, name, role…" summary={summary} />
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-ink-100 bg-white">
        {users.length === 0 ? (
          <p className="p-8 text-center text-sm text-ink-400">
            {q ? `No accounts match “${q}”.` : "No accounts yet."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-400">
                <th className="px-4 py-3 font-medium">User</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">Name</th>
                <th className="px-4 py-3 text-right font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-4 py-3 font-medium text-ink-900">
                    {u.email}
                    {me?.id === u.id && <span className="ml-2 text-xs text-ink-400">(you)</span>}
                  </td>
                  <td className="hidden px-4 py-3 text-ink-500 sm:table-cell">{u.name || "—"}</td>
                  <td className="px-4 py-3">
                    <RoleSelect userId={u.id} role={u.role} disabled={me?.id === u.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination basePath="/admin/users" params={params} page={page} total={total} size={size} />
    </div>
  );
}
