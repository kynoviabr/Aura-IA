# Spike MM-0 — Mídia no WhatsApp pela Zernio

**Status:** em andamento · iniciado em 18/11/2026
**Objetivo:** confirmar em homologação o que a Zernio suporta de mídia antes de escrever o MM-0
(ver `docs/ROADMAP_MENSAGERIA_MULTIMODAL.md` §5.9).

## 1. O que a documentação da Zernio já diz

Fonte: docs.zernio.com (páginas `webhooks/inbox/message-received`, `messages/send-inbox-message`,
`platforms/whatsapp/reference`, `guides/media-uploads`), lidas em 18/11/2026.

### Mídia recebida (`message.received`)

| Campo | O que é |
|---|---|
| `message.attachments[].type` | `image`, `video`, `audio`, `file`, `sticker` (no WhatsApp) |
| `message.attachments[].mimeType` | tipo do arquivo, **quando a Zernio sabe** (pode faltar) |
| `message.attachments[].url` | no WhatsApp aponta para `GET /v1/whatsapp/media/{mediaId}` na API da Zernio, com `Authorization: Bearer <chave>` |
| `message.attachments[].payload.voice` | `true` = áudio gravado no WhatsApp (voice note); `false` = arquivo de áudio |

Pontos importantes:
- **O download tem que acontecer quando o webhook chega.** A Meta apaga a mídia recebida depois de um prazo;
  depois disso a Zernio devolve `400` para sempre. Hoje a Aura só guarda o JSON do anexo e nunca baixa.
- A doc **não** informa tamanho, duração nem nome do arquivo no webhook. Isso só aparece ao baixar.
- O `url` exige a chave da Zernio: nunca pode ir para o produto, para o Console nem para a IA.

### Mídia enviada (`POST /v1/inbox/conversations/{id}/messages`)

| Campo | O que é |
|---|---|
| `attachmentUrl` | URL **pública**, que devolve o próprio arquivo (sem login) |
| `attachmentType` | `image`, `video`, `audio`, `file` (padrão `file`) |
| `attachmentName` | nome exibido de documento (só `file`) |
| `voiceNote` | `true` em áudio = envia como mensagem de voz; exige `.ogg` Opus mono |
| `message` | texto junto (legenda); não existe campo `caption` |

- Também aceita envio do arquivo por `multipart/form-data` (nomes dos campos não documentados).
- Resposta: `data.messageId` (wamid), `data.conversationId`, `data.attachments[]`.
- Tem idempotência por chave (mesma chave + mesmo corpo repete a resposta; corpo diferente = `422`;
  ainda processando = `409`). Depois de `503`/timeout: listar as mensagens da conversa antes de reenviar.
- Áudio não pode ir junto com botões (`400`).
- Hospedagem opcional na Zernio: `POST /v1/media/presign` → `PUT` no `uploadUrl` (vale 1h) → `publicUrl` (vale 7 dias).

### Limites do WhatsApp

| Tipo | Formatos | Máximo |
|---|---|---|
| Imagem | JPEG, PNG | 5 MB |
| Vídeo | MP4, 3GPP (H.264 + AAC) | 16 MB |
| Áudio | MP3, OGG (Opus), AMR, AAC | 16 MB |
| Documento | PDF, DOC(X), XLS(X), PPT(X), TXT | 100 MB |

Se o WhatsApp não conseguir baixar a URL enviada: erro `131052`.

## 2. O que falta confirmar em homologação

| # | Pergunta | Como confirmar | Resultado |
|---|---|---|---|
| 1 | Formato real do anexo no webhook (áudio, voice note, imagem, vídeo, documento, figurinha) | Consulta da §3.1 depois de mandar cada tipo | — |
| 2 | `mimeType` vem preenchido? Para quais tipos? | idem | — |
| 3 | O download funciona com a chave da Aura? Quais cabeçalhos vêm (`Content-Type`, `Content-Length`)? | `scripts/spike-zernio-midia.mjs baixar` | — |
| 4 | Por quanto tempo o download continua funcionando? | Repetir o item 3 depois de 1h, 24h, 7 dias e 30 dias | — |
| 5 | Formato do voice note recebido (esperado: OGG Opus) | `baixar` mostra o tipo detectado pelos primeiros bytes | — |
| 6 | Envio de imagem e de áudio comum por URL pública | `scripts/spike-zernio-midia.mjs enviar` | — |
| 7 | Envio com `voiceNote: true` aparece como mensagem de voz no celular? | `enviar` com um `.ogg` Opus mono | — |
| 8 | Envio por URL assinada do Supabase Storage (privada, com prazo) funciona? | `enviar` com uma signed URL de 10 min | — |
| 9 | O eco `message.sent` da mídia enviada pela Aura chega? Com quais campos? | Consulta da §3.1 | — |
| 10 | Status `delivered`/`read`/`failed` chegam para mídia? | `messages.status` no banco | — |
| 11 | Nome do cabeçalho de idempotência e comportamento após timeout | Ler a doc completa e testar um reenvio | — |

## 3. Roteiro

Pré-requisitos (feitos por você, sem mandar chaves por mensagem):
- um número de teste conectado a uma empresa no **Aura-Homolog**, com a IA em `off`;
- um celular para mandar mídia a esse número;
- `ZERNIO_API_KEY` exportada só no terminal local que vai rodar o script.

### 3.1 Receber

1. Do celular, mande para o número de teste: uma foto, um vídeo curto, um áudio gravado (voice note),
   um arquivo de áudio (.mp3), um PDF e uma figurinha.
2. No SQL Editor do Aura-Homolog, rode a consulta abaixo. Ela mostra **só a estrutura** (campos e tipos),
   sem textos, telefones ou URLs:

```sql
select m.direction, a->>'type' as tipo,
       (select string_agg(k || ':' || jsonb_typeof(a->k), ', ' order by k) from jsonb_object_keys(a) k) as campos,
       a->>'mimeType' as mime,
       a#>>'{payload,voice}' as voz,
       a->>'url' ~ '/whatsapp/media/' as url_zernio,
       m.sent_at
from public.messages m, jsonb_array_elements(m.attachments) a
where m.sent_at > now() - interval '1 day'
order by m.sent_at desc;
```

3. Para cada anexo, copie o `url` (consulta: `select a->>'url' from ...`) e rode `baixar` (§3.2).

### 3.2 Baixar (sem guardar o arquivo)

```bash
ZERNIO_API_KEY=... node scripts/spike-zernio-midia.mjs baixar "<url do anexo>"
```

Mostra status HTTP, cabeçalhos de tipo e tamanho, bytes recebidos, tempo e o formato detectado pelos
primeiros bytes. O conteúdo é descartado.

### 3.3 Enviar

Hospede os arquivos de teste numa URL pública temporária (ou numa signed URL do Storage do Aura-Homolog) e rode:

```bash
ZERNIO_API_KEY=... node scripts/spike-zernio-midia.mjs enviar <conversationId da Zernio> <accountId> image "<url>"
```

`<tipo>` = `image`, `video`, `audio`, `voice` (áudio com `voiceNote: true`) ou `file`.
O `conversationId` e o `accountId` da Zernio estão em `conversations.provider_conversation_id` e `channels.provider_account_id`.

## 4. Entregáveis

- tabela da §2 preenchida;
- fixtures **sem dados pessoais** em `tests/fixtures/zernio/` (um `message.received` por tipo de mídia, com ids, telefones, nomes e URLs trocados);
- teste de contrato do adapter (`zernio.ts`) usando essas fixtures;
- decisão registrada: download no webhook (em segundo plano) para o Storage privado, com prazo de guarda.

## 5. Conclusões até agora

- O MM-0 precisa **baixar a mídia logo que o webhook chega** (em segundo plano, como já é feito com a resposta
  automática). Deixar para baixar quando a IA precisar não funciona, porque a mídia expira na Meta.
- Para enviar mídia, a Zernio precisa de uma URL pública. O candidato natural é uma signed URL de curta duração
  do Storage privado da Aura (item 8), sem deixar o bucket público.
- `voiceNote` exige OGG Opus mono: o TTS do MM-3 terá que gerar nesse formato ou converter.
