# Aura IA — Arquitetura

Versão 0.1 · 2026-11-06 · rascunho para discussão

## 1. Objetivo

Um sistema único de WhatsApp e IA para todos os produtos da Kynovia (Clinova, Agenda+, Belariz e os próximos).
Manter e evoluir uma só vez: uma melhoria na IA ou no canal vale para todos os produtos no mesmo dia.

## 2. Quem faz o quê

| Aura IA (plataforma) | Produto (Clinova, Agenda+, Belariz...) |
|---|---|
| Conectar o número de WhatsApp da empresa (via Zernio) | Cadastro da empresa, equipe e permissões |
| Receber e enviar mensagens, modelos aprovados, regra das 24h | Clientes / pacientes / leads e o CRM |
| Guardar conversas e mensagens | Serviços, preços, profissionais |
| IA: entender, responder, sugerir, agendar via ferramentas | Agenda: horários livres, marcar, remarcar, cancelar |
| Barreira de segurança e passagem para humano | Telas do produto (podem mostrar as conversas da Aura) |
| Medição de uso e custo por empresa | Cobrança do cliente final |

Regra de ouro: **a Aura IA nunca acessa o banco de um produto**. Ela pede o que precisa pela API do produto (seção 5).
O produto nunca fala com a Zernio diretamente: fala com a Aura IA.

## 3. Conceitos

- **Produto (app):** Clinova, Agenda+, Belariz. Cada um tem uma chave de API para falar com a Aura IA e um endereço para receber avisos.
- **Empresa (workspace):** a clínica, o consultório ou o estúdio. Pertence a um produto e guarda o `external_id` dela no produto (ex.: `clinic_id` do Clinova).
- **Canal:** o número de WhatsApp da empresa. Na Zernio, uma empresa = um *profile* (com `externalId` = id da empresa na Aura).
- **Contato:** a pessoa do outro lado. A Aura guarda telefone e nome; quem ela é no negócio (lead, paciente, cliente) é resolvido pelo produto.
- **Conversa / mensagem:** o histórico, com status de envio (enviada, entregue, lida, falha).

## 4. Componentes

```
WhatsApp ⇄ Zernio ⇄ [Aura IA]
                      ├─ Canal (provedor plugável: ZernioProvider; MetaCloudProvider no futuro)
                      ├─ Conversas e mensagens (por empresa, isoladas)
                      ├─ Motor de IA (modos: desligado · copiloto · automático)
                      │    ├─ entendimento e estado da conversa
                      │    ├─ ferramentas → API do produto (catálogo, agenda, contato)
                      │    ├─ barreira de segurança antes de qualquer envio
                      │    └─ passagem para humano (fila, resumo, assumir conversa)
                      ├─ Avisos para os produtos (webhooks assinados)
                      └─ Uso e custos por empresa
                             ⇅
              Clinova · Agenda+ · Belariz (API padrão)
```

Origem do código:
- **Canal Zernio, conversas, ligação com lead:** vem do Clinova (feito e testado em 2026-11-06).
- **Motor de IA, segurança, passagem para humano, avaliação:** vem do Agenda+ (`src/ai`, ~9 mil linhas, desenhado com interfaces).

O provedor de WhatsApp fica atrás de uma interface própria. Se a Zernio falhar, encarecer ou mudar, troca-se o provedor só aqui.

## 5. API padrão do produto (Aura IA → produto)

Todo produto implementa os mesmos endpoints. Requisições assinadas (HMAC) pela Aura IA; respostas em JSON.

| Endpoint | Para quê | Fase |
|---|---|---|
| `POST /aura/contacts/resolve` | Dado telefone/nome: quem é (lead, cliente), cria lead se for novo | 1 |
| `GET /aura/catalog` | Serviços, duração, preço (e se o preço pode ser dito) | 2 |
| `GET /aura/business-info` | Endereço, horário de funcionamento, políticas, FAQ | 2 |
| `GET /aura/availability` | Horários livres por serviço/profissional/período | 3 |
| `POST /aura/bookings` | Marcar (com revalidação do horário e chave de idempotência) | 3 |
| `PATCH /aura/bookings/{id}` | Confirmar, remarcar, cancelar | 3 |
| `GET /aura/contacts/{id}/bookings` | Próximos horários do cliente | 3 |

Cada produto pode responder "não suportado" a um endpoint; a IA então não oferece aquela ação.

## 6. API da Aura IA (produto → Aura IA)

| Endpoint | Para quê |
|---|---|
| `POST /v1/workspaces` | Criar a empresa na Aura (ao ativar o WhatsApp no produto) |
| `POST /v1/workspaces/{id}/channel/connect` | Iniciar a conexão do número (devolve o link da Meta/Zernio) |
| `GET /v1/workspaces/{id}/conversations` | Lista de conversas (para a tela do produto) |
| `GET /v1/conversations/{id}/messages` | Mensagens |
| `POST /v1/conversations/{id}/messages` | Enviar texto (dentro de 24h) |
| `POST /v1/workspaces/{id}/templates/send` | Enviar modelo aprovado (abrir conversa / após 24h) |
| `POST /v1/conversations/{id}/suggest` | Copiloto: sugerir resposta |
| `POST /v1/conversations/{id}/handoff` · `/takeover` · `/release` | Humano assume / devolve para a IA |

Avisos da Aura IA para o produto (assinados): `contact.created`, `message.received`, `message.sent`, `message.status`, `conversation.handoff_requested`, `booking.created_by_ai`.

## 7. Segurança e dados

- Isolamento por empresa em todas as tabelas (RLS) e em todas as chamadas de API.
- Chaves da Zernio e da OpenAI só no servidor da Aura IA. Produtos usam chaves próprias, revogáveis.
- Avisos assinados nos dois sentidos (Zernio → Aura, Aura → produto) e sem repetição (id do evento).
- Logs sem conteúdo de mensagem; métricas agregadas.
- IA nunca dá orientação clínica; responde dados administrativos só com fonte; na dúvida, passa para humano.
- LGPD: minimização, prazo de guarda das conversas por empresa, exclusão a pedido. Pendente contrato (DPA) com a Zernio e a OpenAI.

## 8. Tecnologia

- Supabase dedicado (Postgres + Edge Functions em Deno/TypeScript), separado dos produtos.
- Ambientes: homologação e produção separados desde o início.
- Testes: unitários, testes de banco (RLS e funções) e a bateria de avaliação da IA (vinda do Agenda+).
- Uma conta Zernio da Kynovia; um *profile* por empresa; um webhook único da Aura IA.

## 9. Fases

| Fase | Entrega | Resultado para o cliente |
|---|---|---|
| **1. Base + canal** | Produtos, empresas, chaves; canal Zernio movido do Clinova; conversas; avisos para o produto; `contacts/resolve` | Clinova continua igual para o usuário, agora sobre a Aura IA |
| **2. Copiloto** | Motor de IA do Agenda+ adaptado; botão "Sugerir resposta"; catálogo e informações da empresa | Recepção responde mais rápido, revisando a sugestão |
| **3. Agenda** | Ferramentas de agenda pela API padrão; Clinova primeiro, depois Agenda+ | IA consulta horários e marca com confirmação |
| **4. Automático + humano** | Modo automático (ex.: fora do horário), fila de passagem para humano, assumir conversa | Atendimento 24h com segurança |
| **5. Escala** | Uso e custo por empresa, painel de saúde, cobrança, Belariz | Pronto para muitos clientes e novos segmentos |

## 10. Migrações

- **Clinova:** as tabelas `whatsapp_*` e as funções `whatsapp`/`whatsapp-webhook` passam para a Aura IA. As telas Conversas e a aba WhatsApp ficam no Clinova, lendo da Aura. O Clinova implementa a API padrão.
- **Agenda+:** deixa a conexão direta com a Meta; o número passa a ser conectado pela Aura IA (Zernio). O motor de IA sai do Agenda+ e passa a morar aqui.

## 11. Decisões em aberto

1. Criar o projeto Supabase da Aura IA (homologação e produção).
2. Preço: mensalidade da Zernio dentro do plano ou como adicional "WhatsApp integrado".
3. Com a Zernio: preço por profile, cobrança da Meta, DPA/LGPD, SLA, limites de envio.
4. Telas de conversa: cada produto desenha a sua (decisão atual) ou a Aura oferece uma tela pronta embutível.
