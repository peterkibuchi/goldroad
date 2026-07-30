import { createFileRoute } from "@tanstack/react-router";

import {
  DocumentArticle,
  DocumentNotFound,
  documentHead,
  loadDocument,
} from "~/components/document-article";

/**
 * Canonical composed document URL: publication.url (…/@<ident>) + document
 * .path (/<rkey>) — see site.standard.publication's url doc. Records whose
 * path is /<rkey> (the current era) compose here.
 */
export const Route = createFileRoute("/@{$handle}/$rkey")({
  loader: ({ params }) => loadDocument(params.handle, params.rkey),
  head: ({ loaderData }) => documentHead(loaderData),
  component: DocumentPage,
  notFoundComponent: DocumentNotFound,
});

function DocumentPage() {
  // Spread, not a hand-picked list: loadDocument returns exactly the facts the
  // article renders, and enumerating them here let four of them (engagement,
  // related posts, the publication icon and description) go quietly missing —
  // loaded on every request, never rendered. The extra keys the article
  // doesn't take (atUri, canonicalUrl — the head's business) are ignored.
  return <DocumentArticle {...Route.useLoaderData()} />;
}
