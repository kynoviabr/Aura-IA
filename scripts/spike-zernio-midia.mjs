#!/usr/bin/env node
// Spike MM-0 (docs/spikes/MM-0-zernio-midia.md): testa download e envio de mídia pela Zernio.
// Não guarda arquivos nem imprime conteúdo. A chave vem só de ZERNIO_API_KEY no terminal.
//
//   node scripts/spike-zernio-midia.mjs baixar "<url do anexo>"
//   node scripts/spike-zernio-midia.mjs enviar <conversationId> <accountId> <image|video|audio|voice|file> "<url pública>" [texto]

const BASE = 'https://zernio.com/api/v1';
const key = (process.env.ZERNIO_API_KEY || '').trim();
const [cmd, ...args] = process.argv.slice(2);

function sair(msg) { console.error(msg); process.exit(1); }
if (!key) sair('Defina ZERNIO_API_KEY neste terminal.');

/** Formato pelos primeiros bytes (não confia só no Content-Type). */
function detectar(b) {
  const s = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length < 12) return 'desconhecido';
  if (s(0, 4) === 'OggS') return s(28, 8) === 'OpusHead' ? 'ogg/opus' : 'ogg';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (s(1, 3) === 'PNG') return 'png';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  if (s(4, 4) === 'ftyp') return `mp4/${s(8, 4).trim()}`; // mp4, m4a, 3gp, mov
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return (b[1] & 0xf6) === 0xf0 ? 'aac' : 'mp3';
  if (s(0, 6) === '#!AMR\n') return 'amr';
  if (s(0, 4) === '%PDF') return 'pdf';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm/mkv';
  return 'desconhecido';
}

async function baixar(url) {
  if (!url) sair('Informe a URL do anexo.');
  const u = new URL(url, BASE);
  // A chave só vai para a Zernio.
  if (u.protocol !== 'https:' || !/(^|\.)zernio\.com$/.test(u.hostname)) sair(`Host não é da Zernio: ${u.hostname}`);
  const t0 = Date.now();
  const res = await fetch(u, { headers: { Authorization: `Bearer ${key}` }, redirect: 'manual' });
  const head = Object.fromEntries(['content-type', 'content-length', 'content-disposition', 'cache-control', 'location']
    .map((h) => [h, res.headers.get(h)]).filter(([, v]) => v));
  if (head.location) head.location = new URL(head.location, u).hostname + ' (redireciona; URL omitida)';
  let bytes = 0, inicio = new Uint8Array(0);
  if (res.status === 200 && res.body) {
    for await (const chunk of res.body) {
      if (inicio.length < 64) inicio = new Uint8Array([...inicio, ...chunk.subarray(0, 64 - inicio.length)]);
      bytes += chunk.length;
    }
  } else {
    const txt = await res.text();
    head.corpo = txt.slice(0, 300);
  }
  console.log(JSON.stringify({ status: res.status, ms: Date.now() - t0, bytes, formato: bytes ? detectar(inicio) : null, cabecalhos: head }, null, 2));
}

async function enviar(conversationId, accountId, tipo, url, texto) {
  const tipos = ['image', 'video', 'audio', 'voice', 'file'];
  if (!conversationId || !accountId || !tipos.includes(tipo) || !url) sair(`Uso: enviar <conversationId> <accountId> <${tipos.join('|')}> <url> [texto]`);
  const body = { accountId, attachmentUrl: url, attachmentType: tipo === 'voice' ? 'audio' : tipo };
  if (tipo === 'voice') body.voiceNote = true;
  if (texto) body.message = texto;
  const t0 = Date.now();
  const res = await fetch(`${BASE}/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const txt = await res.text();
  let data; try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 300) }; }
  console.log(JSON.stringify({ status: res.status, ms: Date.now() - t0, resposta: data }, null, 2));
}

if (cmd === 'baixar') await baixar(args[0]);
else if (cmd === 'enviar') await enviar(...args);
else sair('Comandos: baixar <url> | enviar <conversationId> <accountId> <tipo> <url> [texto]');
