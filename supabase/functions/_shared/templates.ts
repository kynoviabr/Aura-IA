/**
 * Pacote de modelos padrão (Meta) criado em cada número conectado.
 * Sem modelo aprovado a empresa não consegue iniciar conversa nem responder depois de 24h.
 * Categoria UTILITY (atendimento), português. A Meta revisa em até 24h.
 * Variáveis: {{1}} nome do cliente, {{2}} nome da empresa, {{3}} detalhe (data/hora ou assunto).
 */
import type { ZernioClient } from './zernio.ts';

export type StandardTemplate = { name: string; body: string; example: string[] };

export const STANDARD_TEMPLATES: StandardTemplate[] = [
  {
    name: 'aura_retomar_atendimento',
    body: 'Olá {{1}}, aqui é da {{2}}. Estamos retomando o seu atendimento. Pode responder esta mensagem para continuarmos?',
    example: ['Maria', 'Clínica Bella'],
  },
  {
    name: 'aura_confirmacao_agendamento',
    body: 'Olá {{1}}, seu horário na {{2}} está agendado para {{3}}. Se precisar remarcar, é só responder esta mensagem.',
    example: ['Maria', 'Clínica Bella', '12/11 às 15h'],
  },
  {
    name: 'aura_lembrete_horario',
    body: 'Olá {{1}}, lembrete do seu horário na {{2}}: {{3}}. Responda SIM para confirmar ou nos chame para remarcar.',
    example: ['Maria', 'Clínica Bella', 'amanhã às 15h'],
  },
];

export const STANDARD_LANGUAGE = 'pt_BR';

/** Formato que a Meta espera para criar o modelo (corpo com exemplo das variáveis). */
export function templateComponents(t: StandardTemplate) {
  return [{ type: 'BODY', text: t.body, example: { body_text: [t.example] } }];
}

export type EnsureResult = { created: string[]; existing: string[]; failed: { name: string; error: string }[] };

/** Cria os modelos padrão que ainda não existem no número. Nunca lança erro: devolve o resumo. */
export async function ensureStandardTemplates(z: Pick<ZernioClient, 'templateNames' | 'createTemplate'>, accountId: string): Promise<EnsureResult> {
  const result: EnsureResult = { created: [], existing: [], failed: [] };
  let existing: Set<string>;
  try {
    existing = new Set(await z.templateNames(accountId));
  } catch (e) {
    return { ...result, failed: [{ name: '*', error: (e as Error).message }] };
  }
  for (const t of STANDARD_TEMPLATES) {
    if (existing.has(t.name)) { result.existing.push(t.name); continue; }
    try {
      await z.createTemplate(accountId, { name: t.name, category: 'UTILITY', language: STANDARD_LANGUAGE, components: templateComponents(t) });
      result.created.push(t.name);
    } catch (e) {
      result.failed.push({ name: t.name, error: (e as Error).message });
    }
  }
  return result;
}
