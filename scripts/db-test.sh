#!/usr/bin/env bash
# Aplica as migrações num Postgres vazio e roda tests/db/*.test.sql.
# Uso: DATABASE_URL=postgresql://postgres@localhost:5499/postgres scripts/db-test.sh
set -euo pipefail
: "${DATABASE_URL:?defina DATABASE_URL}"
cd "$(dirname "$0")/.."
run() { psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 "$@"; }
run -f tests/db/stub.sql
for f in supabase/migrations/*.sql; do echo "migração: $f"; run -1 -f "$f"; done
for t in tests/db/*.test.sql; do
  echo "teste: $t"
  if ! out=$(run -f "$t" 2>&1); then echo "$out"; exit 1; fi
  echo "$out" | grep -E "PASS" || true
done
echo "testes de banco ok"
