/**
 * Inline notice for writer surfaces — Pressroom register. `info` speaks in
 * ink; `alert` is the page's vermillion moment (errors earn the accent).
 * A <div>, not a <p>: notices may contain <form>s (announce, re-connect),
 * and the HTML parser hoists a form out of a <p>, breaking the border.
 */
export function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "alert";
}) {
  return (
    <div
      className={
        tone === "alert"
          ? "mt-6 border border-spot px-4 py-3 font-display text-sm text-spot leading-relaxed"
          : "mt-6 border border-ink px-4 py-3 font-display text-ink text-sm leading-relaxed"
      }
      role={tone === "alert" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
