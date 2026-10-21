# Ideas

Proposed features that are outside the v1 alpha scope. Nothing here is built until the scope
says so.

## Accounts

- **Self-service password change.** In M1 only an administrator (Users page) or the host
  recovery CLI can set a password; a technician cannot change their own. A "change my password"
  form needs the current password and would revoke the user's other sessions.

## Assets

- **Reordering fields.** Custom fields appear in the order they were added. Drag-to-reorder on
  the asset type page would let admins group related fields.
- **Changing an asset's type.** An asset keeps the type it was created with, because its number
  prefix and field values belong to that type. Moving it would need a mapping of field values.
- **Semicolon-separated CSV.** Import reads comma-separated files only. Spreadsheets in locales
  that use a decimal comma often save with semicolons; the importer could detect the delimiter.
- **CSV export.** Export the filtered asset list as CSV, in the same columns import reads, so a
  round trip through a spreadsheet works.

## Asset tags and scanning

- **Configurable tag text.** Tags print a fixed "Property of IT" line and a fixed help line
  (M4, user's choice). An admin setting would let a team print its own name and contact.
- **Start on a part-used sheet.** Sheet printing always starts at the first label. A "start at
  label N" choice would use up sheets that already have gaps.
- **Scans in the activity log.** The asset page mockup shows "Tag scanned at HQ, 3rd floor".
  Opening an asset by scan records nothing today; a scan could log where and by whom.

## Appearance

- **Theme choice per user.** The light/dark override is kept in the browser's `localStorage`, so
  it does not follow a technician to another computer. Storing it on the user record would.

## Assets

- **Downloadable CSV import template.** Bulk import accepts a CSV, but a technician has to guess
  the expected columns and value formats. A "Download template" link on the import page could
  serve a CSV for the chosen asset type, with the built-in and custom field columns as headers
  and an example row, so the file is right before the first upload.

## Locations

- **Managed locations.** Locations are free text, so the same site can be typed several ways
  and nothing links an asset to the people who work there. A technician could create
  locations once and pick them from a list on both assets and end users, which would make
  locations consistent and allow filtering assets and people by site. Existing free-text
  values would need a one-time mapping to the new records.

## Tickets

- **Tickets on the asset page.** Tickets can link assets (M6), but the asset page does not list
  the tickets that name it. A Tickets card there would show an asset's support history.
