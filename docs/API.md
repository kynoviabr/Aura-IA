# API da Aura IA para os produtos (Fase 1)

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
| POST | `/v1/conversations/:id/messages` | Responder com texto (até 24h) `{ text, sentBy? }` → `{ message: { id, status, body } }` |
| POST | `/v1/conversations/:id/read` | Marcar como lida |
| GET | `/v1/workspaces/:ext/templates` | Modelos aprovados pela Meta |
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
