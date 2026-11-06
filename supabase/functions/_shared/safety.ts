/**
 * Regras de segurança da IA de atendimento (vindas do validador do Agenda+).
 * No copiloto a pessoa da empresa revisa antes de enviar: as regras não reescrevem a mensagem,
 * geram avisos para quem vai enviar. Só dado interno vazado bloqueia a sugestão.
 */

export type SafetyFlag =
  | 'urgent'            // cliente descreve possível urgência de saúde
  | 'health_topic'      // assunto de saúde (reação, gestação, remédio...)
  | 'medical_advice'    // a sugestão parece dar orientação médica
  | 'unsupported_number'// número/valor/horário que não veio dos dados da empresa nem da conversa
  | 'action_claim'      // diz que agendou/cancelou/confirmou (a IA ainda não faz isso)
  | 'injection'         // cliente tenta mudar o comportamento da IA
  | 'wants_human'       // cliente pediu para falar com uma pessoa
  | 'hidden_data';      // a sugestão contém dado interno (bloqueia)

export const FLAG_TEXT: Record<SafetyFlag, string> = {
  urgent: 'Possível urgência de saúde. Passe para a profissional e oriente procurar atendimento médico.',
  health_topic: 'Assunto de saúde. Confira com a profissional antes de enviar.',
  medical_advice: 'A sugestão parece dar orientação médica. Revise antes de enviar.',
  unsupported_number: 'Há número, valor ou horário que não veio dos dados da empresa. Confira.',
  action_claim: 'A sugestão diz que algo foi agendado ou alterado. Confira na agenda antes de enviar.',
  injection: 'O cliente tentou mudar o comportamento da IA.',
  wants_human: 'O cliente pediu para falar com uma pessoa.',
  hidden_data: 'A sugestão continha dado interno e foi bloqueada.',
};

export function normalize(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
}

const URGENT = /\b(?:dor forte no peito|nao consigo respirar|falta de ar|desmaiei|desmaio|sangramento (?:intenso|forte|que nao para)|acho que vou morrer|febre alta|pus|necrose|pele (?:escura|preta|branca e fria)|perda de visao|vista embacada|nao consigo enxergar|rosto (?:todo )?inchado e (?:dor|febre)|reacao alergica|anafilaxia|garganta fechando)\b/;
const HEALTH = /\b(?:inchad[oa]|inchaco|roxo|roxa|hematoma|dor(?:es)?|doendo|doi|alergi\w*|reacao|vermelh\w+|coceira|ardencia|ardendo|infecc\w*|infeccionad\w*|febre|gravida|gestante|gestacao|amamentando|amamentacao|lactante|remedio|medicamento|anti-?inflamatorio|antibiotico|dose|unidades? de botox|diabet\w*|hipertens\w*|cancer|cirurgia|herpes|queloide|cicatriz|manchas? (?:apareceu|apareceram|nova)|espinhas?|caroco|nodulo|menor de idade|1[0-7] anos)\b/;
const INJECTION = /\b(?:ignore (?:todas? )?(?:(?:as|suas) )?(?:regras|instrucoes)(?: anteriores)?|system prompt|prompt (?:de|do) sistema|seu prompt|revele (?:as )?(?:suas )?instrucoes|finja que (?:e|voce e)|aja como|modo desenvolvedor|jailbreak)\b/;
const WANTS_HUMAN = /\b(?:falar com (?:uma |um )?(?:pessoa|atendente|humano|alguem|gerente|responsavel)|pessoa de verdade|nao (?:quero falar )?com (?:um )?robo|atendimento humano)\b/;

const MEDICAL_ADVICE = [
  /\b(?:pode tomar|recomendo (?:tomar|usar|passar)|tome (?:um|uma|o|a)|use (?:um|uma|o|a) (?:pomada|creme|remedio)|passe (?:gelo|pomada|creme)|prescrev\w+)\b/,
  /\b\d+\s*(?:mg|ml|ui|unidades)\b/,
  /\b(?:isso e (?:normal|esperado)|nao e nada grave|e so (?:um )?(?:inchaco|hematoma)|vai passar sozinh)\b/,
  /\b(?:voce (?:pode|nao pode) fazer|e seguro (?:fazer|para)|nao tem (?:risco|problema)) .{0,40}(?:gravid|gestan|amament|botox|preenchimento|laser)/,
];

const ACTION_CLAIM = /\b(?:agendei|marquei|reservei|esta (?:agendad[oa]|marcad[oa]|confirmad[oa]|reservad[oa])|ja (?:agendei|marquei|cancelei|remarquei)|cancelei|remarquei|agendamento (?:feito|realizado|confirmado))\b/;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const RAW_ERROR = /\b(?:PGRST\w*|SQLSTATE|stack trace|service_role|postgresql|api[_ -]?key|bearer\s+[\w.-]{10,}|clinic_id|workspace_id|external_id|sk-[a-z0-9-]{10,}|aura_[a-z0-9]{10,})\b/i;

/** Avisos sobre a mensagem do cliente (antes da IA). */
export function inspectIncoming(text: string): SafetyFlag[] {
  const t = normalize(text);
  const flags: SafetyFlag[] = [];
  if (URGENT.test(t)) flags.push('urgent');
  if (flags.includes('urgent') || HEALTH.test(t)) flags.push('health_topic');
  if (INJECTION.test(t)) flags.push('injection');
  if (WANTS_HUMAN.test(t)) flags.push('wants_human');
  return flags;
}

/**
 * Números citados num texto, normalizados para comparar: "R$ 1.200,00" -> "1200", "14h30" -> "14:30", "10:00" -> "10".
 * Números de um dígito sem R$ (ex.: "3 sessões") não contam: são comuns demais para indicar invenção.
 */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  const re = /(r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)(?:\s*(?:h|:)\s*(\d{2}))?/gi;
  for (const m of text.matchAll(re)) {
    const money = !!m[1];
    let n = m[2].replace(/\./g, '').replace(',', '.');
    n = String(Number(n));
    if (!money && !m[3] && Number(n) < 10) continue;
    out.push(m[3] && m[3] !== '00' ? `${n}:${m[3]}` : n);
  }
  return out;
}

export type SafetyInput = {
  draft: string;
  /** Última(s) mensagem(ns) do cliente que a sugestão responde. */
  incoming: string;
  /** Tudo que a IA podia usar como fonte: dados da empresa e conversa anterior. */
  sources: string[];
};

export type SafetyResult = { flags: SafetyFlag[]; handoff: boolean; blocked: boolean };

export function checkSuggestion(input: SafetyInput): SafetyResult {
  const flags = new Set<SafetyFlag>(inspectIncoming(input.incoming));
  const draft = normalize(input.draft);

  if (UUID.test(input.draft) || RAW_ERROR.test(input.draft)) flags.add('hidden_data');
  if (MEDICAL_ADVICE.some((re) => re.test(draft))) flags.add('medical_advice');
  if (ACTION_CLAIM.test(draft)) flags.add('action_claim');

  const allowed = new Set(input.sources.flatMap(numbersIn).concat(numbersIn(input.incoming)));
  if (numbersIn(input.draft).some((n) => !allowed.has(n))) flags.add('unsupported_number');

  const list = [...flags];
  return {
    flags: list,
    handoff: list.some((f) => f === 'urgent' || f === 'wants_human'),
    blocked: flags.has('hidden_data'),
  };
}

/** Valores em reais citados na mensagem que não aparecem nas fontes (preço inventado). */
export function unsupportedMoney(draft: string, sources: string[]): string[] {
  const allowed = new Set(sources.flatMap(numbersIn));
  const out: string[] = [];
  for (const m of draft.matchAll(/r\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/gi)) {
    const n = String(Number(m[1].replace(/\./g, '').replace(',', '.')));
    if (!allowed.has(n)) out.push(n);
  }
  return out;
}
