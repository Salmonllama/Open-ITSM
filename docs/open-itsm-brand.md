# Open ITSM: Brand and Design Summary

Decided 2026-10-19. The full source of truth (tokens, components, logo files, usage rules) is the **Open ITSM design system** artifact in claude.ai: https://claude.ai/artifact/XWujBHYD27pk42Cjo7eGjq. The v1 screens are mocked up in the **Open ITSM v1 Page Mockups** canvas: https://claude.ai/artifact/2LQ377awSSjUywLaPvvLwH (see Page mockups below). This doc is the short version for planning and for building the app.

## Identity

- **Name:** Open ITSM. Always two words; "Open" in title case, "ITSM" in capitals.
- **Personality:** calm, dependable, plain-spoken. A tool a tech opens at 8am and trusts all day.
- **Logo:** "Scan and check": four scanner corners framing a check mark (scan the asset, resolve the ticket), with a monoline wordmark drawn on the same 6-unit stroke grid. Files: `open-itsm-lockup.svg` (light), `open-itsm-lockup-reversed.svg` (dark), `open-itsm-lockup-black.svg` (print), `open-itsm-mark.svg` / `-reversed`, `open-itsm-app-icon.svg`, `open-itsm-favicon.svg` (16px). The ticket and asset-tag directions were explored and rejected.

## Colour

Semantic tokens, light and dark themes (follow the OS setting; technicians can override).

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `pine` | #1d6b4e | #5cc497 | Brand; primary button, links, selected nav |
| `mint` | #a6dcc0 | #2f7d5a | Decoration only (logo app icon, illustrations) |
| `surface` | #f5f7f5 | #0f1512 | Page background |
| `surface-raised` | #ffffff | #17201b | Cards, tables, inputs |
| `ink` | #15211b | #e4ece7 | Primary text |
| `ink-muted` | #4f5f56 | #9eaea5 | Secondary text |

**Status tones** (each always shown with a word and a shape, never colour alone):

| Tone | Tickets | Assets |
| --- | --- | --- |
| info (blue) | New | Deployed |
| progress (violet) | In progress | Preparing |
| warning (amber) | Waiting on user | In repair, Low stock |
| success (green) | Resolved | In stock |
| danger (red) | Overdue, errors | |
| neutral (grey) | Closed | Retired |

All text colours pass WCAG AA (4.5:1) on their backgrounds in both themes.

## Type, icons, shape

- **Fonts:** Atkinson Hyperlegible Next (interface) and Atkinson Hyperlegible Mono (asset numbers, serials, ticket IDs, IPs). SIL OFL. Self-host via `@fontsource/atkinson-hyperlegible-next` and `@fontsource/atkinson-hyperlegible-mono`; never load from Google Fonts in a self-hosted product.
- **Type scale:** display 28, title 20, heading 16, body 14, label 13, caption 12, id 14 (mono).
- **Icons:** Lucide (`lucide-react`), 16px in buttons and badges, 20px in nav and tables, stroke 1.75.
- **Spacing:** 4px grid (4, 8, 12, 16, 24, 32). **Radius:** 4 badges, 6 buttons and inputs, 10 cards and dialogs.
- Borders separate things; shadows only on floating elements.

## Layout

- **Shell:** a sidebar (`surface-sunken`, lockup at 28px in the top-left corner) beside one full-width page.
- **Lists and records are separate pages.** The ticket list and asset list each fill the page; opening a ticket or asset goes to its own page, with a breadcrumb back to the list. No side panes, flyouts or split views. (Decided 2026-10-19, replacing an earlier list-plus-detail-pane layout that crowded both.)
- **Record pages:** title, status and main actions at the top; main content (conversation, details, history) in a wide left column; supporting cards (requester, linked assets, asset tag, activity) in a narrower right column that stacks below on small screens.
- **Phone width:** the optional end-user dashboard and the scan screen must work on a phone.

## Page mockups

The **Open ITSM v1 Page Mockups** canvas (https://claude.ai/artifact/2LQ377awSSjUywLaPvvLwH) shows each v1 technician screen in light and dark themes. It is built with the design system's real tokens and components, so treat it as the visual reference when building a screen; where it and the design system disagree, the design system wins.

| Screen | Light artboard | Dark artboard | Shows |
| --- | --- | --- | --- |
| Asset list | `project/Main.dc.html` | `project/AssetListDark.dc.html` | Status tabs with counts, search and filters, low-stock notice, asset table, paging |
| Asset page | `project/AssetView.dc.html` | `project/AssetViewDark.dc.html` | Asset header and actions, custom-field details, assignment history, repairs, current assignee, printable asset tag, related tickets, activity |
| Ticket list | `project/TicketList.dc.html` | `project/TicketListDark.dc.html` | Queue tabs, search and filters, TicketRow list with unread dots, paging |
| Ticket page | `project/TicketView.dc.html` | `project/TicketViewDark.dc.html` | Status and assignee controls, email conversation with internal notes, reply/note composer, requester, linked assets, details, history |

**Reading it in code work:** open the canvas link in a browser to see it, or read an artboard's source with the Artifact tool (`action: "read"`, the canvas URL and the artboard's `path` above). Each dark artboard only imports its light page with `theme="dark"`, so the light file holds the markup. Inline styles use the design system's CSS variables (`var(--pine)`, `var(--space-4)`, `var(--text-id)`), and `<x-import component-from-global-scope="OpenITSM.…">` marks where a design system component goes.

**What is sample content, not spec:** names, ticket subjects, counts and dates are placeholders. Asset numbers show a team-set prefix (`IT-000142`) as an example only. `[company]` stands in for the team's domain. Ticket-to-asset linking appears on both record pages but is not yet in the v1 product overview.

## Voice

Short sentences, plain words, no exclamation marks, no emoji, no blame. Lead with what happened, then what to do. Fixed vocabulary: ticket, asset, technician, requester.

## Reference components

Button, StatusBadge, TextField, TicketRow and the printed AssetTag (QR + asset number, black on white, no logo) are in the design system as React reference implementations to rebuild in the app.
