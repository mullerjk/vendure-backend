import {
    ChannelService,
    EntityHydrator,
    ID,
    idsAreEqual,
    Injector,
    InternalServerError,
    isGraphQlErrorResult,
    Order,
    OrderLine,
    OrderSellerStrategy,
    OrderService,
    PaymentMethod,
    PaymentMethodService,
    PaymentService,
    RequestContext,
    SplitOrderContents,
    Surcharge,
    TransactionalConnection,
} from '@vendure/core';

import {
    CONNECTED_PAYMENT_METHOD_CODE,
    MULTIVENDOR_PLUGIN_OPTIONS
} from '../constants';
import { MultivendorPluginOptions } from '../types';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomSellerFields {
        connectedAccountId: string;
    }
}

export class MultivendorSellerStrategy implements OrderSellerStrategy {
    private entityHydrator: EntityHydrator;
    private channelService: ChannelService;
    private paymentService: PaymentService;
    private paymentMethodService: PaymentMethodService;
    private connection: TransactionalConnection;
    private orderService: OrderService;
    private options: MultivendorPluginOptions;

    init(injector: Injector) {
        this.entityHydrator = injector.get(EntityHydrator);
        this.channelService = injector.get(ChannelService);
        this.paymentService = injector.get(PaymentService);
        this.paymentMethodService = injector.get(PaymentMethodService);
        this.connection = injector.get(TransactionalConnection);
        this.orderService = injector.get(OrderService);
        this.options = injector.get(MULTIVENDOR_PLUGIN_OPTIONS);
    }

    /**
     * Called for each OrderLine as it is added to the Order to determine
     * the Channel (Seller) that "owns" that variant.
     */
    async setOrderLineSellerChannel(ctx: RequestContext, orderLine: OrderLine) {
        await this.entityHydrator.hydrate(ctx, orderLine.productVariant, { relations: ['channels'] });
        const defaultChannel = await this.channelService.getDefaultChannel();

        // If a ProductVariant is assigned to exactly 2 Channels, then one is the default Channel
        // and the other is the seller's Channel.
        if (orderLine.productVariant.channels.length === 2) {
            const sellerChannel = orderLine.productVariant.channels.find(
                c => !idsAreEqual(c.id, defaultChannel.id),
            );
            if (sellerChannel) {
                return sellerChannel;
            }
        }
    }

    /**
     * Splits the "aggregate" Order into sub-orders based on each Seller's Channel.
     */
    async splitOrder(ctx: RequestContext, order: Order): Promise<SplitOrderContents[]> {
        const partialOrders = new Map<ID, SplitOrderContents>();

        for (const line of order.lines) {
            const sellerChannelId = line.sellerChannelId;
            if (sellerChannelId) {
                let partialOrder = partialOrders.get(sellerChannelId);
                if (!partialOrder) {
                    partialOrder = {
                        channelId: sellerChannelId,
                        shippingLines: [],
                        lines: [],
                        state: 'ArrangingPayment',
                    };
                    partialOrders.set(sellerChannelId, partialOrder);
                }
                partialOrder.lines.push(line);
            }
        }

        // Assign shipping lines to each partial order
        for (const partialOrder of partialOrders.values()) {
            const shippingLineIds = new Set(partialOrder.lines.map(l => l.shippingLineId));
                        
            partialOrder.shippingLines = order.shippingLines.filter(shippingLine =>
                shippingLineIds.has(shippingLine.id),
            );
        }

        return [...partialOrders.values()];
    }

    /**
     * Called after each Seller sub-order is created.
     * Here we can add surcharges (e.g. fees) and attach a PaymentMethod,
     * so each sub-order can process its own Payment if necessary.
     */
    async afterSellerOrdersCreated(ctx: RequestContext, aggregateOrder: Order, sellerOrders: Order[]) {
        // Locate the PaymentMethod for connected accounts
        const paymentMethod = await this.connection.rawConnection.getRepository(PaymentMethod).findOne({
            where: {
                code: CONNECTED_PAYMENT_METHOD_CODE,
            },
        });
        if (!paymentMethod) {
            return;
        }

        const defaultChannel = await this.channelService.getDefaultChannel();

        for (const sellerOrder of sellerOrders) {
            const sellerChannel = sellerOrder.channels.find(c => !idsAreEqual(c.id, defaultChannel.id));
            if (!sellerChannel) {
                throw new InternalServerError(
                    `Could not determine Seller Channel for Order ${sellerOrder.code}`,
                );
            }

            // 1) CREATE SURCHARGES FOR FEES
            //    We'll create negative surcharges so that the final `sellerOrder.totalWithTax`
            //    becomes the "net" amount the seller sees for this sub-order.

            const [platformFeeSurcharge, stripeFeeSurcharge] =
                await this.createPlatformAndStripeFeeSurcharges(ctx, sellerOrder);

            sellerOrder.surcharges = [
                platformFeeSurcharge,
                stripeFeeSurcharge,
            ];

            // 2) Re-apply price adjustments so these surcharges affect the total
            await this.orderService.applyPriceAdjustments(ctx, sellerOrder);

            // 3) Hydrate to get the Seller and connected account info
            await this.entityHydrator.hydrate(ctx, sellerChannel, { relations: ['seller'] });

            // 4) Add a Payment to the sub-order (pointing to the same "connected" PaymentMethod).
            //    The `metadata` can include the transfer_group or any data we want to track.
            const result = await this.orderService.addPaymentToOrder(ctx, sellerOrder.id, {
                method: paymentMethod.code,
                metadata: {
                    transfer_group: aggregateOrder.code,
                    connectedAccountId: sellerChannel.seller?.customFields.connectedAccountId,
                },
            });

            if (isGraphQlErrorResult(result)) {
                throw new InternalServerError(result.message);
            }
        }
    }

    /**
     * Creates negative surcharges for both:
     *   1) Platform Fee (using this.options.platformFeePercent)
     *   2) Stripe Fee (example: 3.99% + R$0.39)
     *
     * This approach uses negative surcharges to reduce the final Seller total.
     * Adjust as needed if your logic differs (e.g. if the Seller is not actually paying Stripe fees).
     */
    private async createPlatformAndStripeFeeSurcharges(ctx: RequestContext, sellerOrder: Order) {
        // (A) Calculate the total with tax (in cents).
        const totalCents = sellerOrder.totalWithTax;

        // (B) Calculate PLATFORM FEE
        const platformFeePercent = this.options.platformFeePercent; // e.g. 2.99
        const platformFee = Math.round(totalCents * (platformFeePercent / 100));

        // (C) Calculate STRIPE FEE (e.g. 3.99% + R$0.39)
        //     *In a real scenario, you might fetch these from your config or environment*
        const stripeFeePercent = 3.99;
        const stripeFixedFee = 39; // R$0,39 in cents
        const stripeFee = Math.round(totalCents * (stripeFeePercent / 100)) + stripeFixedFee;

        // (D) Create negative surcharges
        const platformFeeSurcharge = await this.connection.getRepository(ctx, Surcharge).save(
            new Surcharge({
                taxLines: [],
                sku: this.options.platformFeeSKU, // e.g. 'FEE'
                description: `Taxa Mercantia (${platformFeePercent}%)`,
                listPrice: -platformFee, // Negative to reduce seller's total
                listPriceIncludesTax: true,
                order: sellerOrder,
            }),
        );

        const stripeFeeSurcharge = await this.connection.getRepository(ctx, Surcharge).save(
            new Surcharge({
                taxLines: [],
                sku: 'SF', 
                description: `Taxa Stripe (3.99% + R$0.39)`,
                listPrice: -stripeFee, // Negative
                listPriceIncludesTax: true,
                order: sellerOrder,
            }),
        );

        return [platformFeeSurcharge, stripeFeeSurcharge];
    }
}
