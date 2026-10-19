# Open ITSM: Product Overview (v1 Scope)

Revised 2026-10-19.

## Purpose and target user

Open ITSM is a free, open-source, self-hosted IT service management tool for small internal IT teams (roughly 1 to 10 technicians) that need to track their hardware and handle support requests without the cost and complexity of enterprise ITSM suites.

v1 does two things well: **asset management** (know what you own, where it is, and what state it is in) and **support management** (receive, work and close tickets, mostly over email). Everything else waits.

## Scope

**In scope for v1**

- Asset management: custom asset types, unique asset numbers, QR code scanning (barcodes to follow), status tracking, repairs, consumables
- Support management: email-based ticketing (Microsoft 365), optional MS Teams and Slack connections, technician web dashboard, optional end-user dashboard for viewing open tickets, optional Entra ID single sign-on
- Scripting: an internal REST API that administrators can script against with scoped API tokens issued to named service accounts

**Explicitly out of scope for v1**

Change, incident and problem management workflows, a knowledge base with suggested articles, SLA reporting, patch management and network discovery, purchasing and procurement, mobile apps, and email providers other than Microsoft 365 (Google Workspace and generic IMAP/SMTP come later). Each is a reasonable later addition; none ships in v1. A public or third-party API is also out of scope.

## Asset management

Techs can record any asset the team owns, find it by scanning its label, and always see its current status.

| Capability | Requirement |
| --- | --- |
| Asset types | Any type the team needs (laptops, phones, printers, licenses, and so on), with the ability to create custom types and define custom fields for each |
| Asset numbers | Every asset gets a unique number; duplicates are rejected at creation and on import |
| Scanning | Look up or check in an asset by scanning its QR code, through a device camera or scanner; barcode support follows in a later version |
| Status tracking | Each asset has a status, including preparing, in stock, deployed, in repair and retired |
| Deployment | Record who or where an asset is assigned and keep a history of assignments |
| Repairs | Log repair events against an asset, with dates and notes, and reflect them in its status |
| Consumables | Track parts and supplies by quantity (toner, cables, batteries, spare drives), with a low-stock threshold and an optional link to a repair |

## Support management

Users send an email, techs work the ticket from a web dashboard, and the conversation stays in email.

| Capability | Requirement |
| --- | --- |
| Email connection | Connect to Microsoft 365 (the v1 provider) so a new email creates a ticket and replies on the ticket go out as email |
| Email threading | Replies from the user attach to the existing ticket rather than opening a new one |
| Teams and Slack | Optional connections for MS Teams and Slack, off by default and configured per team |
| Technician dashboard | Web login (local accounts, or optional Entra ID single sign-on with access managed by an Entra ID group) for techs to see open tickets, open one, and respond |
| Ticket basics | Status, assignee and a history of replies and changes on every ticket |

**Optional end-user dashboard.** Users can sign in to see their own open tickets. Email stays the primary channel, so the dashboard is not required. A knowledge base with suggested articles for users is planned for a later version.

## Technician dashboard layout

The dashboard is a sidebar beside one full-width page, with lists and records on separate pages:

- **Asset list** and **ticket list**: full-width, with status tabs, search and filters.
- **Asset page** and **ticket page**: opened from a row in the list, with a breadcrumb back. Title, status and main actions at the top; main content (asset details and history, or the ticket conversation and reply box) in a wide column; supporting cards (assignment, asset tag, requester, linked assets, history) in a narrower side column.

Records never open in side panes or flyouts. The v1 page mockups are on the **Open ITSM v1 Page Mockups** design canvas in claude.ai, in light and dark themes.

## API access and security

Open ITSM has a REST API. It is internal: it serves the dashboards and lets administrators script routine work, such as importing assets from another system or updating tickets from a script. It is not a public API, and its endpoints may change between versions.

| Capability | Requirement |
| --- | --- |
| Authenticated by default | Every request must come from a signed-in user or carry a valid API token. Only sign-in, first-run setup and the health check are open |
| Roles | Administrators, technicians and end users can reach only what their role allows, checked on the server for every request. End users can reach only their own tickets |
| Browser sessions | The dashboards use secure, server-side sessions with protection against cross-site requests; other websites cannot call the API |
| Service accounts | Administrators create named service accounts for scripts, such as "Inventory import". Tokens belong to the service account, not to a person, so scripts keep working when staff change. Service accounts cannot sign in to the dashboard |
| API tokens | Administrators issue tokens to service accounts with one or more of four scopes: assets read, assets write, tickets read and tickets write. A token is shown once, must expire (90 days by default, one year at most), and can be revoked at any time |
| Administration stays interactive | No token can change settings, connectors, users, service accounts, tokens or backups; those need a signed-in administrator |
| Accountability | Changes made with a token are recorded under the service account's name, and the audit log records token creation, revocation and use |

Sessions and roles come with the first sign-in milestone. Service accounts and tokens arrive with asset management, and the ticket scopes are added with the ticket dashboard; see `docs/IMPLEMENTATION.md` for the build order.

## Deployment model

v1 is self-hosted: each team runs the application and its database on its own server, so asset and ticket data stays in-house.

- Simple install and upgrade path, since small teams rarely have a dedicated ops person; first-run setup walks the operator through creating a local administrator account, which is then used to optionally configure Entra ID single sign-on; local accounts always remain available so an SSO misconfiguration cannot lock technicians out
- Secure storage of the email and chat credentials the team enters
- Backup and restore of the database
- Free and open source under GPL v3 (tentative), so installing and updating cost nothing; paid support contracts are optional, and hosted SaaS is a possible later option

## Brand and design

Branding is decided and summarized in `docs/open-itsm-brand.md`; the full source of truth is the Open ITSM design system artifact linked there. In short: pine green brand colour with light and dark themes, Atkinson Hyperlegible Next and Mono fonts, Lucide icons, the "Scan and check" logo, and separate full-width list and record pages.

## Decisions and open questions

**Decided**

- Name: Open ITSM
- Brand: calm and dependable; "Scan and check" logo; pine green palette; Atkinson Hyperlegible fonts; Lucide icons (see `docs/open-itsm-brand.md`)
- Dashboard layout: separate full-width list and record pages; no detail panes or flyouts
- Target team size: 1 to 10 technicians
- Email: Microsoft 365 first; Google Workspace and generic IMAP/SMTP in later versions
- End users: optional dashboard in v1; knowledge base and suggested articles later
- Technician sign-in: local administrator at first run; Entra ID single sign-on is optional, with group-based technician access when enabled; local accounts always remain available so SSO can never lock technicians out
- API: internal only; administrators issue expiring tokens to named service accounts, limited to four scopes (assets read and write, tickets read and write); administration is never available by token
- Consumables: optionally linked to repairs
- Licensing: free and open source under GPL v3 (tentative); paid support contracts optional; hosted SaaS later
- Scanning: QR codes first, barcodes later

**Still open**

- Confirm GPL v3 before the first release; revisit AGPL if a hosted SaaS offering makes network-use protection matter
- How is a local administrator recovered if SSO is misconfigured and the admin password is lost?
- Check that "Open ITSM" is clear to use as a product name and that a matching domain and GitHub organization are available
