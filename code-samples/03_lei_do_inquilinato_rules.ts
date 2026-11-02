/**
 * Business rules from Brazilian rental practice, written as pure functions
 *
 * Two pieces of logic that agencies usually work out by hand or in a spreadsheet:
 *
 *   1. calculateLateFees: what a tenant owes on a late rent payment
 *      (multa = one-time late penalty, juros = interest).
 *   2. suggestResponsibility: who pays for a repair, the landlord (locador)
 *      or the tenant (locatário), based on articles 22 and 23 of the
 *      Lei do Inquilinato (Lei 8.245/91).
 *
 * Both are pure functions (no database, no I/O), so they run the same way on
 * the server and in the browser and are easy to test.
 *
 * Adapted from the production code: the late fee logic is unchanged; the
 * responsibility rules are trimmed to four categories (production covers ten).
 * The output is a suggestion with a confidence level, not legal advice; the
 * agent confirms it before any cost is charged.
 */

// ─── 1. Late fees ──────────────────────────────────────────────────────────────

export interface LateFees {
  daysOverdue: number;
  multaCentavos: number;  // one-time penalty
  jurosCentavos: number;  // interest, pro rata per day
  totalCentavos: number;  // original amount + multa + juros
}

/**
 * Late fees on an overdue charge.
 *
 * Defaults are 2% multa and 1% a month juros, common in residential contracts.
 * Each agency can change them in its settings, so they come in as parameters
 * in basis points (200 bps = 2%) rather than constants.
 *
 * The result is computed when a charge is displayed, never stored: the
 * amount owed changes every day, and a stored value would go stale.
 */
export function calculateLateFees(
  originalAmountCentavos: number,
  dueDate: Date,
  asOfDate: Date = new Date(),
  multaBps: number = 200,
  jurosMonthlyBps: number = 100,
): LateFees {
  // Compare calendar days, not timestamps, so a payment made late at night
  // on the due date is not counted as one day late.
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const ref = new Date(asOfDate);
  ref.setHours(0, 0, 0, 0);

  const daysOverdue = Math.max(0, Math.round((ref.getTime() - due.getTime()) / 86_400_000));

  if (daysOverdue === 0) {
    return { daysOverdue: 0, multaCentavos: 0, jurosCentavos: 0, totalCentavos: originalAmountCentavos };
  }

  const multaRate = multaBps / 10000;
  const jurosMonthlyRate = jurosMonthlyBps / 10000;

  // Multa applies once, whatever the delay.
  const multaCentavos = Math.round(originalAmountCentavos * multaRate);
  // Juros is simple interest on a 30-day month: 1% a month is about 0.033% a day.
  const jurosCentavos = Math.round(originalAmountCentavos * (jurosMonthlyRate / 30) * daysOverdue);

  return {
    daysOverdue,
    multaCentavos,
    jurosCentavos,
    totalCentavos: originalAmountCentavos + multaCentavos + jurosCentavos,
  };
}

// Example: rent of R$ 2.500,00 paid 10 days late, with the default rates
//   calculateLateFees(250000, new Date("2026-05-05"), new Date("2026-05-15"))
//   -> { daysOverdue: 10, multaCentavos: 5000, jurosCentavos: 833, totalCentavos: 255833 }
//   i.e. R$ 50,00 multa + R$ 8,33 juros = R$ 2.558,33

// ─── 2. Repair responsibility (art. 22 and 23) ─────────────────────────────────
//
// Art. 22 lists the landlord's duties: for example, defects that existed
// before the lease began (inciso IV) and extraordinary building costs.
// Art. 23 lists the tenant's: for example, minor upkeep from normal use and
// returning the property in the condition it was received (inciso III).
//
// The rules below turn a category plus the free-text description of a
// maintenance request into a suggestion that the agent can accept or change.

export type Category = "ESTRUTURAL" | "HIDRAULICA" | "PINTURA" | "DEDETIZACAO" | "OUTROS";
export type Responsibility = "LOCADOR" | "LOCATARIO" | "INDEFINIDO";
export type Confidence = "ALTA" | "MEDIA" | "BAIXA";

export interface ResponsibilityResult {
  party: Responsibility;
  confidence: Confidence;
  legalBasis: string;
  reasoning: string; // shown to the agent in Portuguese, next to the suggestion
}

export function suggestResponsibility(
  category: Category,
  description: string,
  unitOccupiedSinceDays: number,
): ResponsibilityResult {
  const d = description.toLowerCase();

  switch (category) {
    // Structural defects are always the landlord's.
    case "ESTRUTURAL":
      return {
        party: "LOCADOR", confidence: "ALTA",
        legalBasis: "Lei 8.245/91 art. 22, IV",
        reasoning: "Vícios estruturais e defeitos anteriores à locação são de responsabilidade do locador.",
      };

    // Plumbing depends on the root cause, so the description is read for
    // keywords. The regexes accept spellings with or without accents
    // ("infiltração" / "infiltracao"), as people type in a hurry.
    case "HIDRAULICA": {
      if (/vazamento|infiltra[çc][ãa]o|encanamento|esgoto/.test(d))
        return { party: "LOCADOR", confidence: "ALTA", legalBasis: "Lei 8.245/91 art. 22",
          reasoning: "Vazamentos, infiltrações e problemas de encanamento são de responsabilidade do locador." };
      if (/torneira|courinho|veda[çc][ãa]o|registro|descarga/.test(d))
        return { party: "LOCATARIO", confidence: "MEDIA", legalBasis: "Lei 8.245/91 art. 23",
          reasoning: "Manutenção de torneiras, vedações e descargas é responsabilidade de rotina do locatário." };
      return { party: "INDEFINIDO", confidence: "BAIXA", legalBasis: "Lei 8.245/91 art. 22 e 23",
        reasoning: "Categoria depende da causa raiz. Solicite vistoria para definir responsabilidade." };
    }

    // Painting uses time in the unit as a signal: early on, a problem
    // probably predates the lease; later, it is more likely wear from use.
    case "PINTURA": {
      if (/externa|fa[çc]ada|estrutural/.test(d))
        return { party: "LOCADOR", confidence: "ALTA", legalBasis: "Lei 8.245/91 art. 22, par. único, b",
          reasoning: "Pintura externa, fachada e estrutural são de responsabilidade do locador." };
      if (unitOccupiedSinceDays > 90)
        return { party: "LOCATARIO", confidence: "MEDIA", legalBasis: "Lei 8.245/91 art. 23, III",
          reasoning: "Pintura interna após 90 dias de ocupação é de responsabilidade do locatário ao restituir o imóvel." };
      return { party: "LOCADOR", confidence: "MEDIA", legalBasis: "Lei 8.245/91 art. 22, IV",
        reasoning: "Possível vício oculto: ocorrência nos primeiros 90 dias. Solicite vistoria comparativa." };
    }

    // Pests found in the first month are presumed to predate the lease.
    case "DEDETIZACAO":
      if (unitOccupiedSinceDays < 30)
        return { party: "LOCADOR", confidence: "ALTA", legalBasis: "Lei 8.245/91 art. 22, IV",
          reasoning: "Pragas detectadas nos primeiros 30 dias presumem-se pré-existentes à locação." };
      return { party: "LOCATARIO", confidence: "ALTA", legalBasis: "Lei 8.245/91 art. 23",
        reasoning: "Controle de pragas após 30 dias de ocupação é responsabilidade do locatário." };

    // When the rules can't tell, say so instead of guessing.
    case "OUTROS":
    default:
      return { party: "INDEFINIDO", confidence: "BAIXA", legalBasis: "Lei 8.245/91 art. 22 e 23",
        reasoning: "Análise manual necessária. Verifique com vistoria técnica." };
  }
}
