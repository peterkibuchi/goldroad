/**
 * A route's page component, for a test that renders the page. Route files
 * export only `Route`: TanStack's code splitter can't move an exported
 * component into the route's lazy chunk, so an exported page ships in every
 * page's main bundle.
 */
import type { ComponentType } from "react";

export function routeComponent(route: {
  options: { component?: unknown };
}): ComponentType {
  const component = route.options.component;
  if (!component) throw new Error("this route has no component");
  return component as ComponentType;
}
