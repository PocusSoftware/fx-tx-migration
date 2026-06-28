# fxPanel → txAdmin migration

Converts an fxPanel deployment folder into a txAdmin-compatible folder. Searches the input folder recursively for `playersDB.json`, `admins.json`, and `config.json`, migrates each one in place, removes obsolete fxPanel addon files, and backs everything up first.

## Install

```bash
bun install
```

## Usage

```bash
bun start --input path/to/fxpanel/folder
```

The tool will:

- Search the input folder recursively for `playersDB.json`, `admins.json`, `config.json`
- Migrate `playersDB.json` → `<input>/default/data/playersDB.json`
- Migrate `config.json`    → `<input>/config.json`
- Migrate `admins.json`    → `<input>/admins.json` (generates a random temporary password per admin, printed to the console — share these securely, they cannot be recovered)
- Delete `addon-data/` folders and `addon-config.json`, `permissionPresets.json` files
- Back up all modified files to `./backup-<timestamp>/` before writing

## Notes

- Supports fxPanel `playersDB.json` versions 5–10; output is always txAdmin `version: 5`.
- `kick` actions and `reports` are dropped (not supported by txAdmin v5); counts are printed in the summary.
- `ban` and `warn` actions are preserved; missing `revocation` becomes `{ timestamp: null, author: null }`.
- `license:<hash>` is guaranteed to be in each player's `ids` array (txAdmin requires it for history lookup) — inserted only if missing.
- `nameHistory` and `sessionHistory` on players are not carried over to the txAdmin export.
- `config.json` is migrated to `version: 2`: `queue` is removed, `whitelist` is reset to `{}`, and `gameFeatures.reportsEnabled` / `gameFeatures.ticketFeedbackEnabled` are dropped.
- Admins get a fresh bcrypt password hash (`password_hash`), `password_temporary: true`, and `password_revision` is removed. Non-master admins without `all_permissions` are reset to a small default permission set (`players.playermode`, `players.spectate`, `players.teleport`).
- Legacy whitelist key names are accepted on input: `whitelistEntries` → `whitelistApprovals`, `whitelistApplications` → `whitelistRequests`, and approval records may use `tsGranted`/`grantedBy` instead of `tsApproved`/`approvedBy`.
