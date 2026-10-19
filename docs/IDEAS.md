# Ideas

Proposed features that are outside the v1 alpha scope. Nothing here is built until the scope
says so.

## Accounts

- **Self-service password change.** In M1 only an administrator (Users page) or the host
  recovery CLI can set a password; a technician cannot change their own. A "change my password"
  form needs the current password and would revoke the user's other sessions.

## Appearance

- **Theme choice per user.** The light/dark override is kept in the browser's `localStorage`, so
  it does not follow a technician to another computer. Storing it on the user record would.
