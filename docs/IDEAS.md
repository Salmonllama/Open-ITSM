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

## Appearance

- **Theme choice per user.** The light/dark override is kept in the browser's `localStorage`, so
  it does not follow a technician to another computer. Storing it on the user record would.

## Assets

- **Downloadable CSV import template.** Bulk import accepts a CSV, but a technician has to guess
  the expected columns and value formats. A "Download template" link on the import page could
  serve a CSV for the chosen asset type, with the built-in and custom field columns as headers
  and an example row, so the file is right before the first upload.
