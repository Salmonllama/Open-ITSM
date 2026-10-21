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

Updating a ticket's status is added here when tickets arrive.
