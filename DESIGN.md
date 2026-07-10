# Lilac Giveaway Bot Design System

## Direction

The physical scene is a moderator moving between Discord and a 27-inch dashboard during a live community event, while entrants inspect the same giveaway from phones in mixed lighting. The interface follows the operating-system color preference, uses dense but calm product layouts, and reserves expressive composition for the landing page.

## Color Strategy

Restrained product palette with a committed cobalt field in the marketing hero. Lilac is an identity cue, not a default background.

### Light

- Canvas: `oklch(0.975 0.008 275)`
- Surface: `oklch(0.995 0.004 275)`
- Raised: `oklch(0.956 0.012 275)`
- Ink: `oklch(0.225 0.025 275)`
- Muted ink: `oklch(0.49 0.025 275)`
- Line: `oklch(0.875 0.018 275)`
- Cobalt action: `oklch(0.56 0.2 265)`
- Lilac identity: `oklch(0.73 0.13 300)`
- Proof green: `oklch(0.69 0.16 148)`
- Warning: `oklch(0.76 0.14 80)`
- Danger: `oklch(0.61 0.2 25)`

### Dark

- Canvas: `oklch(0.17 0.018 275)`
- Surface: `oklch(0.205 0.02 275)`
- Raised: `oklch(0.245 0.024 275)`
- Ink: `oklch(0.93 0.012 275)`
- Muted ink: `oklch(0.7 0.024 275)`
- Line: `oklch(0.34 0.028 275)`
- Cobalt action: `oklch(0.69 0.16 265)`
- Lilac identity: `oklch(0.78 0.11 300)`
- Proof green: `oklch(0.74 0.15 148)`
- Warning: `oklch(0.8 0.13 80)`
- Danger: `oklch(0.7 0.17 25)`

## Typography

- Product UI: IBM Plex Sans, weights 400, 500, 600, and 700.
- Marketing display only: Bricolage Grotesque, weights 600 and 700.
- Identifiers, hashes, timestamps, and code: IBM Plex Mono.
- Body prose is capped at 70 characters.
- Product type scale: 0.75rem, 0.875rem, 1rem, 1.125rem, 1.375rem, 1.75rem.

## Layout

- Desktop app shell: 248-pixel sidebar, flexible content, 72-pixel top bar.
- Public pages: 1180-pixel maximum reading frame with proof data allowed to span wider.
- Mobile: single-column flow, sticky bottom action region only where an action is primary.
- Spacing rhythm: 4, 8, 12, 16, 24, 32, 48, 72 pixels.
- Border radius: 8 pixels for controls, 12 pixels for grouped sections, pill only for compact status.

## Components

- Buttons use one vocabulary: solid primary, outlined secondary, quiet text, and destructive.
- Status is always text plus a dot or icon; never color alone.
- Grouped sections use a shared surface and dividers rather than nested cards.
- Tables collapse into labeled rows on narrow screens.
- Proof values use monospaced wrap-anywhere blocks with copy-friendly selection.
- Empty states explain the next Discord command or dashboard action.
- Charts use direct labels and CSS/SVG primitives, not unexplained legends.

## Motion

- State transitions: 180 milliseconds with `cubic-bezier(0.22, 1, 0.36, 1)`.
- Landing reveal: one 420-millisecond opacity and transform transition.
- No decorative loops, bounce, layout-property animation, or dashboard entrance sequence.
- `prefers-reduced-motion` removes all nonessential transforms.

## Voice

Use plain operational language: "Draw committed", "Waiting for drand round 123", and "3 entries excluded". Avoid hype, gambling terminology, vague fairness claims, and anthropomorphic bot copy.
