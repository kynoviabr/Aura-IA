# Aura IA — instruções do repositório

Plataforma de WhatsApp e IA da Kynovia, usada pelos produtos Clinova, Agenda+ e Belariz. Leia `docs/ARQUITETURA.md`.

## Regras
- A Aura IA nunca acessa o banco de um produto: fala com ele pela API padrão (docs/ARQUITETURA.md §5).
- Produtos nunca falam com a Zernio: falam com a função `api` desta plataforma.
- Todo acesso a WhatsApp passa por `supabase/functions/_shared/zernio.ts` (provedor trocável).
- Tabelas fechadas ao público (RLS sem políticas); só as funções de servidor (service_role) leem e gravam.
- Textos para o usuário e comentários em português, simples.

## Comandos
- `npm test` — testes unitários (vitest)
- `npm run typecheck` — tipos do código compartilhado
- `npm run check:functions` — tipos das Edge Functions (Deno; atrás de proxy, defina DENO_CERT)
- `DATABASE_URL=postgresql://postgres@localhost:5498/postgres npm run test:db` — migrações + testes de banco em Postgres local

## Ambientes
- Homologação: Supabase `Aura-Homolog` (kkkxyvchdtjagvmevxve), conta aura.kynoviabr.
- Produção: ainda não criada.
