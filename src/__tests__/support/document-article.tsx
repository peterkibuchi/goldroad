/**
 * The article as the reader routes render it: `loadDocument` renders the body
 * once and hands it over as `bodyHtml`. The suites pass a `doc` and let this
 * render its body the same way, so a test reads like the page it checks.
 */
import type { ComponentProps } from "react";

import { DocumentArticle as Article } from "#/components/document-article";
import { documentBodyMarkdown } from "#/lib/document-content";
import { markdownToHtml } from "#/lib/markdown-html";

type Props = ComponentProps<typeof Article>;

export function DocumentArticle({
  bodyHtml,
  ...props
}: Omit<Props, "bodyHtml"> & { bodyHtml?: string }) {
  return (
    <Article
      {...props}
      bodyHtml={
        bodyHtml ??
        markdownToHtml(documentBodyMarkdown(props.doc), { embeds: true })
      }
    />
  );
}
