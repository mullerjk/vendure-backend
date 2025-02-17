// multivendorPaymentMethodHandler.ts
import { OrderType } from '@vendure/common/lib/generated-types';
import {
    CreatePaymentResult,
    LanguageCode,
    PaymentMethodHandler,
    SettlePaymentResult,
} from '@vendure/core';

import { StripeService } from './stripe.service';

/**
 * A custom PaymentMethodHandler that delegates all Stripe calls to `StripeService`.
 */
export const multivendorPaymentMethodHandler = new PaymentMethodHandler({
    code: 'stripe',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Multivendor Stripe Payment Provider',
        },
    ],
    args: {
        // You can define your ConfigArgs here if needed:
        // apiKey: { type: 'string', label: [{ languageCode: LanguageCode.en, value: 'API Key' }] },
        // webhookSecret: { type: 'string', label: [{ languageCode: LanguageCode.en, value: 'Webhook Secret' }] },
    },
    /**
     * createPayment:
     *  This method is called when the user attempts to complete an Order.
     */
    createPayment: async (ctx, order, amount, args, metadata): Promise<CreatePaymentResult> => {
        // Vendure 2.x => `ctx.injector` is available
        const stripeService = ctx.injector.get(StripeService);

        if (order.type === OrderType.Seller) {
            // ========== SELLER ORDER ========== //
            try {
                // We expect the seller’s connected Stripe Account ID in metadata
                const { connectedAccountId, transfer_group } = metadata || {};
                if (!connectedAccountId) {
                    throw new Error('No "connectedAccountId" found in payment metadata');
                }

                // Create a Transfer to the Seller’s connected Stripe Account
                const transfer = await stripeService.createTransfer(ctx, order, {
                    connectedAccountId,
                    amount,
                    currency: order.currencyCode,
                    transferGroup: transfer_group, // optional
                });

                // Return "Settled" to indicate immediate capture
                return {
                    amount,
                    state: 'Settled' as const,
                    transactionId: transfer.id,
                    metadata: {
                        ...metadata,
                        transfer_group,
                    },
                };
            } catch (err: any) {
                return {
                    amount,
                    state: 'Declined' as const,
                    metadata: {
                        errorMessage: err.message,
                    },
                };
            }
        } else {
            // ========== PLATFORM ORDER ========== //
            try {
                // Create PaymentIntent for the platform
                const pi = await stripeService.createPaymentIntentWithId(ctx, order);

                // If you want a 2-step (Authorize + Capture) flow,
                // you could return state: 'Authorized' here,
                // and finalize in settlePayment().
                //
                // For demonstration, we'll do an immediate capture => 'Settled'
                return {
                    amount,
                    state: 'Settled' as const,
                    transactionId: pi.id, // store PaymentIntent ID
                    metadata: {
                        ...metadata,
                        clientSecret: pi.clientSecret,
                        transfer_group: order.code,
                    },
                };
            } catch (err: any) {
                return {
                    amount,
                    state: 'Declined' as const,
                    metadata: {
                        errorMessage: err.message,
                    },
                };
            }
        }
    },

    /**
     * settlePayment:
     *  This is called if the Order process transitions from "PaymentAuthorized" state
     *  to "PaymentSettled" state. If you returned 'Authorized' above, you'd do the capture here.
     */
    settlePayment: async (ctx, order, payment, args): Promise<SettlePaymentResult> => {
        const stripeService = ctx.injector.get(StripeService);

        // Example if you had an "authorized" PaymentIntent:
        // await stripeService.capturePaymentIntent(payment.transactionId);

        // Right now, we assume we've already captured
        // in `createPayment` => just return success
        return { success: true };
    },
});
