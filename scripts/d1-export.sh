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
# the virtual tables, the indexes, views and triggers, and a rebuild of each
# FTS5 index from the table it indexes. The data goes in before the triggers
# exist, which is why the rebuild is needed. Every appended statement is
# `IF NOT EXISTS`, so a remote export that does keep some of them still
# restores. The result restores with one `wrangler d1 execute --file`, as
# before.
set -euo pipefail

db=$1
out=$2
shift 2

# One column, `x`, one value per line.
query() {
  pnpm --silent wrangler d1 execute "$db" "$@" -y --json --command "$sql" |
    jq -r '.[0].results[].x'
}

# A virtual table, or one of the shadow tables FTS5 keeps for it. Named
# exactly, so an ordinary table that merely starts with the same name is
# still backed up.
virtual="EXISTS (SELECT 1 FROM sqlite_master v WHERE v.type = 'table'
  AND v.sql LIKE 'CREATE VIRTUAL TABLE%'
  AND m.tbl_name IN (v.name, v.name || '_data', v.name || '_idx',
    v.name || '_content', v.name || '_docsize', v.name || '_config'))"
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

# The CREATE with IF NOT EXISTS after its keyword (sqlite_master keeps each
# statement as written, and every one here starts with its own keywords).
guarded="CASE
  WHEN m.sql LIKE 'CREATE UNIQUE INDEX %' THEN 'CREATE UNIQUE INDEX IF NOT EXISTS ' || substr(m.sql, 21)
  WHEN m.sql LIKE 'CREATE INDEX %' THEN 'CREATE INDEX IF NOT EXISTS ' || substr(m.sql, 14)
  WHEN m.sql LIKE 'CREATE VIRTUAL TABLE %' THEN 'CREATE VIRTUAL TABLE IF NOT EXISTS ' || substr(m.sql, 22)
  WHEN m.sql LIKE 'CREATE TRIGGER %' THEN 'CREATE TRIGGER IF NOT EXISTS ' || substr(m.sql, 16)
  WHEN m.sql LIKE 'CREATE VIEW %' THEN 'CREATE VIEW IF NOT EXISTS ' || substr(m.sql, 13)
  ELSE m.sql END || ';'"

{
  # The export's last statement has no newline after it.
  echo
  sql="SELECT $guarded AS x FROM sqlite_master m
    WHERE m.type = 'table' AND m.sql LIKE 'CREATE VIRTUAL TABLE%' ORDER BY m.name"
  query "$@"
  # Views last among the definitions: one may read any table above.
  sql="SELECT $guarded AS x FROM sqlite_master m
    WHERE m.type IN ('index', 'view', 'trigger') AND m.sql IS NOT NULL
      AND NOT $internal AND NOT $virtual
    ORDER BY CASE m.type WHEN 'index' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, m.name"
  query "$@"
  sql="SELECT 'INSERT INTO \"' || m.name || '\"(\"' || m.name || '\") VALUES(''rebuild'');' AS x
    FROM sqlite_master m
    WHERE m.type = 'table' AND m.sql LIKE 'CREATE VIRTUAL TABLE%USING fts5%'"
  query "$@"
} >> "$out"
