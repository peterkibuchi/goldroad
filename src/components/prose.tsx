import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Calm-register markdown renderer for reader surfaces.
 *
 * Safety: NO rehype-raw and NO dangerouslySetInnerHTML — raw HTML inside
 * markdown stays inert (react-markdown drops it; it never becomes elements),
 * and react-markdown's default urlTransform strips javascript: URLs.
 * Plain prose is valid markdown, so third-party plaintext records render
 * correctly through the same path.
 *
 * Headings are shifted down one level (# → h2) — the document title owns h1.
 */

/** react-markdown passes the hast `node` alongside DOM props — drop it. */
function strip<P extends { node?: unknown }>(props: P): Omit<P, "node"> {
  const { node: _node, ...rest } = props;
  return rest;
}

const components: Components = {
  h1: (p) => (
    <h2
      className="mt-10 text-balance font-semibold text-2xl leading-snug"
      {...strip(p)}
    />
  ),
  h2: (p) => (
    <h3
      className="mt-8 text-balance font-semibold text-xl leading-snug"
      {...strip(p)}
    />
  ),
  h3: (p) => <h4 className="mt-6 font-semibold text-lg" {...strip(p)} />,
  h4: (p) => <h5 className="mt-6 font-semibold" {...strip(p)} />,
  h5: (p) => <h6 className="mt-6 font-semibold" {...strip(p)} />,
  h6: (p) => <h6 className="mt-6 font-semibold text-base" {...strip(p)} />,
  p: (p) => <p className="mt-5 first:mt-0" {...strip(p)} />,
  a: (p) => (
    <a
      className="underline decoration-ink/30 underline-offset-2 transition-colors hover:decoration-ink"
      // Writer-supplied links: no referrer, no window.opener, no SEO endorsement.
      rel="nofollow noopener noreferrer"
      {...strip(p)}
    />
  ),
  ul: (p) => <ul className="mt-5 list-disc space-y-2 pl-6" {...strip(p)} />,
  ol: (p) => <ol className="mt-5 list-decimal space-y-2 pl-6" {...strip(p)} />,
  li: (p) => <li className="pl-1" {...strip(p)} />,
  blockquote: (p) => (
    <blockquote
      className="mt-5 border-rule border-l-2 pl-5 text-ink-soft italic"
      {...strip(p)}
    />
  ),
  code: (p) => (
    <code
      className="rounded-none bg-ink/5 px-1 font-mono text-[0.9em]"
      {...strip(p)}
    />
  ),
  pre: (p) => (
    <pre
      className="mt-5 overflow-x-auto bg-ink/5 p-4 font-mono text-sm [&>code]:bg-transparent [&>code]:p-0"
      {...strip(p)}
    />
  ),
  hr: (p) => <hr className="mt-8 border-rule border-t" {...strip(p)} />,
  img: (p) => (
    // biome-ignore lint/a11y/useAltText: alt comes from the markdown source when present
    <img className="mt-5 max-w-full" loading="lazy" {...strip(p)} />
  ),
  table: (p) => (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full border-collapse text-base" {...strip(p)} />
    </div>
  ),
  th: (p) => (
    <th
      className="border-rule border-b py-2 pr-4 text-left font-semibold"
      {...strip(p)}
    />
  ),
  td: (p) => <td className="border-rule border-b py-2 pr-4" {...strip(p)} />,
};

export function Prose({ markdown }: { markdown: string }) {
  return (
    <div className="text-lg leading-relaxed">
      <Markdown components={components} remarkPlugins={[remarkGfm]}>
        {markdown}
      </Markdown>
    </div>
  );
}
