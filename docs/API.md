# API da Aura IA para os produtos

Base: `https://<projeto>.supabase.co/functions/v1/api`
Autenticação: `Authorization: Bearer aura_...` (chave do produto, entregue pela Kynovia).
Empresas são endereçadas pelo id delas no produto (`:ext`, ex.: `clinic_id` do Clinova).

| Método | Rota | Para quê |
|---|---|---|
| GET | `/v1/health` | Verificar se a Aura está no ar (sem chave) |
| PUT | `/v1/workspaces/:ext` | Cadastrar/atualizar a empresa `{ name, timezone? }` |
| GET | `/v1/workspaces/:ext/channel` | Situação do WhatsApp da empresa |
| POST | `/v1/workspaces/:ext/channel/connect` | Iniciar conexão do número `{ redirectUrl }` → `{ authUrl }` |
| POST | `/v1/workspaces/:ext/channel/finish` | Concluir conexão `{ accountId }` (vem no retorno da Meta/Zernio) |
| GET | `/v1/workspaces/:ext/conversations?limit&before&contact_ref` | Lista de conversas |
| GET | `/v1/conversations/:id` | Conversa (com `window_open`) |
| GET | `/v1/conversations/:id/messages` | Mensagens |
| POST | `/v1/conversations/:id/messages` | Responder com texto (até 24h) `{ text, sentBy?, suggestionId? }` → `{ message: { id, status, body } }`. Mande `suggestionId` quando a mensagem veio do copiloto |
| POST | `/v1/conversations/:id/suggest` | Copiloto: sugere a próxima mensagem (não envia) → `{ suggestion: { id, text, outcome, handoff, flags: [{ code, text }], sources: { catalog, businessInfo } } }` |
| POST | `/v1/conversations/:id/read` | Marcar como lida |
| GET/PUT | `/v1/workspaces/:ext/ai` | Modo da IA da empresa `{ mode: "off" \| "copilot" \| "auto" }` |
| POST | `/v1/conversations/:id/ai` | Pausar a IA nesta conversa `{ paused: true, hours?, reason? }` ou devolver `{ paused: false }` |
| GET | `/v1/workspaces/:ext/templates?status=all` | Modelos aprovados pela Meta (com `status=all`, também os em revisão e recusados) |
| POST | `/v1/workspaces/:ext/templates/standard` | Cria os modelos padrão que faltam (também feito automaticamente ao conectar o número) |
| POST | `/v1/workspaces/:ext/templates/send` | Enviar modelo `{ conversationId? \| phone, templateName, language, params, templateBody?, contact?{ name, externalType, externalRef }, sentBy? }` → `{ conversationId, contactId, message: { id, status, body } }` |
| PATCH | `/v1/contacts/:id` | Dizer quem é o contato no produto `{ name?, externalType?, externalRef? }` |

Erros: `{ "error": { "code": "window_closed", "message": "..." } }`.
Telefone: sem "+" e com 10/11 dígitos é Brasil; com "+" é internacional.

## Avisos da Aura para o produto

`POST` no `webhook_url` do produto, assinado: cabeçalho `X-Aura-Signature` = HMAC-SHA256 (hex) do corpo com o `webhook_secret`.
Corpo: `{ id, type, created_at, data }`. Responder 2xx; senão a Aura tenta de novo (1, 5, 15, 60 min, depois a cada 6h, até 8 vezes).
Use `id` para não processar duas vezes.

| type | data |
|---|---|
| `contact.created` | `{ workspace, contact }` — número novo: o produto cria o lead e responde com PATCH /v1/contacts/:id |
| `message.received` | `{ workspace, conversation_id, contact, message }` |
| `message.sent` | idem (mensagens enviadas fora da Aura, ex.: celular) |
| `message.status` | `{ workspace, conversation_id, message: { id, status } }` |

## Modelos padrão

Ao concluir a conexão do número (`channel/finish`), a Aura cria em português, categoria utilidade:

| Modelo | Texto |
|---|---|
| `aura_retomar_atendimento` | Olá {{1}}, aqui é da {{2}}. Estamos retomando o seu atendimento. Pode responder esta mensagem para continuarmos? |
| `aura_confirmacao_agendamento` | Olá {{1}}, seu horário na {{2}} está agendado para {{3}}. Se precisar remarcar, é só responder esta mensagem. |
| `aura_lembrete_horario` | Olá {{1}}, lembrete do seu horário na {{2}}: {{3}}. Responda SIM para confirmar ou nos chame para remarcar. |

{{1}} = nome do cliente, {{2}} = nome da empresa, {{3}} = data/hora. A Meta revisa em até 24h; até lá eles aparecem com `status=all`.

## Copiloto (Fase 2)

`POST /v1/conversations/:id/suggest` lê as últimas 30 mensagens, pede ao produto o catálogo e os dados da empresa
(API padrão abaixo) e devolve uma sugestão. Quem envia é sempre uma pessoa (com `suggestionId` no envio, para medir o uso).

- `flags`: avisos para quem vai enviar (`health_topic`, `urgent`, `medical_advice`, `unsupported_number`, `action_claim`,
  `injection`, `wants_human`, `hidden_data`). `text` traz a frase pronta para mostrar na tela.
- `handoff: true`: o cliente pediu uma pessoa ou há possível urgência.
- `outcome: blocked`: a sugestão foi descartada por segurança (`text` vazio).
- `sources`: `ok`, `unsupported`, `error` ou `not_configured` para cada fonte de dados do produto.
- Erros: `402 no_credits` (empresa sem créditos), `503 ai_disabled`, `502 ai_error`.
- Custo: registrado por empresa (créditos) no Console. Modelo escolhido no Console (Configurações).

## API padrão do produto (Aura → produto)

O produto publica estes endereços na sua `api_base_url` (cadastrada no Console, em Aplicações). Cada pedido vem com:

| Cabeçalho | Valor |
|---|---|
| `X-Aura-Workspace` | id da empresa no produto (`external_id`) |
| `X-Aura-Timestamp` | segundos desde 1970 (recuse se tiver mais de 5 minutos de diferença) |
| `X-Aura-Signature` | HMAC-SHA256 (hex), com o `webhook_secret`, de `<timestamp>.<MÉTODO>.<caminho com query>.<corpo>` |

O caminho é o da URL pedida (ex.: `/functions/v1/aura-api/aura/catalog`). Responda 404 ou 501 para o que não oferece.

`GET /aura/catalog`
```json
{ "services": [{ "id": "…", "name": "Limpeza de pele", "category": "Facial", "description": "…",
    "durationMinutes": 70, "sessions": 1, "price": 180, "priceDisplay": "exact" }],
  "packages": [{ "name": "Pacote verão", "price": 900, "items": ["Limpeza de pele", "Peeling"] }] }
```
`priceDisplay`: `exact` (pode dizer o preço), `from` ("a partir de", depende de avaliação) ou `hidden` (só após avaliação).

`GET /aura/business-info`
```json
{ "name": "Clínica Bella", "address": "Av. Ana Costa, 1200 - Santos/SP", "phone": "(13) 99999-0000",
  "hours": "seg a sex 9h às 19h; sáb 9h às 13h", "payment": "Pix, débito, crédito em até 10x",
  "policies": "Remarcação com 24h de antecedência", "parking": "Conveniado no prédio",
  "professionals": [{ "name": "Dra. Carla", "specialty": "Biomédica esteta" }],
  "faq": [{ "question": "Atende sábado?", "answer": "Sim, das 9h às 13h." }], "notes": "…" }
```
Todos os campos são opcionais: a IA só usa o que vier e diz que vai confirmar com a equipe o que faltar.

## Atendimento automático (Fases 3 e 4)

Com a empresa em `mode: "auto"`, cada mensagem de cliente dispara uma resposta da IA (espera ~4s para juntar mensagens seguidas).
A IA consulta catálogo, dados da empresa e a **agenda** do produto, oferece horários, pede confirmação e só então marca.
As mensagens da IA chegam ao produto como `message.sent` com `message.source = "ai"`.

- Uma pessoa respondeu pelo produto (`POST /v1/conversations/:id/messages`): a IA pausa nesta conversa por 12h.
- A IA pede ajuda (reclamação, saúde, pedido de pessoa, dúvida que não resolve): responde com gentileza, pausa por 24h e envia
  `conversation.handoff_requested` `{ conversation_id, contact, reason }`.
- Possível urgência de saúde: mensagem fixa (procurar pronto-socorro / 192) sem passar pela IA, e equipe avisada.
- Travas: preço que não está nos dados, orientação médica, dado interno ou "agendei" sem a agenda confirmar → mensagem segura e equipe avisada.
- Cada resposta fica registrada no Console (empresa > Atendimento automático), com as ações feitas e o custo.

### Agenda na API padrão do produto

`contact` = `{ type, ref, phone, name }` (type/ref vêm de PATCH /v1/contacts; sem ref o produto acha pelo telefone ou cria um lead).
Horários com fuso explícito (ex.: `2026-11-10T14:00:00-03:00`).

| Método | Rota | Corpo / resposta |
|---|---|---|
| GET | `/aura/availability?serviceId&from&to&professionalId?` | `from`/`to` = AAAA-MM-DD (até 14 dias) → `{ timezone, slots: [{ start, end, professionalId, professionalName }] }` |
| POST | `/aura/bookings` | `{ serviceId, start, professionalId, contact, idempotencyKey }` → `201 { booking }`; horário ocupado → `409 { error: "slot_unavailable" }` |
| POST | `/aura/bookings/search` | `{ contact }` → `{ bookings: [...] }` (próximos horários) |
| POST | `/aura/bookings/:id/cancel` | `{ contact, reason }` → `{ booking }` |

`booking` = `{ id, start, end, status, serviceName, professionalName }`. O produto revalida o horário ao marcar.
