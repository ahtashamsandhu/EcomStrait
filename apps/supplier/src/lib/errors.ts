import "server-only";

type DbError = { code?: string; message?: string } | null | undefined;

/**
 * Turn a Postgres/PostgREST error into something safe to show a user.
 *
 * Raw messages name tables, columns and constraints ("duplicate key value
 * violates unique constraint products_sku_key"), which is internal detail
 * nobody outside the team should see. Our own triggers raise with plain
 * English on purpose, so those pass through; everything else is logged
 * server-side and replaced with a generic line.
 */
export function friendlyError(error: DbError, fallback = "Something went wrong. Please try again."): string {
  if (!error) return fallback;
  const msg = error.message ?? "";
  const internal = /violates|relation|column|constraint|syntax|permission denied for/i.test(msg);
  if (!internal && msg && msg.length <= 200) return msg;
  console.error("[db]", error.code, msg);
  switch (error.code) {
    case "23505":
      return "That already exists.";
    case "23514":
      return "Some of those values are out of range.";
    case "42501":
      return "You don't have permission to do that.";
    default:
      return fallback;
  }
}
