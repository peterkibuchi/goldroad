/**
 * Cloudflare Turnstile widget, env-gated on VITE_PUBLIC_TURNSTILE_SITE_KEY.
 *
 * Without the sitekey the component renders nothing and loads nothing — the
 * forms that embed it behave byte-for-byte as before. With it, the Turnstile
 * script is loaded lazily (explicit-render mode, one script tag per page) and
 * the widget drops a hidden `turnstileToken` input into the surrounding form,
 * so the existing FormData-driven submit handlers pick the token up without
 * new state plumbing. Server side, /api/waitlist and /api/report verify that
 * token when TURNSTILE_SECRET is set (see ~/lib/turnstile).
 *
 * CSP note: challenges.cloudflare.com must be allowed in script-src and
 * frame-src for the widget to render — ~/lib/security-headers carries those
 * entries unconditionally (harmless while the widget is off).
 */
import { useEffect, useRef } from "react";

import { env } from "#/env";

/** The FormData/JSON field the widget writes its token into. */
export const TURNSTILE_TOKEN_FIELD = "turnstileToken";

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (
    container: HTMLElement,
    params: Record<string, unknown>,
  ) => string | undefined;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi | null> | null = null;

/** Widget ids currently rendered on the page (one per form in practice). */
const activeWidgets = new Set<string>();

/**
 * Re-arms every mounted widget with a fresh challenge. Turnstile tokens are
 * SINGLE-USE: once a submit reached the server, siteverify consumed the
 * token — so a failed submission must reset the widget, or every retry
 * resends the same dead token and the user is stranded until a reload.
 * Forms call this from their error paths.
 */
export function resetTurnstileWidgets(): void {
  if (typeof window === "undefined") return;
  const turnstile = window.turnstile;
  if (!turnstile) return;
  for (const id of activeWidgets) {
    try {
      turnstile.reset(id);
    } catch {
      // A widget removed mid-flight is fine — nothing to re-arm.
    }
  }
}

/** Injects the Turnstile script once and resolves with its API (null on
 * load failure — the widget simply doesn't render, the form still submits;
 * the server then rejects if it requires a token). */
function loadTurnstile(): Promise<TurnstileApi | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve(window.turnstile ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Drop-in widget for a <form>. Renders nothing when the sitekey env var is
 * absent; otherwise mounts the challenge and maintains the hidden token input
 * named TURNSTILE_TOKEN_FIELD inside this element (i.e. inside the form).
 */
export function TurnstileWidget() {
  const sitekey = env.VITE_PUBLIC_TURNSTILE_SITE_KEY;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!sitekey || !container) return;
    let widgetId: string | undefined;
    let cancelled = false;
    void loadTurnstile().then((turnstile) => {
      if (!turnstile || cancelled) return;
      widgetId = turnstile.render(container, {
        sitekey,
        // Name the auto-injected hidden input after our own field so the
        // submit handlers read it straight out of FormData.
        "response-field-name": TURNSTILE_TOKEN_FIELD,
      });
      if (widgetId !== undefined) activeWidgets.add(widgetId);
    });
    return () => {
      cancelled = true;
      if (widgetId !== undefined) {
        activeWidgets.delete(widgetId);
        window.turnstile?.remove(widgetId);
      }
    };
    // sitekey is a build-time constant (t3-env), not a reactive dependency.
  }, []);

  if (!sitekey) return null;
  return <div className="basis-full" ref={containerRef} />;
}
