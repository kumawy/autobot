import type { Tx } from '../../db/prisma.js';
import type { OutboundMessage } from '../../types/domain.js';
/** Bind late-created transactional buttons using the same rules as wizard messages. */
export async function bindOutboundActions(tx: Tx, output: OutboundMessage, customerId: string) {
  const result = structuredClone(output);
  const entries =
    result.type === 'buttons' ? result.buttons : result.type === 'list' ? result.rows : [];
  if (!entries.length) return result;
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
  const order = customer.currentOrderId
    ? await tx.order.findUnique({ where: { id: customer.currentOrderId } })
    : null;
  for (const entry of entries) {
    if (await tx.actionToken.findUnique({ where: { token: entry.id } })) continue;
    const action = await tx.actionToken.create({
      data: {
        customerId,
        orderId: order?.id,
        contentVersion: order?.contentVersion,
        conversationVersion: customer.conversationVersion,
        actionId: entry.id,
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    entry.id = action.token;
  }
  return result;
}
