/**
 * Lease (contrato de locação) lifecycle: activation and rescission
 *
 * A lease moves through DRAFT -> ACTIVE -> (RENEWED) -> TERMINATED.
 * Two invariants matter to an agency:
 *   - A unit can only have one active lease at a time.
 *   - The unit's status (VACANT / OCCUPIED) must always match its leases,
 *     because vacancy reports and the occupancy KPI read the unit's status.
 *
 * So every status change to a lease and the matching change to its unit run in
 * one database transaction: either both happen or neither does.
 *
 * Contracts get a readable number (CT-2026-0001) when they become ACTIVE,
 * not when the draft is created, so abandoned drafts don't leave gaps
 * in the numbering.
 *
 * Adapted from the production code: the structure and logic are unchanged;
 * comments were added for this case study and the shared helpers are stubbed below.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "./db"; // Prisma client (placeholder import path)

// ─── Shared helpers (simplified) ───────────────────────────────────────────────

// Verifies the Supabase JWT from the Authorization header and returns the
// caller's accountId. Every query below is scoped by it (multi-tenancy).
declare function getAccountIdFromRequest(request: FastifyRequest): Promise<string>;

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "Não encontrado." });
const badRequest = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

const RescindSchema = z.object({
  rescissionReason: z.string().min(1),
  rescissionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
});

// ─── Contract number generator ─────────────────────────────────────────────────

/**
 * Next sequential contract number for this agency and year: CT-YYYY-NNNN.
 *
 * Known limitation: two activations at the same instant could read the same
 * "last" number. That is unlikely at a single agency's volume, but the fix
 * would be a unique index on (accountId, contractNumber) plus a retry, or a
 * per-account counter row.
 */
async function generateContractNumber(accountId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `CT-${year}-`;
  const last = await prisma.lease.findFirst({
    where: { accountId, contractNumber: { startsWith: prefix } },
    orderBy: { contractNumber: "desc" }, // zero padding makes text order match numeric order
    select: { contractNumber: true },
  });
  const seq = last?.contractNumber
    ? parseInt(last.contractNumber.slice(prefix.length), 10) + 1
    : 1;
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

// ─── Routes ────────────────────────────────────────────────────────────────────

export async function leaseLifecycleRoutes(app: FastifyInstance) {

  // POST /api/leases/:id/activate: DRAFT -> ACTIVE, unit VACANT -> OCCUPIED
  app.post<{ Params: { id: string } }>("/api/leases/:id/activate", async (request, reply) => {
    const accountId = await getAccountIdFromRequest(request).catch((e) =>
      reply.code(e.statusCode ?? 401).send({ error: e.message })
    );
    if (!accountId) return;

    // Scoping by accountId means one agency can never activate another's lease,
    // even with a guessed id.
    const lease = await prisma.lease.findFirst({
      where: { id: request.params.id, accountId, deletedAt: null },
      include: { unit: true },
    });
    if (!lease) return notFound(reply);

    if (lease.status !== "DRAFT") {
      return badRequest(reply, "Apenas contratos em rascunho podem ser ativados.");
    }

    // One active lease per unit.
    if (lease.unit.status !== "VACANT") {
      return badRequest(reply, "A unidade já está ocupada. Encerre o contrato vigente antes de ativar.");
    }

    const contractNumber = await generateContractNumber(accountId);

    // Lease and unit change together or not at all.
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.lease.update({
        where: { id: lease.id },
        data: { status: "ACTIVE", contractNumber },
      });
      await tx.unit.update({
        where: { id: lease.unitId },
        data: { status: "OCCUPIED" },
      });
      return result;
    });

    return { data: updated };
  });

  // POST /api/leases/:id/rescind: ACTIVE/RENEWED -> TERMINATED, unit -> VACANT
  //
  // Early termination (rescisão) is common under the Lei do Inquilinato
  // (Lei 8.245/91), and agencies need the reason and the effective date on
  // record for the final settlement and any later dispute.
  app.post<{ Params: { id: string } }>("/api/leases/:id/rescind", async (request, reply) => {
    const accountId = await getAccountIdFromRequest(request).catch((e) =>
      reply.code(e.statusCode ?? 401).send({ error: e.message })
    );
    if (!accountId) return;

    const parsed = RescindSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues.map((i) => i.message).join("; "));
    const { rescissionReason, rescissionDate } = parsed.data;

    const lease = await prisma.lease.findFirst({
      where: { id: request.params.id, accountId, deletedAt: null },
    });
    if (!lease) return notFound(reply);

    if (lease.status !== "ACTIVE" && lease.status !== "RENEWED") {
      return badRequest(reply, "Somente contratos ativos ou renovados podem ser rescindidos.");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.lease.update({
        where: { id: lease.id },
        data: {
          status: "TERMINATED",
          rescissionReason,
          // Parse as local midnight so the date doesn't shift a day across time zones.
          rescissionDate: new Date(rescissionDate + "T00:00:00"),
        },
      });
      await tx.unit.update({
        where: { id: lease.unitId },
        data: { status: "VACANT" },
      });
      return result;
    });

    return { data: updated };
  });
}
