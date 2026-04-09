/**
 * Servicio para crear órdenes en OfiSistema (Tictuk) vía la API de apicloud.
 * Maneja la estructura anidada para pizzas (tamaño como padre) vs otros productos (lista plana).
 * Nunca lanza excepciones: errores se loggean y retornan como exito:false.
 */
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import type { DatosOrdenSerializado, ItemOrdenShopify } from './shopify-crear-orden.service';

// URL fija de la API intermediaria de OfiSistema.
const URL_OFISISTEMA = 'https://apicloud.farmacorp.com/shopifygraphql/api/ShopifyGraphQL/forward-order';

// Identificador de la tienda Pizza Hut en el sistema Tictuk.
const TICTUK_STORE_ID = '753d6cde-1f9b-1e9f-70cd-fc048eb25ce0';

// GUID del campo counter requerido por Tictuk en cada variación.
const CONTADOR_GUID = '75c860b5-1392-d9ed-6a73-fb7b85abb4d8';

export interface EntradaCrearOrdenOfisistema {
    shopifyOrdenNombre: string;
    sucursalOfisistemaId: string;
    tipoEntrega: 'DELIVERY' | 'PICKUP';
    metodoPago: 'efectivo' | 'tarjeta' | 'qr';
    nombreCliente: string;
    apellidoCliente: string;
    telefonoCliente: string;
    emailCliente: string | null;
    nitCliente: string | null;
    razonSocialCliente: string | null;
    precioTotal: number;
    costoEnvio: number;
    datos: DatosOrdenSerializado;
}

export interface ResultadoCrearOrdenOfisistema {
    exito: boolean;
    linkSeguimiento?: string;
    error?: string;
}

@Injectable()
export class OfisistemaCrearOrdenService {
    private readonly logger = new Logger(OfisistemaCrearOrdenService.name);

    constructor(private readonly http: HttpService) {}

    // Crea la orden en OfiSistema y retorna el link de seguimiento si la API lo proporciona.
    // Si la API falla, retorna exito:false sin interrumpir el flujo de confirmación al cliente.
    async crearOrden(entrada: EntradaCrearOrdenOfisistema): Promise<ResultadoCrearOrdenOfisistema> {
        try {
            console.log('[crearOrden][OfiSistema] entrada', {
                shopifyOrdenNombre: entrada.shopifyOrdenNombre,
                sucursalOfisistemaId: entrada.sucursalOfisistemaId,
                tipoEntrega: entrada.tipoEntrega,
                metodoPago: entrada.metodoPago,
                precioTotal: entrada.precioTotal,
                costoEnvio: entrada.costoEnvio,
                itemsCount: entrada.datos?.items?.length,
            });
            const idSucursalLimpio = this.extraerIdNumerico(entrada.sucursalOfisistemaId);
            const items = this.construirItems(entrada.datos.items, entrada.tipoEntrega);
            console.log('[crearOrden][OfiSistema] orderItems construidos', { count: items.length, apiStoreId: idSucursalLimpio });

            // Los precios se envían en centavos (x100) según el contrato de la API Tictuk.
            const precioTotalCentavos = Math.round(entrada.precioTotal * 100);
            const costoEnvioCentavos = Math.round(entrada.costoEnvio * 100);

            const payload = {
                tictukOrderId: entrada.shopifyOrdenNombre.replace('#', ''),
                developer: 'com.ph.web',
                tictukStoreId: TICTUK_STORE_ID,
                locale: 'es_ES',
                currency: 'BOB',
                apiStoreId: idSucursalLimpio,
                contact: {
                    firstName: entrada.nombreCliente,
                    lastName: entrada.apellidoCliente,
                    phone: entrada.telefonoCliente,
                    email: entrada.emailCliente ?? '',
                },
                orderType: entrada.tipoEntrega,
                tip: '0',
                tableId: '',
                orderItems: items,
                comment: [
                    `PAGO : ${this.mapearMetodoPago(entrada.metodoPago).toUpperCase()}`,
                    `TEL : ${entrada.telefonoCliente}`,
                    `NIT: ${entrada.nitCliente ?? ''}`,
                    entrada.razonSocialCliente ? `RS: ${entrada.razonSocialCliente}` : '',
                ].filter(Boolean).join(' | '),
                price: `${precioTotalCentavos}`,
                timezone: 'America/La_Paz',
                paymentMethod: this.mapearMetodoPago(entrada.metodoPago),
                onlinePayment: 'false',
                deliveryCharge: entrada.tipoEntrega === 'DELIVERY' ? `${costoEnvioCentavos}` : '0',
                deliveredBy: new Date().toISOString().slice(0, 19).replace('T', ' '),
                // La dirección solo se incluye en pedidos a domicilio.
                address: entrada.tipoEntrega === 'DELIVERY' && entrada.datos.direccionEntrega
                    ? this.construirDireccion(entrada.datos.direccionEntrega)
                    : [],
                pickupBy: null,
                paymentGatewayApprovalID: null,
                paymentGatewayName: null,
                cardType: null,
                AuthorizationCode: null,
                chargesAndDiscounts: null,
                dynamicAnswers: null,
                sduplicate: false,
                chargeAmount: '0',
                channel: 'WhatsApp',
                note: null,
                subOrderType: null,
                HostAuthorizationCode: null,
                TerminalId: null,
                MerchantId: null,
                BatchNumber: null,
            };

            console.log('[crearOrden][OfiSistema] POST', URL_OFISISTEMA, {
                tictukOrderId: payload.tictukOrderId,
                apiStoreId: payload.apiStoreId,
                orderItemsLength: Array.isArray(payload.orderItems) ? payload.orderItems.length : 0,
            });

            const respuesta = await firstValueFrom(
                this.http.post(URL_OFISISTEMA, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    // Timeout generoso para no colgar el bot indefinidamente.
                    timeout: 15000,
                }),
            );

            console.log('[crearOrden][OfiSistema] respuesta HTTP', {
                status: (respuesta as any)?.status,
                data: (respuesta as any)?.data,
            });

            const linkSeguimiento = this.extraerLink(respuesta.data);
            this.logger.log(`OfiSistema orden creada ${entrada.shopifyOrdenNombre}: ${linkSeguimiento ?? 'sin link'}`);
            return { exito: true, linkSeguimiento };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Error OfiSistema (no crítico): ${msg}`);
            console.log('[crearOrden][OfiSistema] error', error);
            return { exito: false, error: msg };
        }
    }

    // Construye los orderItems en el formato Tictuk, diferenciando pizzas de otros productos.
    private construirItems(items: ItemOrdenShopify[], metodoEntrega: string): unknown[] {
        const resultado: unknown[] = [];

        for (const item of items) {
            const esPizza = (item.coleccionesNombre ?? []).some(col =>
                col.toLowerCase().includes('pizza'),
            );

            const variationsChoices = this.construirVariaciones(item, metodoEntrega, esPizza);
            const esSimple = !item.opciones || item.opciones.length === 0;

            // integrationId incluye el objNum del combo cuando el producto tiene variaciones.
            const integrationId = esSimple
                ? item.idOfisistema 
                : `${item.idOfisistema }|CM${item.objNum ?? ''}`;

            // Cada unidad del mismo producto es un item separado en OfiSistema.
            for (let i = 0; i < (item.cantidad ?? 1); i++) {
                resultado.push({
                    tictukItemId: `${metodoEntrega}${item.idOfisistema }`,
                    integrationId,
                    taxCode: null,
                    title: item.nombre,
                    variations: [],
                    variationsChoices: variationsChoices.length > 0 ? [variationsChoices] : [],
                    price: `${Math.round((item.precioBase ?? 0) * 100)}`,
                    totalPrice: `${Math.round((item.precioBase ?? 0) * 100)}`,
                });
            }
        }

        return resultado;
    }

    // PIZZA: el tamaño es el nodo padre y los demás extras van dentro de su variationsChoices.
    // OTROS: todas las opciones van al mismo nivel (lista plana).
    private construirVariaciones(
        item: ItemOrdenShopify,
        metodoEntrega: string,
        esPizza: boolean,
    ): unknown[] {
        const opciones = item.opciones ?? [];
        if (!opciones.length) return [];

        if (esPizza) {
            const opTamano = opciones.find(op =>
                op.titulo?.toLowerCase().includes('tamaño') ||
                op.titulo?.toLowerCase().includes('tamano'),
            );
            const extras = opciones.filter(op =>
                !(op.titulo?.toLowerCase().includes('tamaño') ||
                  op.titulo?.toLowerCase().includes('tamano')),
            );

            // Si no encontramos tamaño, tratamos como producto normal para no romper el pedido.
            if (!opTamano) return this.opcionesPlanas(opciones, metodoEntrega);

            return [{
                itemId: `${metodoEntrega}${opTamano.idOfisistema}`,
                count: 1,
                title: { en_US: null, es_ES: opTamano.nombre },
                desc: {
                    en_US: null,
                    en_ID: `co-${opTamano.idOfisistema}-1`,
                    integrationNumber: opTamano.idOfisistema,
                    taxCode: null,
                    es_ES: '',
                },
                counter: CONTADOR_GUID,
                price: `${Math.round((opTamano.precio ?? 0) * 100)}`,
                variations: [],
                // Los extras van anidados dentro del objeto tamaño.
                variationsChoices: extras.length > 0
                    ? [extras.map(op => this.opcionBase(op, metodoEntrega, true))]
                    : [],
                html: true,
                precioLabel: null,
                media: null,
            }];
        }

        return this.opcionesPlanas(opciones, metodoEntrega);
    }

    // Convierte un array de opciones a la lista plana que usa OfiSistema para productos no pizza.
    private opcionesPlanas(
        opciones: NonNullable<ItemOrdenShopify['opciones']>,
        metodoEntrega: string,
    ): unknown[] {
        return opciones.map(op => this.opcionBase(op, metodoEntrega, false));
    }

    // Estructura base de una opción: es reutilizada tanto para nivel raíz como para sub-opciones.
    private opcionBase(
        opcion: { idOfisistema: string; nombre: string; precio: number },
        metodoEntrega: string,
        esSubOpcion: boolean,
    ): Record<string, unknown> {
        return {
            itemId: `${metodoEntrega}${opcion.idOfisistema}`,
            // count como string '1' para sub-opciones (extras pizza), como number 1 para raíz.
            count: esSubOpcion ? '1' : 1,
            title: { en_US: null, es_ES: opcion.nombre },
            desc: {
                en_US: null,
                en_ID: `co-${opcion.idOfisistema}-1`,
                // Sub-opciones llevan prefijo 'C' en integrationNumber según el contrato Tictuk.
                integrationNumber: esSubOpcion ? `C${opcion.idOfisistema}` : opcion.idOfisistema,
                taxCode: null,
                es_ES: '',
            },
            counter: CONTADOR_GUID,
            price: `${Math.round((opcion.precio ?? 0) * 100)}`,
            variations: [],
            variationsChoices: [],
            html: true,
            precioLabel: null,
            media: null,
        };
    }

    // Construye el objeto de dirección en el formato que espera la API de OfiSistema.
    private construirDireccion(
        dir: NonNullable<DatosOrdenSerializado['direccionEntrega']>,
    ): Record<string, unknown> {
        return {
            formatted: dir.address1,
            countryCode: dir.countryCode ?? 'BO',
            city: dir.city ?? 'Santa Cruz de la Sierra',
            street: dir.address1,
            number: '0',
            apt: null,
            floor: null,
            entrance: null,
            pobox: null,
            comment: dir.address2 ?? '',
            approximate: 'false',
            postalCode: null,
            additionalInfo: '',
        };
    }

    // Extrae el link de seguimiento de la respuesta de OfiSistema (puede ser texto o JSON).
    private extraerLink(data: unknown): string | undefined {
        if (typeof data === 'string') {
            if (data.startsWith('http')) return data;
            try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                return (
                    (typeof parsed['link'] === 'string' ? parsed['link'] : undefined) ??
                    (typeof parsed['url'] === 'string' ? parsed['url'] : undefined)
                );
            } catch { return undefined; }
        }
        if (data && typeof data === 'object') {
            const d = data as Record<string, unknown>;
            return (
                (typeof d['link'] === 'string' ? d['link'] : undefined) ??
                (typeof d['url'] === 'string' ? d['url'] : undefined) ??
                (typeof d['trackingUrl'] === 'string' ? d['trackingUrl'] : undefined)
            );
        }
        return undefined;
    }

    // Mapea el método de pago interno al string que espera la API de OfiSistema.
    private mapearMetodoPago(metodo: string): string {
        if (metodo === 'tarjeta') return 'credit';
        if (metodo === 'qr') return 'Pago QR';
        return 'cash';
    }

    // Extrae solo los dígitos de un ID que puede venir como GID de Shopify o string numérico.
    private extraerIdNumerico(id: string): string {
        const s = (id ?? '').trim();
        if (!s) return '0';
        return (s.split('/').pop() ?? s).replace(/\D/g, '') || '0';
    }
}