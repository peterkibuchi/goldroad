import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";

import type { ReaderTypeKind as Kind } from "~/lib/appearance";

/**
 * The reader's text size and typeface, opened from "Text options" at the foot
 * of a post. Loaded when a reader first opens it, never with the page.
 *
 * Two radio groups of native radio buttons, styled as the segmented control
 * the appearance setting uses. Native on purpose: the browser already does the
 * whole APG radio group (Tab into the checked option, arrow keys to move and
 * choose, Space to choose), and a hand-rolled one would have to rebuild all of
 * it. Each choice applies at once, so the reader sees the page change under
 * them rather than guessing from a label.
 *
 * Escape closes the panel and hands focus back to the button that opened it
 * (`onClose`), the same as clicking that button again.
 */
export function ReaderTypePanel({
  id,
  onClose,
  remember,
}: {
  id: string;
  onClose: () => void;
  /** Applies and stores a choice (setReaderType in ~/lib/appearance). Passed
   * in rather than imported, so this chunk shares no module with the page. */
  remember: (kind: Kind, value: string) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => current("readerSize"));
  const [face, setFace] = useState(() => current("readerFace"));

  // A reader who opens the panel at the foot of the page should see it.
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  function choose(kind: Kind, value: string) {
    remember(kind, value);
    if (kind === "readerSize") setSize(value);
    else setFace(value);
    // A new size moves everything above the panel; keep it under the reader.
    panel.current?.scrollIntoView?.({ block: "nearest" });
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside closes the panel; its controls are the radios, which take the keys themselves
    <div
      className="mt-5 grid max-w-md gap-5 font-display text-sm text-ink"
      id={id}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      ref={panel}
    >
      <Choice
        kind="readerSize"
        legend="Text size"
        onChoose={choose}
        options={SIZES}
        value={size}
      />
      <Choice
        kind="readerFace"
        legend="Typeface"
        onChoose={choose}
        options={FACES}
        value={face}
      />
    </div>
  );
}

type Option = { value: string; label: string; className?: string };

/** "" is the page as published: no attribute and nothing stored. */
const SIZES: Option[] = [
  { value: "", label: "Standard" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
  { value: "largest", label: "Largest" },
];
const FACES: Option[] = [
  { value: "", label: "As published", className: "font-body" },
  // Shown in its own face, so the reader sees what they would get.
  {
    value: "readable",
    label: "Atkinson Hyperlegible",
    className: "font-readable",
  },
];

/** What is painted now, off the attribute the bootstrap set. An unknown
 * stored value styles nothing, so it reads as the default here too. */
function current(kind: Kind): string {
  const value = document.documentElement.dataset[kind] ?? "";
  const options = kind === "readerSize" ? SIZES : FACES;
  return options.some((option) => option.value === value) ? value : "";
}

function Choice({
  kind,
  legend,
  options,
  value,
  onChoose,
}: {
  kind: Kind;
  legend: string;
  options: Option[];
  value: string;
  onChoose: (kind: Kind, value: string) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-soft uppercase">
        {legend}
      </legend>
      <div className="flex divide-x divide-ink border border-ink">
        {options.map((option) => (
          <label
            className={clsx(
              "inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center px-3 text-center leading-tight transition-colors hover:bg-ink/5",
              // Checked and focused come from the radio inside, which is
              // visually hidden but still the control.
              "has-[:checked]:bg-ink has-[:checked]:font-bold has-[:checked]:text-paper",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-4 has-[:focus-visible]:outline-spot",
              option.className,
            )}
            key={option.value}
          >
            <input
              checked={value === option.value}
              className="sr-only"
              name={kind}
              onChange={() => onChoose(kind, option.value)}
              type="radio"
              value={option.value}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
