#!/usr/bin/env bash
# Exports a D1 database to one SQL file that restores completely, full-text
# index included.
#
#   scripts/d1-export.sh <database> <output.sql> [wrangler flags...]
#
# `wrangler d1 export` refuses any database holding a virtual table, and the
# post search index (FTS5) is one. Naming the ordinary tables with --table gets
# past that, but a table-scoped export also leaves out every index and trigger.
# So this exports the ordinary tables, then appends what the export dropped:
# the virtual tables, the indexes, the triggers, and a rebuild of each FTS5
# index from the table it indexes. The data goes in before the triggers exist,
# which is why the rebuild is needed. The result restores with one
# `wrangler d1 execute --file`, as before.
set -euo pipefail

db=$1
out=$2
shift 2

# One column, `x`, one value per line.
query() {
  pnpm --silent wrangler d1 execute "$db" "$@" -y --json --command "$sql" |
    jq -r '.[0].results[].x'
}

# A virtual table, or one of the shadow tables SQLite keeps for it.
virtual="EXISTS (SELECT 1 FROM sqlite_master v WHERE v.type = 'table'
  AND v.sql LIKE 'CREATE VIRTUAL TABLE%'
  AND (m.tbl_name = v.name OR m.tbl_name LIKE v.name || '\_%' ESCAPE '\'))"
internal="(m.name LIKE 'sqlite\_%' ESCAPE '\' OR m.name LIKE '\_cf\_%' ESCAPE '\')"

sql="SELECT m.name AS x FROM sqlite_master m
  WHERE m.type = 'table' AND NOT $internal AND NOT $virtual ORDER BY m.name"
tables=()
while IFS= read -r name; do tables+=(--table "$name"); done < <(query "$@")
if [ ${#tables[@]} -eq 0 ]; then
  echo "no tables to export" >&2
  exit 1
fi

pnpm --silent wrangler d1 export "$db" "$@" --output "$out" -y "${tables[@]}"

{
  sql="SELECT m.sql || ';' AS x FROM sqlite_master m
    WHERE m.type = 'table' AND m.sql LIKE 'CREATE VIRTUAL TABLE%' ORDER BY m.name"
  query "$@"
  sql="SELECT m.sql || ';' AS x FROM sqlite_master m
    WHERE m.type IN ('index', 'trigger') AND m.sql IS NOT NULL
      AND NOT $internal AND NOT $virtual
    ORDER BY m.type, m.name"
  query "$@"
  sql="SELECT 'INSERT INTO \"' || m.name || '\"(\"' || m.name || '\") VALUES(''rebuild'');' AS x
    FROM sqlite_master m
    WHERE m.type = 'table' AND m.sql LIKE 'CREATE VIRTUAL TABLE%USING fts5%'"
  query "$@"
} >> "$out"
