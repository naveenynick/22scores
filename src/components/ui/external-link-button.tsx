import { Button } from "@/components/ui/button";
import type { ExternalEventLink } from "@/lib/external-links";
import { cn } from "@/lib/utils";

/**
 * Button-shaped link out to the provider page an event came from.
 *
 * Always `target="_blank"` with `rel="noopener noreferrer"`: the destination is
 * another site, so neither a handle on this window nor the reader's referrer
 * needs to travel with them.
 *
 * The accessible name is supplied whole rather than read off the button text,
 * because "Watch now" does not say where it goes or that the page changes. The
 * arrow is decorative for the same reason.
 *
 * Sport-agnostic: it renders whatever `resolveExternalEventLink` already
 * validated and worded.
 */
export function ExternalEventLinkButton({
  link,
  className,
}: {
  link: ExternalEventLink;
  className?: string;
}) {
  return (
    <Button
      asChild
      size="sm"
      // Live actions are the one thing on a card worth pulling the eye, so they
      // are filled; a finished game gets the quieter outline.
      variant={link.isLive ? "default" : "outline"}
      className={cn("shrink-0 gap-1.5 font-semibold", className)}
    >
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={link.accessibleLabel}
      >
        {link.label}
        <ExternalArrow />
      </a>
    </Button>
  );
}

/**
 * Decorative "leaves this site" arrow. Drawn rather than typed: U+2197 falls
 * through to the emoji font on Windows and renders in colour.
 */
function ExternalArrow() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </svg>
  );
}
