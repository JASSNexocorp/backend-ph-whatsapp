
import { Injectable, Logger } from "@nestjs/common";
import { generarIdentidadShopifyWhatsappClienteNuevo } from "src/core/whatsapp/shopify-cliente-identidad-whatsapp";
import { ShopifyAdminGraphqlService } from "../shopify/shopify-admin-graphql.service";
import { WhatsAppClienteEntity } from "../database/schemas/cliente-whatsapp.entity";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

const ALIAS_DIRECCION_PIVOTE_WHATSAPP = 'ÚLTIMA COMPRA WhatsApp';

/** Metafield informacion.extra alineado al front legacy (JSON string). */
function construirMetafieldExtraInicial(): string {
    const payload = {
        ci: '',
        nit: '',
        razon_social: '',
        fecha: '',
        permisosHutCoins: false,
        direcciones: [
            {
                lat: -17.51041339757574,
                lng: -63.164604605594825,
                indicaciones: 'Plaza Principal de Warnes, Santa Cruz.',
                alias: ALIAS_DIRECCION_PIVOTE_WHATSAPP,
            },
        ],
    };
    return JSON.stringify(payload);
}

function extraerIdNumericoCustomerGid(gid: string): string {
    const s = (gid ?? '').trim();
    if (!s) return '';
    return s.split('/').pop() ?? s;
}


/** Meta envía dígitos; Shopify usa +591XXXXXXXX. */
function normalizarTelefonoE164Bolivia(numeroWhatsapp: string): string {
    const soloDigitos = (numeroWhatsapp ?? '').replace(/\D/g, '');
    if (soloDigitos.startsWith('591') && soloDigitos.length >= 11) {
        return `+${soloDigitos}`;
    }
    if (soloDigitos.length === 8) {
        return `+591${soloDigitos}`;
    }
    return soloDigitos ? `+${soloDigitos}` : '';
}


@Injectable()
export class ShopifyClienteSincronizacionService {
    private readonly logger = new Logger(ShopifyClienteSincronizacionService.name);

    constructor(
        private readonly shopify: ShopifyAdminGraphqlService,
        @InjectRepository(WhatsAppClienteEntity)
        private readonly repoCliente: Repository<WhatsAppClienteEntity>,
    ) { }


    /**
     * Si el cliente aún no tiene shopifyClienteId: busca en Shopify por teléfono o crea el cliente.
     * Solo en alta nueva se aplica identidad pizzahut + fecha/hora + @gmail.com; si ya existe en Shopify solo se enlaza.
     */
    async enlazarOCrearClienteShopifySiHaceFalta(cliente: WhatsAppClienteEntity): Promise<void> {
        if (cliente.shopifyClienteId) {
            return;
        }
        if (!this.shopify.tieneCredencialesShopify()) {
            return;
        }
        const phoneE164 = normalizarTelefonoE164Bolivia(cliente.numeroWhatsapp);
        if (!phoneE164 || phoneE164.length < 8) {
            this.logger.warn(`Shopify sync: número inválido para cliente ${cliente.idCliente}`);
            return;
        }
        const encontrado = await this.buscarClientePorTelefonoExacto(phoneE164);
        if (encontrado) {
            cliente.shopifyClienteId = encontrado.idNumerico;
            await this.repoCliente.save(cliente);
            this.logger.log(`Shopify sync: enlazado cliente local ${cliente.idCliente} → ${encontrado.idNumerico}`);
            return;
        }
        const creado = await this.crearClienteShopifyMinimo(phoneE164);
        if (creado) {
            cliente.shopifyClienteId = creado;
            await this.repoCliente.save(cliente);
            this.logger.log(`Shopify sync: creado en Shopify ${creado} para cliente ${cliente.idCliente}`);
        }
    }

    private async buscarClientePorTelefonoExacto(
        phoneE164: string,
    ): Promise<{ idNumerico: string; gid: string } | null> {
        const query = `
          query CustomersByPhone($q: String!) {
            customers(first: 25, query: $q) {
              nodes {
                id
                phone
                defaultPhoneNumber { phoneNumber }
              }
            }
          }
        `;
        const q = `phone:\"${phoneE164}\"`;
        const raw = await this.shopify.ejecutarGraphqlAdminConReintentos<{
            data?: { customers?: { nodes?: Array<{ id?: string; phone?: string | null; defaultPhoneNumber?: { phoneNumber?: string | null } | null }> } };
            errors?: unknown;
        }>(query, { q });
        if (!raw || (raw as { errors?: unknown }).errors) {
            return null;
        }
        const nodes = raw.data?.customers?.nodes ?? [];
        for (const n of nodes) {
            const p = (n.phone ?? '').trim() || (n.defaultPhoneNumber?.phoneNumber ?? '').trim();
            if (p === phoneE164 && n.id) {
                return {
                    gid: n.id,
                    idNumerico: extraerIdNumericoCustomerGid(n.id),
                };
            }
        }
        return null;
    }

    private async crearClienteShopifyMinimo(phoneE164: string): Promise<string | null> {
        const { email, firstName, lastName } = generarIdentidadShopifyWhatsappClienteNuevo();
        const mutation = `
          mutation CreateCustomer($input: CustomerInput!) {
            customerCreate(input: $input) {
              customer { id phone }
              userErrors { field message }
            }
          }
        `;
        const variables = {
            input: {
                firstName,
                lastName,
                email,
                phone: phoneE164,
                metafields: [
                    {
                        namespace: 'informacion',
                        key: 'extra',
                        type: 'json_string',
                        value: construirMetafieldExtraInicial(),
                    },
                ],
            },
        };
        const raw = await this.shopify.ejecutarGraphqlAdminConReintentos<{
            data?: {
                customerCreate?: {
                    customer?: { id?: string };
                    userErrors?: Array<{ message?: string }>;
                };
            };
            errors?: unknown;
        }>(mutation, variables);
        const errs = raw?.data?.customerCreate?.userErrors;
        if (errs?.length) {
            this.logger.warn(`customerCreate userErrors: ${JSON.stringify(errs)}`);
        }
        const gid = raw?.data?.customerCreate?.customer?.id;
        return gid ? extraerIdNumericoCustomerGid(gid) : null;
    }
}
