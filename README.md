# Aura IA

Plataforma de **WhatsApp e IA** da Kynovia, usada por todos os produtos:

| Produto | Segmento | Repositório |
|---|---|---|
| Clinova | Clínicas de estética | `kynoviabr/clinicas-de-estetica` |
| Agenda+ | Consultórios e clínicas médicas | `kynoviabr/AgendaPlus-Medicos` |
| Belariz | Estúdios de unhas | — |

A Aura IA cuida do canal (WhatsApp via Zernio), das conversas, da IA de atendimento e da passagem para humano.
Cada produto cuida do seu negócio (agenda, serviços, preços, clientes) e conversa com a Aura IA por uma API padrão.

Arquitetura e fases: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Console

Painel administrativo da Kynovia em `console/` (React, mesmo padrão visual dos produtos):
visão geral, empresas e números, aplicações conectadas, provedores de IA, créditos e pacotes, alertas e configurações.
Publicado no Vercel da conta da Aura (pasta raiz do projeto: `console`). Variáveis: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
