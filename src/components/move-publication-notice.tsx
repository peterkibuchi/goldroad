/**
 * One-click publication migration affordance, shown on /settings and
 * /dashboard while the writer's publication.url still points at a legacy
 * origin (goldroad.kibuchi.workers.dev). Posts intent=migrate to the single
 * write path — putRecord rewriting the publication's `url` only.
 */
export function MovePublicationNotice({
  returnTo,
}: {
  returnTo: "settings" | "dashboard";
}) {
  return (
    <div
      className="mt-6 border border-ink px-4 py-3 font-display text-ink text-sm"
      role="status"
    >
      <p>
        Your publication address still points at your old Goldroad home.
        Goldroad now lives at trygoldroad.com — moving updates the address in
        your own repo; your posts and old links keep working.
      </p>
      <form action="/api/publish" className="mt-2" method="post">
        <input name="intent" type="hidden" value="migrate" />
        <input name="returnTo" type="hidden" value={returnTo} />
        <button
          className="cursor-pointer font-bold underline underline-offset-2"
          type="submit"
        >
          Move publication to trygoldroad.com
        </button>
      </form>
    </div>
  );
}
