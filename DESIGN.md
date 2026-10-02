---
name: DeployGuard
description: The release ledger. Is it live, what changed, whose problem it is, and the one next action.
colors:
  paper-ground: "#f6f6f4"
  paper-sunken: "#efefec"
  paper-surface: "#ffffff"
  paper-surface-2: "#f3f3f0"
  paper-surface-hover: "#ecece8"
  paper-line: "#e2e2dd"
  paper-line-strong: "#cbcbc5"
  paper-ink: "#151618"
  paper-ink-2: "#464a50"
  paper-ink-3: "#686c73"
  paper-signal-blue: "#1d63d8"
  paper-ok: "#157a42"
  paper-warn: "#9a5b00"
  paper-bad: "#c42b2b"
  graphite-ground: "#0e0f11"
  graphite-sunken: "#0a0b0c"
  graphite-surface: "#15171a"
  graphite-surface-2: "#1b1e22"
  graphite-surface-hover: "#22252a"
  graphite-line: "#262a30"
  graphite-line-strong: "#363b42"
  graphite-ink: "#edeef0"
  graphite-ink-2: "#b6bac1"
  graphite-ink-3: "#8d929b"
  graphite-signal-blue: "#6aa5ff"
  graphite-ok: "#4ad386"
  graphite-warn: "#f0bd4f"
  graphite-bad: "#f37575"
typography:
  display:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 5.2vw, 4.25rem)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  state:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "\"ss01\", \"cv11\""
  control:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 550
    lineHeight: 1
  label:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 550
    lineHeight: 1.55
  identifier:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "20px"
  s-6: "24px"
  s-8: "32px"
  s-10: "40px"
  s-12: "48px"
  s-16: "64px"
  gutter: "24px"
  content-max: "1200px"
components:
  button-primary:
    backgroundColor: "{colors.paper-ink}"
    textColor: "{colors.paper-surface}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-primary-dark:
    backgroundColor: "{colors.graphite-ink}"
    textColor: "{colors.graphite-ground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.paper-surface-2}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.paper-surface-hover}"
  button-ghost:
    textColor: "{colors.paper-ink-2}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-danger:
    textColor: "{colors.paper-bad}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-danger-solid:
    backgroundColor: "{colors.paper-bad}"
    textColor: "{colors.paper-surface}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-sm:
    typography: "{typography.label}"
    padding: "0 12px"
    height: "30px"
  input:
    backgroundColor: "{colors.paper-sunken}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "7px 11px"
    height: "36px"
  dialog:
    backgroundColor: "{colors.paper-surface}"
    rounded: "{rounded.lg}"
    padding: "24px"
    width: "520px"
  drawer:
    backgroundColor: "{colors.paper-surface}"
    width: "520px"
  code-block:
    backgroundColor: "{colors.paper-surface-2}"
    textColor: "{colors.paper-ink-2}"
    typography: "{typography.identifier}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  header-tab:
    textColor: "{colors.paper-ink-3}"
    typography: "{typography.control}"
    padding: "10px 12px 12px"
  header-tab-active:
    textColor: "{colors.paper-ink}"
---

# Design System: DeployGuard

## Overview

**Creative North Star: "The Release Ledger"**

Every screen opens with one plain-language state sentence and anchors it to exact evidence one disclosure deeper: the commit, the image, the run. The page reads like a ledger, not a dashboard. Content sits directly on a neutral ground (paper in light, graphite in dark) in sections divided by a single hairline at the top, with grouped rows beneath. The card-grid dashboard and the status-chip confetti common to deployment tools are refused.

The ground follows the operating-system preference by default; the account menu carries a three-way theme override (System, Light, Dark) that sets `data-theme` on the root. Both themes are defined token for token, so nothing is styled for one theme only. Density is calm-operational: 15px body, 36px controls, 32px between sections, generous whitespace around one state statement per page.

Colour is spent on state and nothing else. One blue signal marks focus, links and work in progress; green, amber and red appear only for verified state. The primary action is inverted ink (black on paper, near-white on graphite), so the strongest object on the page is the next action, not a brand colour.

This direction was chosen by the designer and recorded in the surface brief (`.impeccable/surfaces/frontend-src.md`). The Impeccable concept-seed roll was not run for this redesign (seed key: none): the product owner forbade option rounds.

**Key Characteristics:**
- Hairline-ruled sections (top rule only) instead of boxes.
- Boxes only for genuine containment: dialogs, drawers, the topology diagram, the log viewer, code, the danger zone and repeated service editors.
- Colour carries state only (ok, warn, bad, info, neutral); blue for focus, links and in-progress.
- Inverted-ink primary button; 8px control radius.
- Geist for reading; Geist Mono only for identifiers.
- Status is a dot plus a word.
- Irreversible destructive actions sit behind a typed-phrase confirmation.

## Colors

Two neutral grounds, one blue signal, three state colours, and no decorative hue.

### Primary
- **Signal Blue** (paper-signal-blue / graphite-signal-blue): focus rings, inline links, in-progress state ("Deploying", running phase rail, progress meters), chart lines, selected caret. Doubles as the `info` tone. Never a fill for a primary button and never decoration.

### Neutral
- **Paper Ground / Graphite Ground** (paper-ground / graphite-ground): the page itself. Content sits here directly.
- **Sunken** (paper-sunken / graphite-sunken): input wells and code backgrounds in dark; the recessed tier.
- **Surface** (paper-surface / graphite-surface): the inside of real containers only (dialogs, drawers, menus, toasts, topology, contained boxes).
- **Surface 2 / Surface Hover** (paper-surface-2, paper-surface-hover and graphite equivalents): row hover, segmented-control track, secondary button fill, inline code chip.
- **Line / Line Strong** (paper-line, paper-line-strong and graphite equivalents): the hairline that rules every section and row (line); control borders, dialog borders, scrollbars (line strong).
- **Ink, Ink 2, Ink 3** (paper-ink / -2 / -3, graphite-ink / -2 / -3): primary text and the primary button fill; secondary copy and sentences; labels, meta, timestamps, inactive tabs.

### State tones
Each state tone has a matching soft tint at 9 to 16 percent opacity (`--ok-soft`, `--warn-soft`, `--bad-soft`, `--info-soft`, `--neutral-soft`) used for callout fills and danger-button hover.
- **Verified Green** (paper-ok / graphite-ok): Live, Succeeded, passed phases.
- **Caution Amber** (paper-warn / graphite-warn): attention needed while still serving (for example a failed latest attempt on a live release).
- **Failure Red** (paper-bad / graphite-bad): Failed, destructive buttons, the danger-zone border, field errors, the tab dot that flags a failure.
- **Neutral** (the ink-3 value): Ready, Destroyed, Unknown, and anything unverified.
- An AWS orange (`--aws`: #b86e00 paper, #f5a524 graphite) exists for provider attribution only.

### Named Rules
**The State-Only Colour Rule.** Hue appears only to say ok, warn, bad, info or neutral. If a coloured element does not report state, focus, a link or progress, it is grey.

**The Unverified Is Grey Rule.** Green, amber and red are reserved for verified state. Anything the system cannot confirm renders in the neutral tone with the word that says so.

**The Inverted Ink Rule.** The primary button is ink on ground, inverted (ink fill, ground-coloured text). Blue never fills a primary button.

## Typography

**Body Font:** Geist (with Inter, system-ui fallback), loaded at weights 300 to 800, with stylistic sets `ss01` and `cv11` on.
**Identifier Font:** Geist Mono (with ui-monospace, SFMono-Regular, Menlo fallback), weights 400 to 600.

**Character:** A single humanist-grotesk family carries every word a person reads; the mono appears only where an exact machine value must be copied or compared.

### Hierarchy
- **Display** (700, clamp(2.5rem, 5.2vw, 4.25rem), 1.02, -0.035em): public landing hero only. About and section heads on public pages step down through clamp(1.6rem to 3.6rem).
- **Headline** (650, 1.75rem / 28px, -0.02em): page titles (project name, "Projects", sign-in heading).
- **State** (650, 1.375rem / 22px, -0.015em): the state statement ("Live", "Failed"), dialog titles, monitoring headline values.
- **Title** (600, 1.0625rem / 17px): section headings such as "Current release" and "Services"; the public URL on Overview.
- **Body** (400, 0.9375rem / 15px, 1.55): sentences; capped at 68 to 72ch.
- **Control** (550, 0.875rem / 14px): buttons, tabs, fields, table cells, secondary copy.
- **Label** (550 or 400, 0.8125rem / 13px): meta, table headers, fact labels, timestamps, hints.
- **Identifier** (Geist Mono, 0.8125rem / ~0.9em inline): commits, digests, run IDs, resource names, directories, log lines, the confirmation phrase.

Numbers in tables, times and `.num` cells use tabular numerals.

### Named Rules
**The Identifier Rule.** Geist Mono is for identifiers only: commits, digests, run IDs, resource names, paths and logs. Labels, numbers in prose, and headings are never mono.

**The Sentence First Rule.** Every page leads with a plain-language state sentence at reading size; evidence (IDs, codes) sits below it or one disclosure deeper.

## Layout

A single centred column, max 1200px (880px for narrow pages), with a 24px gutter that drops to 16px under 720px. Pages stack sections with 32px between them and 64px of bottom padding; sections use a 16px internal gap. Spacing runs on a 4px grid (4, 8, 12, 16, 20, 24, 32, 40, 48, 64).

The shell is one sticky header: a 56px bar with the breadcrumb scope (brand / Projects / project, with a status word) and the account avatar, and the tab row beneath it. The header ground is 88 percent ground with a 10px backdrop blur and a bottom hairline.

Information architecture, one owner per fact:
- **Projects**: an attention-first list; one row per project (status word, identity, inline reason only when attention is needed, time, chevron).
- **Overview**: current state (status line, sentence, public URL, primary action), then a two-column ledger of current release and services, then a one-line pointer to the latest attempt.
- **Deployments** (route `/pipeline`): the attempts record; stages, history and raw run evidence. Links to Troubleshoot rather than repeating diagnosis.
- **Troubleshoot**: diagnosis, ownership, fix steps, recovery action, AI analysis and evidence.
- **Infrastructure**: topology with an inspector, cost estimate and identifiers.
- **Monitoring**: stat row, charts whose current value sits in the chart heading, and the live log viewer.
- **Settings**: a 200px section list beside one section at a time (configuration), with the danger zone last. Settings is the only place Destroy lives.
- **Admin**: overview, users, projects, audit and cloud cleanup as header tabs.

Responsive: under 900px Settings' side list becomes a tab row and project rows collapse to identity, state and chevron with the reason beneath; under 720px tables stack into labelled rows and the monitoring stat row becomes 2 by 2; under 640px the header tab row scrolls with a fade mask and the brand word hides.

### Named Rules
**The Top Rule Rule.** A ruled section draws only its top hairline (1px line), so adjacent sections never double up. Rows inside a group are separated by the same hairline.

**The One Owner Rule.** Each fact has exactly one page that owns it; other pages link to it rather than restating it.

## Elevation & Depth

Flat by default. Depth on the page is carried by hairlines and the ground/surface tonal step, not shadows. A single pop shadow (`--shadow-pop`) is reserved for floating layers: menus, dialogs, drawers, toasts and the landing hero window. Overlays dim the page with a scrim (66 percent graphite / 40 percent ink) and a 2px blur. Small functional rings exist: the status dot's 3px tinted halo, the 3px accent-soft focus ring on fields, and the 1px line ring on the selected segment.

### Shadow Vocabulary
- **Pop, paper** (`box-shadow: 0 12px 32px rgba(20,21,24,0.14), 0 2px 6px rgba(20,21,24,0.08)`): floating layers in light.
- **Pop, graphite** (`box-shadow: 0 12px 32px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.35)`): floating layers in dark.
- **Field focus** (`box-shadow: 0 0 0 3px var(--accent-soft)` with accent border): focused inputs.

### Named Rules
**The Floating Only Rule.** Only things that float above the page cast a shadow. Nothing resting on the ground is lifted.

## Shapes

Gently rounded and consistent: 6px for small chips, focus outlines and tab corners; 8px for every control, callout, code block and hoverable row; 12px for containers (dialogs, menus, topology, log viewer, danger zone, empty states). Pills (999px) are reserved for meters, scroll thumbs and the few tone labels. Status dots and avatars are circles. Borders are 1px; the only dashed borders mark empty or not-yet-provisioned areas.

### Named Rules
**The Earned Box Rule.** A bordered box exists only for genuine containment: dialogs, drawers, the topology diagram, the log viewer, code, the danger zone and repeated service editors. Everything else is a ruled section on the ground.

## Components

### Buttons
Quiet, compact, one strong action per view.
- **Shape:** gently rounded (8px), 36px tall, 16px horizontal padding; small variant 30px and 13px text.
- **Primary:** inverted ink fill with ground-coloured text; hover deepens to pure black (paper) or white (graphite).
- **Secondary (default):** surface-2 fill, line-strong border, ink text; hover to surface-hover.
- **Ghost:** transparent, ink-2 text; hover to surface-2.
- **Danger:** transparent with red text and a 45 percent red border; hover tints bad-soft. **Danger solid:** red fill, white text, used only as the confirm button of a destructive dialog.
- **Link:** accent text, no padding, underline on hover.
- **States:** 1px press-down on active; disabled at 45 percent opacity; busy state replaces the label with a 14px spinner in the button's own text colour. Transitions are 120ms on a `cubic-bezier(0.22, 1, 0.36, 1)` ease-out.

### Status
The product's state signature.
- **Style:** an 8px dot in the tone colour with a 3px tinted halo, followed by the word in ink at 14px/550 ("Live", "Deploying", "Failed", "Ready", "Destroyed", "Blocked", "Unknown").
- **Active:** in-progress statuses pulse the halo every 1.6s.
- **Large:** the Overview state statement uses a 10px dot and 22px/650 text.
- The word comes from one shared vocabulary (`projectStateLabel`); failure ownership and retry language come from the shared failure presentation.

### Ruled sections and rows
- **Section:** title row (17px heading, optional count in ink-3, right-aligned link or action), then content under a top hairline.
- **Rows:** grouped lists with hairlines above and below and between items; hoverable rows bleed 12px left and right with an 8px-radius surface-2 hover.
- **Facts:** label/value pairs, labels in ink-3 at 13px, values in ink; the list form is a 200px label column with hairlines between rows.

### Inputs / Fields
- **Style:** sunken fill, 1px line-strong border, 8px radius, 36px tall, 14px text; label above at 14px/550, hint and error at 13px below.
- **Focus:** border turns accent with a 3px accent-soft ring.
- **Error / Disabled:** error text in red; disabled at 60 percent opacity. Textareas are mono for config values.

### Navigation
- **Header tabs:** 14px/500 ink-3 labels; hover and active go to ink; the active tab carries a 2px ink underline sitting on the header hairline. A 6px red dot flags a tab whose page holds a failure.
- **In-page tabs:** the same treatment over a bottom hairline. Settings uses a vertical variant with a surface-2 selected fill, and its last item (Danger zone) in red.
- **Segmented control:** surface-2 track with 1px line, 3px inset; the selected segment lifts to surface with a line ring; counts in ink-3.
- **Account menu:** avatar trigger opening a 12px-radius floating menu with identity, the System/Light/Dark theme switch, and links.

### Callouts
Tone-soft fill, 22 percent tone border, 8px radius, icon in the tone colour, title in ink and body in ink-2. Used for a state that needs explanation in place, never as decoration.

### Dialogs and drawers
- **Dialog:** 520px (640px wide) surface box, 12px radius, line-strong border, pop shadow, 24px padding, 22px title, actions right-aligned. Enters with a 180ms pop-in.
- **Drawer:** 520px right-hand panel, full height, sticky header with a hairline, slides in 24px.

### Typed-phrase confirmation (signature)
`ConfirmPhraseDialog` guards every irreversible destructive action (destroy infrastructure, admin cloud cleanup). The dialog states the consequence, asks the user to type an exact phrase shown in Geist Mono, and keeps the danger-solid confirm button disabled until the phrase matches. Cancel is a ghost button to its left. Reversible actions such as Archive use a plain confirm dialog with the same ghost Cancel and danger-solid confirm.

### Danger zone
The last section of Settings: a 12px-radius box with a red-tinted border (35 percent red into line), holding one row per destructive action (title, consequence sentence, danger button). Destroy infrastructure lives here and nowhere else.

### Evidence surfaces
- **Code block:** code background, 1px line, 8px radius, Geist Mono 13px at 1.65 leading, scrolls past 360px.
- **Log viewer:** a 12px-radius contained box on the code background, mono 13px lines at 1.7 leading, 160 to 460px tall.
- **Copy value:** a mono, ellipsised identifier with a small "Copy" text button.
- **Topology:** a contained 12px-radius diagram of nodes (8px radius, line-strong border) with a status dot; the selected node gains an ink ring and opens the inspector.

### Phase rail and meters
The deploy phase rail is a row of 3px bars: line-strong pending, green passed, red failed, amber attention, and an animated blue sweep on the running phase. Meters are 6px pills on surface-2.

## Do's and Don'ts

### Do:
- **Do** open every page with one plain-language state sentence, then put the commit, image and run one disclosure deeper.
- **Do** rule sections with a single top hairline (1px line) and keep content on the ground.
- **Do** render every status as a dot plus a word from the shared state vocabulary.
- **Do** use the inverted-ink primary button for the single next action on a view.
- **Do** set commits, digests, run IDs, resource names, paths and logs in Geist Mono, and everything else in Geist.
- **Do** put irreversible destructive actions behind `ConfirmPhraseDialog`, and keep Destroy only in the Settings danger zone.
- **Do** define every new colour in both the paper and graphite themes in `tokens.css`; components use tokens, never raw values.
- **Do** show unverified state in the neutral tone with words that say it is unverified.

### Don't:
- **Don't** build card-grid dashboards or box content that is not genuinely contained.
- **Don't** use status chips as the state signal; a pill label is for a role or plan name, not for state.
- **Don't** use green, amber or red for anything other than verified state, or blue for anything other than focus, links and in-progress.
- **Don't** fill a primary button with blue or any state colour.
- **Don't** use Geist Mono for labels, headings or numbers in prose.
- **Don't** cast shadows on anything resting on the page; the pop shadow is for floating layers.
- **Don't** repeat a fact on a page that does not own it; link to its owner.
