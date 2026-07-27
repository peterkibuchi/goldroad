import { createFileRoute } from "@tanstack/react-router";

import {
  DocumentArticle,
  DocumentNotFound,
  documentHead,
  loadDocument,
} from "~/components/document-article";

/**
 * v0 reader URL — kept alive: early records carry
 * `path: /p/<ident>/<rkey>`, composing here. The canonical composed URL is
 * now /@<ident>/<rkey> (see routes/@{$handle}.$rkey.tsx).
 */
export const Route = createFileRoute("/p/$handle/$rkey")({
  loader: ({ params }) => loadDocument(params.handle, params.rkey),
  head: ({ loaderData }) => documentHead(loaderData),
  component: DocumentPage,
  notFoundComponent: DocumentNotFound,
});

function DocumentPage() {
  const { doc, ident, publicationName, cover } = Route.useLoaderData();
  return (
    <DocumentArticle
      cover={cover}
      doc={doc}
      ident={ident}
      publicationName={publicationName}
    />
  );
}
