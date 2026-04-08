
import { Injectable, Logger } from "@nestjs/common";
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

/**
 * Dominio fijo solo para cumplir formato email en Shopify (no es buzon real).
 * La unicidad va en el local-part: tmp.phbo + fecha + hora + aleatorio en America/La_Paz.
 */
const DOMINIO_FIJO_EMAIL_SINTETICO_SHOPIFY = 'phbo.whatsapp.sync';

/**
 * Email unico (tmp.phbo.fecha.hora.aleatorio) y nombre/apellido sinteticos tmp_phbo.
 * El unico dato real del cliente aqui es el telefono: va en `phone` y en lastName para verlo en Admin.
 */
function generarEmailYNombrePlaceholderShopify(soloDigitosTelefono: string): {
    email: string;
    firstName: string;
    lastName: string;
} {
    const ahora = new Date();
    const zona = 'America/La_Paz';
    const fecha = new Intl.DateTimeFormat('en-CA', {
        timeZone: zona,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(ahora);
    const hora = new Intl.DateTimeFormat('en-GB', {
        timeZone: zona,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(ahora);
    const [y, m, d] = fecha.split('-');
    const horaConPuntos = hora.replace(/:/g, '.');
    const sufijoMs = String(ahora.getTime()).slice(-6);
    const aleatorio = Math.random().toString(36).slice(2, 10);
    const localPart = `tmp.phbo.${y}.${m}.${d}.${horaConPuntos}.${sufijoMs}.${aleatorio}`;
    const digitos = soloDigitosTelefono.replace(/\D/g, '') || '0';
    return {
        email: `${localPart}@${DOMINIO_FIJO_EMAIL_SINTETICO_SHOPIFY}`,
        firstName: 'tmp_phbo',
        lastName: `tmp_phbo_${digitos}`,
    };
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
     * Fallas de red/API: se registran y no se bloquea el flujo WhatsApp.
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
        const encontrado = await this.buscarCustomerIdPorTelefonoExacto(phoneE164);
        if (encontrado) {
            cliente.shopifyClienteId = encontrado;
            await this.repoCliente.save(cliente);
            this.logger.log(`Shopify sync: enlazado cliente local ${cliente.idCliente} → ${encontrado}`);
            return;
        }
        const creado = await this.crearClienteShopifyMinimo(phoneE164, cliente);
        if (creado) {
            cliente.shopifyClienteId = creado;
            await this.repoCliente.save(cliente);
            this.logger.log(`Shopify sync: creado en Shopify ${creado} para cliente ${cliente.idCliente}`);
        }
    }

    private async buscarCustomerIdPorTelefonoExacto(phoneE164: string): Promise<string | null> {
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
            if (p === phoneE164) {
                return extraerIdNumericoCustomerGid(n.id ?? '');
            }
        }
        return null;
    }

    private async crearClienteShopifyMinimo(phoneE164: string, _cliente: WhatsAppClienteEntity): Promise<string | null> {
        const soloDigitos = phoneE164.replace(/\D/g, '');
        const { email, firstName, lastName } = generarEmailYNombrePlaceholderShopify(soloDigitos);
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