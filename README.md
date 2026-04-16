# fxPanel v6 → txAdmin v5 migration

Converts an fxPanel `playersDB.json` (version 6) into a txAdmin-compatible `playersDB.json` (version 5).

## Install

```bash
bun install
```

## Usage

```bash
bun start --input path/to/fxpanel/playersDB.json --output path/to/txadmin/playersDB.json
```

Existing output files are overwritten and backed up as `<output>.bak.<timestamp>`.

## Notes

- `kick` actions and `reports` are dropped (not supported by txAdmin v5); counts are printed in the summary.
- `ban` and `warn` actions are preserved; missing `revocation` becomes `{ timestamp: null, author: null }`.
