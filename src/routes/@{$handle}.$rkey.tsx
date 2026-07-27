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
  const { doc, ident, publicationName, cover, mirror } = Route.useLoaderData();
  return (
    <DocumentArticle
      cover={cover}
      doc={doc}
      ident={ident}
      mirror={mirror}
      publicationName={publicationName}
    />
  );
}
