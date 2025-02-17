import {
    DefaultJobQueuePlugin,
    DefaultSearchPlugin,
    VendureConfig,
    LanguageCode,
    Asset,
    OrderService,
    TransactionalConnection,
    ChannelService,
    idsAreEqual,
    Seller,
    EntityHydrator,
} from '@vendure/core';
import { defaultEmailHandlers, EmailPlugin, EmailPluginDevModeOptions, EmailPluginOptions } from '@vendure/email-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import 'dotenv/config';
import path from 'path';
import { MultivendorPlugin } from './plugins/multivendor-plugin/multivendor.plugin';
import { compileUiExtensions, setBranding } from '@vendure/ui-devkit/compiler';
import { StripePlugin } from './plugins/multivendor-plugin/payment/stripe/stripe.plugin';
import { MULTIVENDOR_PLUGIN_OPTIONS } from './plugins/multivendor-plugin/constants';
import { MultivendorPluginOptions } from './plugins/multivendor-plugin/types';

const isDev: Boolean = process.env.APP_ENV === 'dev';

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

class SendgridEmailSender {
    async send(email: any) {
        await sgMail.send({
            to: email.recipient,
            from: email.from,
            subject: email.subject,
            html: email.body
        });
    }
}

const emailPluginOptions = isDev || !process.env.SENDGRID_API_KEY ? {
    devMode: true,
    outputPath: path.join(__dirname, '../static/email/test-emails'),
    route: 'mailbox'
} : {
    emailSender: new SendgridEmailSender(),
    transport: {
        type: 'sendgrid',
        apiKey: process.env.SENDGRID_API_KEY
    }
};

export const config: VendureConfig = {
    apiOptions: {
        // hostname: process.env.PUBLIC_DOMAIN,
        port: +(process.env.PORT || 3000),
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        // The following options are useful in development mode,
        // but are best turned off for production for security
        // reasons.
        ...(isDev ? {
            adminApiPlayground: {
                settings: { 'request.credentials': 'include' },
            },
            adminApiDebug: true,
            shopApiPlayground: {
                settings: { 'request.credentials': 'include' },
            },
            shopApiDebug: true,
        } : {}),
    },
    authOptions: {
        tokenMethod: ['bearer', 'cookie'],
        superadminCredentials: {
            identifier: process.env.SUPERADMIN_USERNAME,
            password: process.env.SUPERADMIN_PASSWORD,
        },
        cookieOptions: {
            secret: process.env.COOKIE_SECRET,
        },
    },
    dbConnectionOptions: {
        type: 'postgres',
        migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
        logging: false,
        database: process.env.DB_NAME,
        schema: process.env.DB_SCHEMA,
        host: process.env.DB_HOST,
        port: +process.env.DB_PORT,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    },
    paymentOptions: {
        paymentMethodHandlers: [],
    },
    // When adding or altering custom field definitions, the database will
    // need to be updated. See the "Migrations" section in README.md.
    plugins: [
        MultivendorPlugin.init({
            /**
             * Definindo a taxa de plataforma para 2,99%
             */
            platformFeePercent: 2.99,
            platformFeeSKU: 'MF',

            /**
             * Armazena cliente no Stripe
             */
            storeCustomersInStripe: true,
      
            /**
             * Lógica de criação do PaymentIntent
             */
            paymentIntentCreateParams: async (injector, ctx, order) => {
              // Injeções e conexões
              const platformPluginOptions = injector.get(MULTIVENDOR_PLUGIN_OPTIONS) as MultivendorPluginOptions;
              const connection = injector.get(TransactionalConnection);
              const entityHydrator = injector.get(EntityHydrator);
              const orderService = injector.get(OrderService);
              const channelService = injector.get(ChannelService);
      
              /**
               * 1) Verifica se a taxa de plataforma está configurada
               */
              if (
                !platformPluginOptions ||
                typeof platformPluginOptions.platformFeePercent !== 'number'
              ) {
                throw new Error('Platform fee percentage is not configured in Multivendor Plugin.');
              }
      
              /**
               * 2) Busca a ordem completa (com linhas e variantes)
               */
              const orderWithLines = await orderService.findOne(ctx, order.id);
              if (!orderWithLines) {
                throw new Error(`Order ${order.code} not found.`);
              }
      
              await entityHydrator.hydrate(ctx, orderWithLines, {
                relations: ['lines.productVariant.channels'],
              });
      
              /**
               * 3) Identifica a conta conectada (Connected Account) do Seller
               */
              const defaultChannel = await channelService.getDefaultChannel();
              let connectedAccountId: string | undefined = undefined;
      
              for (const line of orderWithLines.lines) {
                for (const channel of line.productVariant.channels) {
                  if (!idsAreEqual(channel.id, defaultChannel.id)) {
                    // Exemplo: cada Channel do Seller possui um sellerId (ajuste conforme seu schema)
                    const seller = await connection.getRepository(ctx, Seller).findOne({
                      where: { id: channel.sellerId },
                    });
      
                    if (seller?.customFields?.connectedAccountId) {
                      connectedAccountId = seller.customFields.connectedAccountId;
                      break;
                    }
                  }
                }
                if (connectedAccountId) break;
              }
      
              if (!connectedAccountId) {
                throw new Error(`Connected Account ID not found for order ${order.code}`);
              }
      
              /**
               * 4) Calcula taxas
               */
              // Valor total do pedido (supondo que seja em centavos)
              const totalWithTax = order.totalWithTax;
      
              // Taxa de plataforma
              const platformFeePercent = platformPluginOptions.platformFeePercent;
              const platformFeeAmount = Math.round((totalWithTax * platformFeePercent) / 100);
      
              // Taxa do Stripe (exemplo 3,99% + R$ 0,39)
              const stripeFeePercent = 3.99;
              const stripeFixedFee = 39; // 39 centavos
              const stripeFeeAmount = Math.round((totalWithTax * stripeFeePercent) / 100) + stripeFixedFee;
      
              // Soma das duas taxas
              const totalFee = platformFeeAmount + stripeFeeAmount;
      
              console.log('---------- TAXAS ----------');
              console.log('Valor total (centavos):', totalWithTax);
              console.log('Plataforma (2.99%):', platformFeeAmount);
              console.log('Stripe (3.99% + 0.39):', stripeFeeAmount);
              console.log('Soma total de taxas:', totalFee);
              console.log('Seller Connected Account:', connectedAccountId);
              console.log('---------------------------');
      
              /**
               * 5) Retorna a configuração do PaymentIntent
               *    - O Stripe irá reter `application_fee_amount` (as duas taxas somadas)
               *    - O restante é transferido para a conta conectada (`destination`).
               */
              return {
                // valor total a cobrar do cliente
                // (confirme se totalWithTax está em centavos e condiz com a currency)
                amount: totalWithTax,
                currency: 'brl',
      
                // Para cobrar "em nome" da conta conectada (no caso de direct charges),
                // é necessário 'on_behalf_of' e 'transfer_data.destination'.
                // Avalie se seu fluxo Connect é direct charge ou destination charge.
                on_behalf_of: connectedAccountId,
      
                transfer_data: {
                  destination: connectedAccountId,
                },
      
                // Soma de todas as taxas que deseja reter
                application_fee_amount: totalFee,
      
                // (Opcional) Metadados para registrar a divisão das taxas
                metadata: {
                  platformFee: platformFeeAmount.toString(),
                  stripeFee: stripeFeeAmount.toString(),
                  orderCode: order.code,
                },
      
                // Descrição que aparecerá na fatura e no dashboard do Stripe
                description: `Order #${order.code} for ${order.customer?.emailAddress}`,
              };
            },
          }),
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: process.env.ASSET_VOLUME_PATH || path.join(__dirname, '../static/assets'),
            // For local dev, the correct value for assetUrlPrefix should
            // be guessed correctly, but for production it will usually need
            // to be set manually to match your production url.
            assetUrlPrefix: isDev ? undefined : `https://${process.env.PUBLIC_DOMAIN}/assets/`,
        }),
        DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
        EmailPlugin.init({
            ...emailPluginOptions,
            handlers: defaultEmailHandlers,
            templatePath: path.join(__dirname, '../static/email/templates'),
            globalTemplateVars: {
                fromAddress: process.env.EMAIL_FROM_ADDRESS || 'Mercantia <noreply@mercantia.app>',
                verifyEmailAddressUrl: `${process.env.STOREFRONT_URL}/verify`,
                passwordResetUrl: `${process.env.STOREFRONT_URL}/password-reset`,
                changeEmailAddressUrl: `${process.env.STOREFRONT_URL}/verify-email-address-change`
            },
        } as EmailPluginOptions | EmailPluginDevModeOptions),
        AdminUiPlugin.init({
            route: 'admin',
            port: 3002,
            adminUiConfig: {
                brand: 'Mercantia',
                hideVendureBranding: true,
                hideVersion: false,
                apiHost: isDev ? `http://${process.env.PUBLIC_DOMAIN}` : `https://${process.env.PUBLIC_DOMAIN}`,
                // apiPort: +(process.env.PORT || 3000),
            },
            app: compileUiExtensions({
                outputPath: path.join(__dirname, '/admin-ui'),
                extensions: [
                    setBranding({
                        // The small logo appears in the top left of the screen  
                        smallLogoPath: path.join(__dirname, '../static/assets/logoMercantia.png'),
                        // The large logo is used on the login page  
                        largeLogoPath: path.join(__dirname, '../static/assets/logoMercantia.png'),
                        faviconPath: path.join(__dirname, '../static/assets/logoMercantia.png'),
                    }),
                ],
            }),
        }),
    ],
    customFields: {
        Product: [
            { name: 'longDescription', type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Descrição' },
                    { languageCode: LanguageCode.en, value: 'Description' },
                  ],
                  nullable: true,
                  internal: false,
                  ui: { component: 'rich-text-form-input' },
             },
            { name: 'nutritionalInformation', type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Informação Nutricional' },
                    { languageCode: LanguageCode.en, value: 'Nutritional Information' },
                  ],
                  nullable: true,
                  internal: false,
                  ui: { component: 'rich-text-form-input' },
             },
            { name: 'downloadable', type: 'boolean',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Download' },
                    { languageCode: LanguageCode.en, value: 'Download' },
                  ],
                  nullable: true,
                  internal: false,
             },
            { name: 'frozen', type: 'boolean',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Congelado' },
                    { languageCode: LanguageCode.en, value: 'Frozen' },
                  ],
                  nullable: true,
                  internal: false,
             },
            { name: 'shortName', type: 'localeString',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Abreviação' },
                    { languageCode: LanguageCode.en, value: 'Short Name' },
                  ],
                  nullable: true,
                  internal: false,
             }
        ],
        ProductVariant: [
              {
                name: 'weight',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Peso' },
                  { languageCode: LanguageCode.en, value: 'Weight' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'height',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Altura' },
                  { languageCode: LanguageCode.en, value: 'Height' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'depth',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Profundidade' },
                  { languageCode: LanguageCode.en, value: 'Depth' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'Width',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Largura' },
                  { languageCode: LanguageCode.en, value: 'Width' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'color',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Cor' },
                  { languageCode: LanguageCode.en, value: 'Color' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'material',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Material' },
                  { languageCode: LanguageCode.en, value: 'Material' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'package',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Pacote' },
                  { languageCode: LanguageCode.en, value: 'Package' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'size',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Tamanho' },
                  { languageCode: LanguageCode.en, value: 'Size' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'condition',
                type: 'string',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Condição' },
                  { languageCode: LanguageCode.en, value: 'Condition' },
                ],
                options: [
                  { value: 'new', label: [{ languageCode: LanguageCode.pt_BR, value: 'Novo' }, { languageCode: LanguageCode.en, value: 'New' }] },
                  { value: 'used', label: [{ languageCode: LanguageCode.pt_BR, value: 'Usado' }, { languageCode: LanguageCode.en, value: 'Used' }] },
                  { value: 'refurbished', label: [{ languageCode: LanguageCode.pt_BR, value: 'Reformado' }, { languageCode: LanguageCode.en, value: 'Refurbished' }] },
                  { value: 'fabricated', label: [{ languageCode: LanguageCode.pt_BR, value: 'Fabricação Própria' }, { languageCode: LanguageCode.en, value: 'Fabricated' }] },
                  { value: 'imported', label: [{ languageCode: LanguageCode.pt_BR, value: 'Importado' }, { languageCode: LanguageCode.en, value: 'Imported' }] },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'warrantyPeriod',
                type: 'int',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Período de Garantia (meses)' },
                  { languageCode: LanguageCode.en, value: 'Warranty Period (months)' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'expirationDate',
                type: 'datetime',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Data de Validade' },
                  { languageCode: LanguageCode.en, value: 'Expiration Date' },
                ],
                nullable: true,
                internal: false,
              },
              {
                name: 'ingredients',
                type: 'text',
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Ingredientes' },
                  { languageCode: LanguageCode.en, value: 'Ingredients' },
                ],
                nullable: true,
                internal: false,
              },
        ],
        Seller: [
            {
                name: 'logo',
                type: 'relation',
                // O tipo 'relation' indica que o campo se relaciona com outra entidade
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Logo' },
                  { languageCode: LanguageCode.en, value: 'Logo' },
                ],
                nullable: true,
                internal: false,
                // Define a entidade relacionada como 'Asset'
                entity: Asset,
                // Define que a relação é de um para um
                ui: { component: 'single-asset-form-input' },
              },            
            {
                name: 'cnpj',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'CNPJ' },
                    { languageCode: LanguageCode.pt, value: 'CNPJ' },
                    { languageCode: LanguageCode.en, value: 'CNPJ' },
                ],
                nullable: false,
                internal: false,
                defaultValue: '00.000.000/0000-00',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'corporateName',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Razão Social' },
                    { languageCode: LanguageCode.pt, value: 'Razão Social' },
                    { languageCode: LanguageCode.en, value: 'Corporate Name' },
                ],
                nullable: false,
                internal: false,
                defaultValue: 'Empresa Fictícia LTDA',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'tradeName',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Nome Fantasia' },
                    { languageCode: LanguageCode.pt, value: 'Nome Fantasia' },
                    { languageCode: LanguageCode.en, value: 'Trade Name' },
                ],
                nullable: true,
                internal: false,
                defaultValue: 'Nome Fantasia Fictício',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'stateRegistration',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Inscrição Estadual' },
                    { languageCode: LanguageCode.pt, value: 'Inscrição Estadual' },
                    { languageCode: LanguageCode.en, value: 'State Registration' },
                ],
                nullable: true,
                internal: false,
                defaultValue: 'ISENTO',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'municipalRegistration',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Inscrição Municipal' },
                    { languageCode: LanguageCode.pt, value: 'Inscrição Municipal' },
                    { languageCode: LanguageCode.en, value: 'Municipal Registration' },
                ],
                nullable: true,
                internal: false,
                defaultValue: '123456789',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'cnae',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'CNAE' },
                    { languageCode: LanguageCode.pt, value: 'CNAE' },
                    { languageCode: LanguageCode.en, value: 'CNAE' },
                ],
                nullable: false,
                internal: false,
                defaultValue: '0000-0/00',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'fiscalAddress',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Endereço Fiscal' },
                    { languageCode: LanguageCode.pt, value: 'Endereço Fiscal' },
                    { languageCode: LanguageCode.en, value: 'Fiscal Address' },
                ],
                nullable: false,
                internal: false,
                defaultValue: 'Rua Fictícia, 123, Bairro Exemplo',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'city',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Cidade' },
                    { languageCode: LanguageCode.pt, value: 'Cidade' },
                    { languageCode: LanguageCode.en, value: 'City' },
                ],
                nullable: false,
                internal: false,
                defaultValue: 'São Paulo',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'state',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Estado' },
                    { languageCode: LanguageCode.pt, value: 'Estado' },
                    { languageCode: LanguageCode.en, value: 'State' },
                ],
                nullable: false,
                internal: false,
                defaultValue: 'SP',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'postalCode',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'CEP' },
                    { languageCode: LanguageCode.pt, value: 'CEP' },
                    { languageCode: LanguageCode.en, value: 'Postal Code' },
                ],
                nullable: false,
                internal: false,
                defaultValue: '00000-000',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'legalRepresentativeName',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Nome do Representante Legal' },
                    { languageCode: LanguageCode.pt, value: 'Nome do Representante Legal' },
                    { languageCode: LanguageCode.en, value: 'Legal Representative Name' },
                ],
                nullable: false,
                internal: false,
                defaultValue: 'João da Silva',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'legalRepresentativeCPF',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'CPF do Representante Legal' },
                    { languageCode: LanguageCode.pt, value: 'CPF do Representante Legal' },
                    { languageCode: LanguageCode.en, value: 'Legal Representative CPF' },
                ],
                nullable: false,
                internal: false,
                defaultValue: '000.000.000-00',
                ui: { component: 'text-form-input'},
            },
            {
                name: 'legalRepresentativeEmail',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Email do Representante Legal' },
                    { languageCode: LanguageCode.pt, value: 'Email do Representante Legal' },
                    { languageCode: LanguageCode.en, value: 'Legal Representative Email' },
                ],
                nullable: false,
                internal: false,
                defaultValue: 'email.ficticio@exemplo.com',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'legalRepresentativePhone',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Telefone do Representante Legal' },
                    { languageCode: LanguageCode.pt, value: 'Telefone do Representante Legal' },
                    { languageCode: LanguageCode.en, value: 'Legal Representative Phone' },
                ],
                nullable: false,
                internal: false,
                defaultValue: '(11) 90000-0000',
                ui: { component: 'text-form-input', prefix: '+55 ' },
            },
            {
                name: 'whatsappPhone',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Telefone do Representante Legal' },
                    { languageCode: LanguageCode.pt, value: 'Telefone do Representante Legal' },
                    { languageCode: LanguageCode.en, value: 'Legal Representative Phone' },
                ],
                nullable: false,
                internal: false,
                defaultValue: '(11) 90000-0000',
                ui: { component: 'text-form-input', prefix: '+55 ' },
            },
            {
                name: 'registeredTrademark',
                type: 'boolean',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Marca Registrada' },
                    { languageCode: LanguageCode.pt, value: 'Marca Registrada' },
                    { languageCode: LanguageCode.en, value: 'Registered Trademark' },
                ],
                nullable: true,
                internal: false,
                defaultValue: false,
                ui: { component: 'boolean-form-input' },
            },

            {
                name: 'allowContentReproduction',
                type: 'boolean',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Permitir Reprodução de Conteúdo' },
                    { languageCode: LanguageCode.pt, value: 'Permitir Reprodução de Conteúdo' },
                    { languageCode: LanguageCode.en, value: 'Allow Content Reproduction' },
                ],
                nullable: true,
                internal: false,
                defaultValue: false,
                ui: { component: 'boolean-form-input' },
            },
            {
                name: 'pricingAndStockDisclaimer',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Aviso sobre Preços e Estoques' },
                    { languageCode: LanguageCode.pt, value: 'Aviso sobre Preços e Estoques' },
                    { languageCode: LanguageCode.en, value: 'Pricing and Stock Disclaimer' },
                ],
                nullable: true,
                internal: false,
                defaultValue: 'Preços e Estoques sujeitos à alteração sem aviso prévio.',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'validForVirtualStoreOnly',
                type: 'string',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Válido Apenas para Loja Virtual' },
                    { languageCode: LanguageCode.pt, value: 'Válido Apenas para Loja Virtual' },
                    { languageCode: LanguageCode.en, value: 'Valid for Virtual Store Only' },
                ],
                nullable: true,
                internal: false,
                defaultValue: 'Ofertas válidas somente para a loja virtual.',
                ui: { component: 'text-form-input' },
            },
            {
                name: 'culture',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Cultura' },
                    { languageCode: LanguageCode.pt, value: 'Cultura' },
                    { languageCode: LanguageCode.en, value: 'Culture' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'sustainability',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Sustentabilidade' },
                    { languageCode: LanguageCode.pt, value: 'Sustentabilidade' },
                    { languageCode: LanguageCode.en, value: 'Sustainability' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'aboutUs',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Sobre Nós' },
                    { languageCode: LanguageCode.pt, value: 'Sobre Nós' },
                    { languageCode: LanguageCode.en, value: 'About Us' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'banner1',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Banner 1' },
                    { languageCode: LanguageCode.pt, value: 'Banner 1' },
                    { languageCode: LanguageCode.en, value: 'Banner 1' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'banner1img',
                type: 'relation',
                entity: Asset,
                // O tipo 'relation' indica que o campo se relaciona com outra entidade
                label: [
                  { languageCode: LanguageCode.pt_BR, value: 'Banner1 IMG' },
                  { languageCode: LanguageCode.en, value: 'Banner1 IMG' },
                ],
                nullable: true,
                internal: false,
                // Define a entidade relacionada como 'Asset'
                // Define que a relação é de um para um
                ui: { component: 'single-asset-form-input' },
              },
            {
                name: 'location',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Localização' },
                    { languageCode: LanguageCode.pt, value: 'Localização' },
                    { languageCode: LanguageCode.en, value: 'Location' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'privacyPolicy',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Política de Privacidade' },
                    { languageCode: LanguageCode.pt, value: 'Política de Privacidade' },
                    { languageCode: LanguageCode.en, value: 'Privacy Policy' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'termsOfUse',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Termos de Uso' },
                    { languageCode: LanguageCode.pt, value: 'Termos de Uso' },
                    { languageCode: LanguageCode.en, value: 'Terms of Use' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'faq',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Perguntas Frequentes' },
                    { languageCode: LanguageCode.pt, value: 'Perguntas Frequentes' },
                    { languageCode: LanguageCode.en, value: 'FAQ' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'returnPolicy',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Política de Devolução' },
                    { languageCode: LanguageCode.pt, value: 'Política de Devolução' },
                    { languageCode: LanguageCode.en, value: 'Return Policy' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'shippingInfo',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Informações de Envio' },
                    { languageCode: LanguageCode.pt, value: 'Informações de Envio' },
                    { languageCode: LanguageCode.en, value: 'Shipping Info' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'howItWorks',
                type: 'text',
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Como Funciona' },
                    { languageCode: LanguageCode.pt, value: 'Como Funciona' },
                    { languageCode: LanguageCode.en, value: 'How It Works' },
                ],
                nullable: true,
                internal: false,
                ui: { component: 'rich-text-form-input' },
            },
            {
                name: 'copyright',
                type: 'string',
                internal: false,
                nullable: true,
                label: [
                    { languageCode: LanguageCode.pt_BR, value: 'Direitos Autorais' },
                    { languageCode: LanguageCode.pt, value: 'Direitos Autorais' },
                    { languageCode: LanguageCode.en, value: 'Copyright' },
                ],
                defaultValue: 'Todos os direitos reservados.',
                ui: { component: 'text-form-input' },
            },
         ],
    },
};
