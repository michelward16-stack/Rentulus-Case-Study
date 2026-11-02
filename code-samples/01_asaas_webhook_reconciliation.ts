/**
 * Asaas webhook reconciliation (Fastify + Prisma)
 *
 * Problem: an agency issues a boleto/PIX charge through Asaas, the tenant pays
 * through their bank, and someone has to notice and mark the rent as received,
 * then work out how much is owed to the property owner. Done by hand, this is
 * a daily bank statement reconciliation.
 *
 * This route closes the loop automatically:
 *   1. Asaas calls POST /webhooks/asaas when a payment is confirmed or overdue.
 *   2. We find our own charge (Transaction) by the Asaas payment id.
 *   3. We mark it paid and add the payment to the owner's monthly payout
 *      (OwnerDistribution, called "repasse" in Brazil), net of the agency fee.
 *
 * Conventions used across the codebase:
 *   - Money is stored as integer centavos, never floats.
 *   - Rates are stored as basis points (1000 bps = 10%).
 *   - Every row is scoped by accountId (one account per agency).
 *
 * Adapted from the production code: the structure and logic are unchanged;
 * comments were added for this case study. No credentials or real data appear here.
 */

import type { FastifyInstance } from "fastify";
import { prisma } from "./db"; // Prisma client (placeholder import path)

// ─── Payload types (only the fields we use) ────────────────────────────────────

interface AsaasPaymentPayload {
  id: string;                 // Asaas payment id, saved on our Transaction when the charge is created
  status: string;
  value: number;              // Asaas sends reais as a decimal number
  billingType?: string;       // BOLETO | PIX | CREDIT_CARD | ...
  paymentDate?: string;
  clientPaymentDate?: string;
  confirmedDate?: string;
  externalReference?: string; // we set this to our Transaction id when creating the charge
}

interface AsaasWebhookBody {
  event: string;
  payment: AsaasPaymentPayload;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function mapBillingType(billingType?: string): string {
  switch (billingType) {
    case "BOLETO": return "BOLETO";
    case "PIX": return "PIX";
    case "CREDIT_CARD":
    case "DEBIT_CARD": return "CARTAO";
    default: return "OUTRO";
  }
}

/**
 * Adds one payment to the owner's payout for that month.
 *
 * Commission rule: the lease can override the rate; otherwise the owner's
 * default applies; otherwise 10%. This mirrors the batch "process month"
 * endpoint, so a webhook-driven payout and a manually processed payout give
 * the same numbers.
 */
async function upsertOwnerDistribution(
  accountId: string,
  ownerId: string,
  referenceMonth: string,          // "YYYY-MM"
  paidAmountCents: number,
  leaseCommissionRate: number | null | undefined,
) {
  let rate = leaseCommissionRate ?? null;
  if (rate == null) {
    const owner = await prisma.owner.findUnique({
      where: { id: ownerId },
      select: { commissionRate: true },
    });
    rate = owner?.commissionRate ?? 1000; // default 10% = 1000 bps
  }

  const commission = Math.round((paidAmountCents * rate) / 10000);

  const existing = await prisma.ownerDistribution.findFirst({
    where: { accountId, ownerId, referenceMonth },
  });

  if (existing) {
    const newCollected = existing.totalCollectedCents + paidAmountCents;
    const newCommission = existing.commissionCents + commission;
    const newNet = newCollected - newCommission - (existing.expensesCents ?? 0);
    await prisma.ownerDistribution.update({
      where: { id: existing.id },
      data: {
        totalCollectedCents: newCollected,
        commissionCents: newCommission,
        netDistributionCents: newNet,
        // A payout already sent to the owner's bank is never reopened.
        status: existing.status === "TRANSFERIDO" ? "TRANSFERIDO" : "A_PROCESSAR",
      },
    });
  } else {
    await prisma.ownerDistribution.create({
      data: {
        accountId,
        ownerId,
        referenceMonth,
        totalCollectedCents: paidAmountCents,
        commissionCents: commission,
        expensesCents: 0,
        netDistributionCents: paidAmountCents - commission,
        status: "A_PROCESSAR",
      },
    });
  }
}

// ─── Event handlers ────────────────────────────────────────────────────────────

async function handlePaymentPaid(app: FastifyInstance, payment: AsaasPaymentPayload) {
  const tx = await prisma.transaction.findFirst({
    where: { asaasPaymentId: payment.id, deletedAt: null },
    select: {
      id: true,
      status: true,
      accountId: true,
      ownerId: true,
      referenceMonth: true,
      lease: { select: { commissionRate: true } },
    },
  });

  if (!tx) {
    // A charge created directly in the Asaas dashboard has no matching row.
    // Log it for manual review instead of failing.
    app.log.warn(
      { paymentId: payment.id, externalReference: payment.externalReference },
      "asaas-webhook: no transaction matched asaasPaymentId",
    );
    return;
  }

  // Idempotency: Asaas re-delivers events, and PAYMENT_CONFIRMED and
  // PAYMENT_RECEIVED can both arrive for the same payment. Only the first one counts.
  //
  // Known limitation: this is a read-then-write check, so two deliveries
  // processed at exactly the same moment could both pass it. The next step
  // would be a conditional update (updateMany where status != "PAGA") and
  // only touching the payout if that update changed a row.
  if (tx.status === "PAGA") {
    app.log.info({ txId: tx.id, paymentId: payment.id }, "asaas-webhook: already PAGA, skipping");
    return;
  }

  const paidAmountCents = Math.round((payment.value ?? 0) * 100); // reais -> centavos
  const paidAt = new Date(
    payment.paymentDate ??
    payment.clientPaymentDate ??
    payment.confirmedDate ??
    new Date().toISOString().slice(0, 10),
  );

  await prisma.transaction.update({
    where: { id: tx.id },
    data: {
      status: "PAGA",
      paidAt,
      paidAmountCents,
      paymentMethod: mapBillingType(payment.billingType) as any,
      asaasPaymentSyncedAt: new Date(),
      asaasPaymentSyncError: null,
    },
  });

  if (tx.ownerId && tx.referenceMonth) {
    await upsertOwnerDistribution(
      tx.accountId,
      tx.ownerId,
      tx.referenceMonth,
      paidAmountCents,
      tx.lease?.commissionRate,
    );
  }

  app.log.info(
    { txId: tx.id, paymentId: payment.id, paidAmountCents },
    "asaas-webhook: transaction marked PAGA, distribution upserted",
  );
}

async function handlePaymentOverdue(app: FastifyInstance, payment: AsaasPaymentPayload) {
  const tx = await prisma.transaction.findFirst({
    where: { asaasPaymentId: payment.id, deletedAt: null },
    select: { id: true, status: true },
  });

  if (!tx) {
    app.log.warn({ paymentId: payment.id }, "asaas-webhook: no transaction matched for PAYMENT_OVERDUE");
    return;
  }

  // Events can arrive out of order: never move a paid or cancelled charge back to overdue.
  if (tx.status === "PAGA" || tx.status === "CANCELADA") return;

  await prisma.transaction.update({
    where: { id: tx.id },
    data: { status: "VENCIDA" },
  });

  app.log.info({ txId: tx.id, paymentId: payment.id }, "asaas-webhook: transaction marked VENCIDA");
}

// ─── Route ─────────────────────────────────────────────────────────────────────

export async function webhooksRoutes(app: FastifyInstance) {
  // No /api prefix: this URL is registered in the Asaas dashboard.
  app.post("/webhooks/asaas", async (request, reply) => {
    // 1. Authenticate the caller. Asaas sends a shared secret, configured in
    //    the Asaas dashboard, in the asaas-access-token header. The expected
    //    value is read from the environment and never hardcoded.
    //    (Hardening idea: compare with crypto.timingSafeEqual.)
    const token = request.headers["asaas-access-token"];
    const expectedToken = process.env.ASAAS_WEBHOOK_TOKEN;

    if (!expectedToken || token !== expectedToken) {
      app.log.warn({ hasToken: !!token }, "asaas-webhook: rejected, invalid or missing token");
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const body = request.body as AsaasWebhookBody | undefined;
    const { event, payment } = body ?? {};

    app.log.info({ event, paymentId: payment?.id }, "asaas-webhook: received");

    // 2. Asaas retries anything that isn't a 200 and eventually pauses the
    //    webhook queue, so malformed or unknown events are acknowledged, not rejected.
    if (!event || !payment?.id) {
      return reply.code(200).send({ received: true });
    }

    // 3. Dispatch by event type.
    try {
      if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
        await handlePaymentPaid(app, payment);
      } else if (event === "PAYMENT_OVERDUE") {
        await handlePaymentOverdue(app, payment);
      } else {
        app.log.info({ event }, "asaas-webhook: unhandled event type, ignoring");
      }
    } catch (err: any) {
      // Still return 200: a re-delivery won't fix a bug in our code, and a
      // blocked queue would delay every other agency's payments. The error is
      // logged, and the charge can be reconciled by hand from the dashboard.
      app.log.error({ event, paymentId: payment?.id, err: err?.message }, "asaas-webhook: processing error");
    }

    return reply.code(200).send({ received: true });
  });
}
