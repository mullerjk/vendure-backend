// stripe.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigArg, CurrencyCode } from '@vendure/common/lib/generated-types';
import {
    Customer,
    Injector,
    Logger,
    Order,
    Payment,
    PaymentMethodService,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import Stripe from 'stripe';

import { sanitizeMetadata } from './metadata-sanitize';
import { VendureStripeClient } from './stripe-client';
import { getAmountInStripeMinorUnits } from './stripe-utils';
import { stripePaymentMethodHandler } from './stripe.handler'; // In case you're referencing a separate "stripePaymentMethodHandler"
import { MultivendorPluginOptions } from '../../types';
import { loggerCtx, MULTIVENDOR_PLUGIN_OPTIONS } from '../../constants';

/**
 * StripeService encapsulates all direct Stripe API calls:
 *   - Creating PaymentIntents (including optional saving of Customer in Stripe)
 *   - Creating Transfers for sellers
 *   - Creating Refunds
 */
@Injectable()
export class StripeService {
    constructor(
        @Inject(MULTIVENDOR_PLUGIN_OPTIONS) private options: MultivendorPluginOptions,
        private connection: TransactionalConnection,
        private paymentMethodService: PaymentMethodService,
        private moduleRef: ModuleRef,
    ) {}

    /**
     * Create a Stripe PaymentIntent and return { id, clientSecret }.
     * 
     * By default, we enable "automatic_payment_methods" for simpler setup.
     * If you need to specify payment method types, see your `paymentIntentCreateParams`.
     */
    async createPaymentIntentWithId(
        ctx: RequestContext,
        order: Order,
    ): Promise<{ id: string; clientSecret: string }> {
        const stripe = await this.getStripeClient(ctx, order);

        let customerId: string | undefined;
        if (this.options.storeCustomersInStripe && ctx.activeUserId) {
            customerId = await this.getStripeCustomerId(ctx, order);
        }
        const amountInMinorUnits = getAmountInStripeMinorUnits(order.totalWithTax, order.currencyCode, order);

        const additionalParams = await this.options.paymentIntentCreateParams?.(
            new Injector(this.moduleRef),
            ctx,
            order,
        );
        const metadata = sanitizeMetadata({
            ...(typeof this.options.metadata === 'function'
                ? await this.options.metadata(new Injector(this.moduleRef), ctx, order)
                : {}),
            channelToken: ctx.channel.token,
            orderId: order.id,
            orderCode: order.code,
        });
        const allMetadata = {
            ...metadata,
            ...sanitizeMetadata(additionalParams?.metadata ?? {}),
        };

        const paymentIntent = await stripe.paymentIntents.create(
            {
                amount: amountInMinorUnits,
                currency: order.currencyCode.toLowerCase(),
                customer: customerId,
                automatic_payment_methods: {
                    enabled: true,
                },
                ...(additionalParams ?? {}),
                metadata: allMetadata,
            },
            { idempotencyKey: `${order.code}_${amountInMinorUnits}` },
        );

        if (!paymentIntent.client_secret) {
            Logger.warn(
                `PaymentIntent creation for order ${order.code} did not return a client secret`,
                loggerCtx,
            );
            throw new Error('Failed to create payment intent');
        }

        return {
            id: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
        };
    }

    /**
     * Create a transfer to a connected Stripe account (for Seller Orders).
     */
    async createTransfer(
        ctx: RequestContext,
        order: Order,
        params: {
            connectedAccountId: string;
            amount: number;
            currency: string;
            transferGroup?: string;
        },
    ): Promise<Stripe.Response<Stripe.Transfer>> {
        const stripe = await this.getStripeClient(ctx, order);
        const amountInMinorUnits = getAmountInStripeMinorUnits(params.amount, order.currencyCode as CurrencyCode, order);

        return stripe.transfers.create({
            amount: amountInMinorUnits,
            currency: params.currency.toLowerCase(),
            destination: params.connectedAccountId,
            transfer_group: params.transferGroup,
        });
    }

    /**
     * Create a refund for the given Payment / PaymentIntent and amount in minor units.
     */
    async createRefund(
        ctx: RequestContext,
        order: Order,
        payment: Payment,
        amount: number,
    ): Promise<Stripe.Response<Stripe.Refund>> {
        const stripe = await this.getStripeClient(ctx, order);
        return stripe.refunds.create({
            payment_intent: payment.transactionId,
            amount,
        });
    }

    /**
     * Construct an event from a webhook payload using the configured webhookSecret.
     */
    async constructEventFromPayload(
        ctx: RequestContext,
        order: Order,
        payload: Buffer,
        signature: string,
    ): Promise<Stripe.Event> {
        const stripe = await this.getStripeClient(ctx, order);
        return stripe.webhooks.constructEvent(payload, signature, stripe.webhookSecret);
    }

    /**
     * Fetch or create the Stripe Customer ID for the given Order’s Customer.
     */
    private async getStripeCustomerId(ctx: RequestContext, activeOrder: Order): Promise<string | undefined> {
        const [stripe, order] = await Promise.all([
            this.getStripeClient(ctx, activeOrder),
            // Load relation with customer
            this.connection.getRepository(ctx, Order).findOne({
                where: { id: activeOrder.id },
                relations: ['customer'],
            }),
        ]);

        if (!order || !order.customer) {
            // Should not happen if a Customer is attached to this Order
            return undefined;
        }

        const { customer } = order;

        if (customer.customFields.stripeCustomerId) {
            return customer.customFields.stripeCustomerId;
        }

        let stripeCustomerId: string | undefined;
        // See if an existing Stripe Customer matches the email
        const stripeCustomers = await stripe.customers.list({ email: customer.emailAddress });
        if (stripeCustomers.data.length > 0) {
            // We’ll just grab the first matching email
            stripeCustomerId = stripeCustomers.data[0].id;
        } else {
            // Otherwise, create a new one
            const additionalParams = await this.options.customerCreateParams?.(
                new Injector(this.moduleRef),
                ctx,
                order,
            );
            const newStripeCustomer = await stripe.customers.create({
                email: customer.emailAddress,
                name: `${customer.firstName} ${customer.lastName}`,
                ...(additionalParams ?? {}),
                ...(additionalParams?.metadata
                    ? { metadata: sanitizeMetadata(additionalParams.metadata) }
                    : {}),
            });
            stripeCustomerId = newStripeCustomer.id;

            Logger.info(`Created Stripe Customer for customerId ${customer.id}`, loggerCtx);
        }

        customer.customFields.stripeCustomerId = stripeCustomerId;
        await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });

        return stripeCustomerId;
    }

    /**
     * Return a configured VendureStripeClient for the given Order’s payment method.
     */
    private async getStripeClient(ctx: RequestContext, order: Order): Promise<VendureStripeClient> {
        // We find an *enabled* PaymentMethod that uses your "stripe" code
        // so we can retrieve its API key + webhook secret from the DB.
        const [eligiblePaymentMethods, paymentMethods] = await Promise.all([
            this.paymentMethodService.getEligiblePaymentMethods(ctx, order),
            this.paymentMethodService.findAll(ctx, { filter: { enabled: { eq: true } } }),
        ]);

        const stripePaymentMethod = paymentMethods.items.find(
            pm => pm.handler.code === stripePaymentMethodHandler.code,
        );
        if (!stripePaymentMethod) {
            throw new UserInputError(`No enabled Stripe payment method found`);
        }

        const isEligible = eligiblePaymentMethods.some(pm => pm.code === stripePaymentMethod.code);
        if (!isEligible) {
            throw new UserInputError(`Stripe payment method is not eligible for order ${order.code}`);
        }

        // Retrieve the API key and Webhook Secret from PaymentMethod handler args
        const apiKey = this.findOrThrowArgValue(stripePaymentMethod.handler.args, 'apiKey');
        const webhookSecret = this.findOrThrowArgValue(stripePaymentMethod.handler.args, 'webhookSecret');

        return new VendureStripeClient(apiKey, webhookSecret);
    }

    private findOrThrowArgValue(args: ConfigArg[], name: string): string {
        const value = args.find(arg => arg.name === name)?.value;
        if (!value) {
            throw Error(`No argument named '${name}' found in Stripe PaymentMethod`);
        }
        return value;
    }
}
