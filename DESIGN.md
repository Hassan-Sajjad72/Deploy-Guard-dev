---
name: DeployGuard
description: A quiet graphite control plane for deployment architecture and operational evidence.
colors:
  primary: "#F97316"
  primary-hover: "#FB8A3C"
  primary-ink: "#FB923C"
  primary-soft: "rgba(249, 115, 22, 0.12)"
  primary-line: "rgba(249, 115, 22, 0.32)"
  on-primary: "#160A02"
  canvas: "#0B0D12"
  recessed: "#0F1117"
  surface: "#12151C"
  raised: "#171A22"
  surface-strong: "#1A1E27"
  surface-hover: "#202530"
  line: "rgba(255, 255, 255, 0.08)"
  line-strong: "rgba(255, 255, 255, 0.14)"
  ink: "#EDEFF3"
  ink-secondary: "#B6BDC9"
  muted: "#9AA3B2"
  faint: "#8992A1"
  success: "#4ADE80"
  success-fill: "#22C55E"
  success-soft: "rgba(34, 197, 94, 0.12)"
  warning: "#FACC15"
  warning-fill: "#EAB308"
  warning-soft: "rgba(234, 179, 8, 0.12)"
  danger: "#F87171"
  danger-fill: "#EF4444"
  danger-soft: "rgba(239, 68, 68, 0.12)"
  info: "#93C5FD"
  info-fill: "#3B82F6"
  info-soft: "rgba(59, 130, 246, 0.12)"
typography:
  display:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.8rem, 5.5vw, 5rem)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 4vw, 3.45rem)"
    fontWeight: 650
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.7rem, 2.6vw, 2.2rem)"
    fontWeight: 650
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Geist, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "-0.003em"
  label:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.68rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.06em"
rounded:
  xs: "6px"
  sm: "8px"
  tabs: "10px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "40px"
  "8": "56px"
  "9": "64px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
    height: "38px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
    height: "38px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "20px"
  input:
    backgroundColor: "{colors.recessed}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    height: "38px"
  status-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "4px 9px 4px 8px"
  status-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
    padding: "4px 9px 4px 8px"
  status-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: "4px 9px 4px 8px"
  status-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info}"
    rounded: "{rounded.pill}"
    padding: "4px 9px 4px 8px"
---

# Design System: DeployGuard

## Overview

**Creative North Star: "The Quiet Control Plane"**

DeployGuard is a calm, dense operational interface built from graphite surfaces, restrained borders, and one orange product signal. The visual system should feel like a dependable control room: exact without becoming sterile, technical without turning into a wall of terminal chrome, and confident without visual noise.

Architecture, deployment state, runtime health, and immutable evidence carry the hierarchy. Marketing language supports those artifacts rather than competing with them. Orange identifies product actions, selection, focus, and the active path; green, yellow, red, and blue appear only when the interface is communicating status.

The system is flat by default. Depth comes from tonal separation, fine hairlines, compact grouping, and a single shared atmospheric glow rather than glass, blur, or decorative gradients. Motion confirms state change; route entry and static surfaces remain immediate.

**Key Characteristics:**

- Neutral graphite environment across public, authenticated, project, and administration routes.
- One orange product accent, reserved for actions, focus, active navigation, and control-path emphasis.
- Semantic color appears only where success, warning, danger, or in-progress information is being communicated.
- Modern sans hierarchy for human-facing content; compact mono type for evidence, labels, identifiers, and numeric data.
- Dense but calm layouts that elevate architecture and operational proof above promotional copy.
- Accessible contrast, visible focus, restrained motion, and responsive evidence views.

## Colors

The palette is a graphite instrument panel punctuated by a single warm orange signal and tightly scoped semantic state colors.

### Primary

- **Control Orange:** The only product accent. Use it for primary actions, focus, links, active navigation, selected filters, and the active control path.
- **Signal Orange:** The brighter text treatment for eyebrows, active icons, and links on dark surfaces.
- **Ember Wash:** The soft orange fill for selected or active states; it must remain subordinate to content.

### Neutral

- **Graphite Canvas:** The uninterrupted application ground shared by every route.
- **Recessed Graphite:** Inputs, toolbars, table heads, and shell chrome that sit behind primary content.
- **Control Surface:** The default card, panel, modal, and evidence-container fill.
- **Raised Graphite:** Reserved for genuinely raised or modal material.
- **Instrument Tile:** Nested metrics, metadata blocks, and quiet grouped content.
- **Hover Graphite:** Hover, avatar, and compact glyph surfaces.
- **Primary Ink:** Headings, decisive values, and high-priority evidence.
- **Secondary Ink:** Body copy and supporting operational context.
- **Muted Ink:** Labels, metadata, timestamps, and subordinate explanations.
- **Hairline / Strong Hairline:** Low-contrast structural boundaries; use the stronger line only when a control or region needs clearer separation.

### Named Rules

**The One Signal Rule.** Orange is the only non-semantic accent and should remain visually scarce enough to identify the action or active path immediately.

**The Status Means Status Rule.** Green, yellow, red, and blue are not page themes or decoration; they communicate verified state only.

**The Shared Atmosphere Rule.** Every route uses the same subtle orange radial glow at the top-left edge of the graphite canvas; do not introduce route-specific color worlds.

## Typography

**Display Font:** Geist (with Inter, system sans-serif fallback)
**Body Font:** Geist (with Inter, system sans-serif fallback)
**Label/Mono Font:** Geist Mono (with system monospace fallback)

**Character:** Geist keeps the interface contemporary, compact, and highly legible across public and operational surfaces. Geist Mono separates machine evidence from human explanation without making the whole product feel like a terminal.

### Hierarchy

- **Display** (650, responsive display scale, 0.98 line-height): Rare public-page statements and the About hero only.
- **Headline** (650, responsive headline scale, approximately 1.0 line-height): Landing architecture thesis, dashboard greeting, project names, and primary route statements.
- **Title** (650, responsive page-title scale, 1.1 line-height): Operational page headers and administration titles.
- **Body** (400, 15px, 1.55 line-height): Explanations, instructions, and supporting context; keep long prose near 70 characters per line where layouts permit.
- **Label** (500, compact mono scale, 0.06em tracking, uppercase): Eyebrows, metric labels, boundary tags, table headings, evidence keys, and compact status metadata.
- **Evidence** (400–600, compact mono): SHAs, identifiers, commands, timestamps, logs, and tabular numeric values.

### Named Rules

**The Two Voices Rule.** Sans explains and directs; mono identifies and proves. Do not set ordinary body copy or major headings in monospace.

**The Consistent Eyebrow Rule.** Eyebrows use the compact mono label treatment and orange signal ink unless a neutral evidence context explicitly requires muted ink.

## Layout

Authenticated pages use a persistent 248px navigation rail with a sticky 66px top bar and a flexible content region. Operational workspaces cap at 1320px; administration may expand to 1500px for dense tables and fleet-wide evidence. Public navigation aligns to the same broad content frame rather than floating as a decorative pill.

Spacing follows a 4px base rhythm, with 8–16px inside controls, 16–24px inside compact cards, and 24–64px between major regions. Dense operational screens should gain clarity through alignment, grouping, and labels—not oversized whitespace. Prefer grids that preserve evidence relationships; collapse them progressively at 1080px and 760px, and transform wide tables into labeled records where the existing responsive table pattern is available.

Architecture diagrams, pipeline graphs, lifecycle rails, and evidence panels are primary content, not embellishment. Give them the larger or earlier grid area when they compete with explanatory copy. On the landing hero, the architecture artifact owns two-thirds of the desktop grid; the copy supports it.

**The Evidence-First Rule.** When architecture or runtime evidence and promotional copy share a surface, allocate more space and stronger grouping to the evidence.

## Elevation & Depth

The system is flat by default. Canvas, recessed chrome, surfaces, and nested tiles create depth through tone and hairline borders. Resting content uses only a one-pixel anchoring shadow or none at all. Medium and large shadows are reserved for modals, drawers, and the primary architecture artifact; blur and backdrop-filter are disabled in the final cohesion layer.

### Shadow Vocabulary

- **Anchoring Shadow** (`0 1px 2px rgba(0, 0, 0, 0.24)`): Default card and panel anchoring; visually subordinate to the border.
- **Raised Shadow** (`0 12px 28px -18px rgba(0, 0, 0, 0.72)`): Floating or raised layers that must separate from a dense workspace.
- **Artifact Shadow** (`0 28px 60px -28px rgba(0, 0, 0, 0.88)`): The landing architecture frame and major modal artifacts only.

**The Flat-by-Default Rule.** If a border and tonal shift establish the hierarchy, do not add another shadow.

**The One Atmosphere Rule.** The shared radial orange glow belongs to the canvas, never to individual cards or decorative blobs.

## Shapes

Corners are gently rounded, compact, and functional. Controls use an 8px radius; cards and panels use 12px; major artifacts and modals may use 16px. Ten-pixel groupings are used for compact tab containers. Pills are reserved for status chips and tightly bounded metadata—not general buttons or navigation chrome.

Borders are one-pixel translucent hairlines. A stronger hairline marks interactive controls and major boundaries. Circular forms are limited to status dots, small sequence markers, lifecycle nodes, and avatars. Do not use exaggerated rounding to make ordinary surfaces feel friendly.

## Components

### Buttons

- **Shape:** Compact rounded rectangle (8px radius), 38px minimum height, 8px × 14px internal padding.
- **Primary:** Solid Control Orange with near-black text; use for the single decisive action in a local action group.
- **Hover / Focus:** Hover brightens to the orange hover tone and may add a restrained low orange shadow. Keyboard focus uses a visible orange outline or three-pixel orange ring.
- **Secondary / Ghost:** Transparent with a strong graphite hairline and secondary ink. Hover uses Hover Graphite and primary ink.
- **Danger:** Red is reserved for genuinely destructive actions and always requires explicit destructive context.

### Chips

- **Style:** Compact 999px status capsule with a 6px state dot, soft semantic fill, matching semantic text, and low-contrast semantic border.
- **State:** Green is success, yellow is attention, red is failure, blue is running or informational, and graphite is neutral. Do not recolor chips by route.

### Cards / Containers

- **Corner Style:** Gently rounded (12px), increasing to 16px only for major artifacts or modals.
- **Background:** Control Surface with a translucent hairline; nested metrics use Instrument Tile or Recessed Graphite.
- **Shadow Strategy:** Flat or Anchoring Shadow at rest; larger shadows only for layers that physically float.
- **Internal Padding:** 16–20px for dense operational content and up to 24px for broader explanatory regions.

### Inputs / Fields

- **Style:** Recessed Graphite fill, strong hairline border, 8px radius, 38px minimum height, and 8px × 12px internal padding.
- **Focus:** Orange border plus a restrained three-pixel soft-orange ring; never rely on color alone when the field also carries an error.
- **Error / Disabled:** Errors use semantic red messaging and boundaries. Disabled fields retain readable muted contrast and remove elevation.

### Navigation

- **Style:** Flat graphite shell with compact sans labels and restrained icons. Default links use muted ink.
- **Hover / Active:** Hover moves to a darker tile. Active navigation uses an Ember Wash, Primary Ink, and Signal Orange icon or indicator.
- **Mobile:** The sidebar becomes a focus-contained drawer with a backdrop and 44px minimum targets; wide evidence navigation scrolls horizontally rather than compressing labels beyond recognition.

### Data Tables

- **Style:** Control Surface container, Recessed Graphite heading row, mono uppercase column labels, hairline row divisions, and tabular numeric values.
- **Responsive:** Preserve field names by converting each row into a labeled record at narrow widths rather than forcing illegible horizontal compression.
- **Interaction:** Row hover is a small neutral tonal shift; selection or status must be expressed independently.

### Architecture & Evidence Artifacts

- **Style:** Use the darkest recessed surface, a strong neutral boundary, compact mono labels, and clear directional links. Orange marks DeployGuard control; semantic colors mark verified runtime state.
- **Priority:** Artifacts should remain larger and more visually explicit than the copy that introduces them.
- **Motion:** Animate only state transitions or signal movement. Respect reduced-motion preferences and never delay comprehension behind an entrance animation.

## Do's and Don'ts

### Do:

- **Do** keep every route on the Graphite Canvas with the shared subtle orange atmosphere.
- **Do** reserve Control Orange for primary actions, focus, active navigation, selection, and control-path emphasis.
- **Do** use semantic colors only when presenting verified status or runtime state.
- **Do** use Geist Mono for evidence, identifiers, labels, timestamps, boundaries, and tabular values.
- **Do** make architecture, lifecycle state, diagnostics, and immutable evidence more prominent than explanatory or promotional copy.
- **Do** retain visible keyboard focus, readable contrast, 44px mobile targets, and reduced-motion behavior.

### Don't:

- **Don't** introduce route-specific accent palettes, decorative multicolor gradients, or colored atmosphere fields.
- **Don't** use green, yellow, red, or blue as generic decoration or branding.
- **Don't** add glass blur, glossy highlights, or elevated shadows to ordinary content surfaces.
- **Don't** turn all technical content into monospace; keep headings and explanations in Geist.
- **Don't** hide operational evidence behind marketing spectacle, oversized copy, or ornamental motion.
- **Don't** use pills for primary buttons, ordinary cards, or top-level navigation.
