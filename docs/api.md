# Using the API from scripts

The Open ITSM API is internal: it serves the web UI and your own scripts. It is not a stable
public contract, so pin your scripts to the version you run and check them after upgrading.

## Reference

Signed-in administrators and technicians can browse every endpoint at `/api/docs` (the OpenAPI
JSON is at `/api/docs/json`). Tokens cannot open the reference.

## Tokens

1. Sign in as an administrator and open **Service accounts**.
2. Create a service account for each script or system, such as "Inventory sync", so the audit
   log shows what each one changed and you can switch one off on its own.
3. Issue a token with only the scopes the script needs:
   - `assets:read` reads assets, asset types and fields.
   - `assets:write` creates, changes, imports and deletes them. It does not include
     `assets:read`; give a token both to read and change.
   - `tickets:read` reads tickets, their conversations, linked assets and history, and the
     requester and assignee lists.
   - `tickets:write` opens tickets, replies, adds internal notes, changes status and assignee,
     and links assets. Like the asset scopes, it does not include `tickets:read`.
4. Copy the token when it is shown. It is shown once; if it is lost, revoke it and issue another.

Tokens expire after 90 days by default and after one year at most. The Service accounts page
flags tokens that expire within 14 days. Send a token only in the `Authorization: Bearer`
header; a token in the address or the request body is refused.

Keep the token out of the script itself, for example in an environment variable.

## Read an asset by its number

PowerShell:

```powershell
$headers = @{ Authorization = "Bearer $env:OPEN_ITSM_TOKEN" }
$number = [uri]::EscapeDataString('LAP-000123')
Invoke-RestMethod -Uri "https://itsm.example.com/api/assets/by-number/$number" -Headers $headers
```

curl:

```sh
curl -fsS -H "Authorization: Bearer $OPEN_ITSM_TOKEN" \
  https://itsm.example.com/api/assets/by-number/LAP-000123
```

Numbers match without regard to case. Encode numbers that contain `/` (`%2F`).

## Import a CSV file

Find the asset type's ID with `GET /api/asset-types`, then send the file as the body. Add
`dryRun=true` to check the file without importing it. Nothing is imported unless every row is
valid; problems come back with their line and column (HTTP 422).

```sh
curl -fsS -H "Authorization: Bearer $OPEN_ITSM_TOKEN" -H 'Content-Type: text/csv' \
  --data-binary @laptops.csv \
  "https://itsm.example.com/api/assets/import?typeId=<type id>&dryRun=true"
```

```powershell
Invoke-RestMethod -Method Post -Headers $headers -ContentType 'text/csv' `
  -InFile .\laptops.csv `
  -Uri "https://itsm.example.com/api/assets/import?typeId=<type id>&dryRun=true"
```

## Assign, return and repair an asset

These need `assets:write` and use the asset's ID (from the lookup above). Assigning sets the
status to Deployed, and a repair sets In repair until it is closed. The history is recorded
under the service account's name.

```powershell
$asset = Invoke-RestMethod -Headers $headers `
  -Uri "https://itsm.example.com/api/assets/by-number/LAP-000123"
Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
  -Body (@{ assignee = 'Priya Nair'; location = 'HQ, 3rd floor' } | ConvertTo-Json) `
  -Uri "https://itsm.example.com/api/assets/$($asset.id)/assign"
```

```sh
curl -fsS -H "Authorization: Bearer $OPEN_ITSM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"in_stock"}' https://itsm.example.com/api/assets/<asset id>/return
```

`POST /api/assets/<asset id>/repairs` with `{"summary":"Battery replaced"}` opens a repair, and
`POST /api/assets/<asset id>/repairs/<repair id>/close` closes it. `GET
/api/assets/<asset id>/history` lists assignments, repairs and activity. A change the asset's
state does not allow (for example assigning a retired asset) returns HTTP 409 with a message.

## Change consumable stock

Consumables use the asset scopes. `kind` is `add` or `use` with an `amount`, or `count` with the
real `quantity` and a `reason`. A use can name an open repair with `repairId` (from `GET
/api/repairs/open`). A use larger than the stock on hand returns HTTP 409, so stock never goes
below zero.

```powershell
$item = (Invoke-RestMethod -Headers $headers `
  -Uri "https://itsm.example.com/api/consumables?q=HP%2089A").items[0]
Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' `
  -Body (@{ kind = 'add'; amount = 10; reason = 'Order 4411' } | ConvertTo-Json) `
  -Uri "https://itsm.example.com/api/consumables/$($item.id)/adjustments"
```

```sh
curl -fsS -H "Authorization: Bearer $OPEN_ITSM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"count","quantity":7,"reason":"Stocktake"}' \
  https://itsm.example.com/api/consumables/<consumable id>/adjustments
```

`GET /api/consumables/low-stock` lists every item at or below its threshold.

## Update a ticket's status

Find the ticket by its number, then change it. Statuses are `in_progress`, `waiting_on_user`,
`resolved` and `closed` (New is only for tickets nobody has touched). Setting `assigneeId` to a
staff member's ID (from `GET /api/tickets/assignees`), or to `null`, changes the assignee. The
ticket's history names the service account as the one who made the change.

```powershell
$ticket = Invoke-RestMethod -Headers $headers -Uri 'https://itsm.example.com/api/tickets/by-number/42'
Invoke-RestMethod -Method Patch -Headers $headers -ContentType 'application/json' `
  -Body (@{ status = 'resolved' } | ConvertTo-Json) `
  -Uri "https://itsm.example.com/api/tickets/$($ticket.id)"
```

```sh
id=$(curl -fsS -H "Authorization: Bearer $OPEN_ITSM_TOKEN" \
  https://itsm.example.com/api/tickets/by-number/42 | jq -r .id)
curl -fsS -X PATCH -H "Authorization: Bearer $OPEN_ITSM_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"resolved"}' "https://itsm.example.com/api/tickets/$id"
```

`POST /api/tickets` opens a ticket (`subject`, `requester` with `email` and an optional `name`,
`message`, and optional `assetIds`). `POST /api/tickets/<id>/messages` adds a `reply` or a
`note` with a `body`. While a mailbox is connected, a reply is emailed to the requester
(`emailStatus` goes `queued`, then `sent` or `failed`); otherwise it is saved only (`not_sent`).
`GET /api/tickets` searches with `q`, `queue` (`open`, `unassigned`, `waiting`, `closed`),
`status`, `assignee` and `source`.

## Attach a file to a reply

Upload the file as the request body with its own content type and its name in `name`, then
name it in `attachmentIds` on the reply or note. Files are at most 25 MB; programs and
scripts are refused. An upload no message uses is removed after a day.

```sh
file=$(curl -fsS -X POST -H "Authorization: Bearer $OPEN_ITSM_TOKEN" \
  -H 'Content-Type: application/pdf' --data-binary @steps.pdf \
  "https://itsm.example.com/api/tickets/$id/attachments?name=steps.pdf" | jq -r .id)
curl -fsS -X POST -H "Authorization: Bearer $OPEN_ITSM_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"kind\":\"reply\",\"body\":\"Steps attached.\",\"attachmentIds\":[\"$file\"]}" \
  "https://itsm.example.com/api/tickets/$id/messages"
```

Mailbox settings are not reachable with a token; an administrator manages them on the Email
page.
