/**
 * Servicio para crear ordenes en Shopify via Admin GraphQL API
 * Orquesta orderCreate -> obtener fulfillmentOrder -> moverFulfillmentASucursal
 * Nunca Lanza excepciones al llamador : los errores se loggean y retornan como exito : false
 */

import { Inject, Injectable, Logger } from "@nestjs/common";
import { ShopifyAdminGraphqlService } from "./shopify-admin-graphql.service";

// Estructura de cada item del carrito para construir el lineItem de Shopify
export interface ItemOrdenShopify {
    idVarianteShopify: string;
    idOfisistema: string;
    objNum: string;
    nombre: string;
    cantidad: number;
    precioBase: number;
    coleccionesNombre?: string[];
    opciones?: Array<{
        idOfisistema: string;
        nombre: string;
        precio: number;
        titulo?: string;
    }>
}

// Direccion de entrega normalizada para el campo shippingAddress de Shopify
export interface DireccionEntregaShopify {
    address1: string;
    address2?: string;
    city: string;
    province: string;
    provinceCode: string;
    countryCode?: string;
    zip?: string;
}

// Datos completos del carrito tal como llegan serialiados desde el frontend
export interface DatosOrdenSerializado {
    items: ItemOrdenShopify[];
    direccionEntrega: DireccionEntregaShopify;
}

// Entrada completa para crear una orden en Shopify
export interface EntradaCrearOrdenShopify {
    shopifyClienteId: string;
    nombreCliente: string;
    telefonoCliente: string;
    emailCliente?: string;
    notaPedido: string;
    costoEnvio: number;
    tipoEntrega: 'DELIVERY' | 'PICKUP';
    metodoPago: string;
    datos: DatosOrdenSerializado;
}

// Resultado de la creacion : exito con ID y nombre de orden, o fallo con mensaje de error
export interface ResultadoCrearOrdenShopify {
    exito: boolean;
    ordenId?: string;
    ordenNombre?: string;
    error?: string;
}

@Injectable()
export class ShopifyCrearOrdenService {
    private readonly logger = new Logger(ShopifyCrearOrdenService.name);

    constructor(
        private readonly shopify: ShopifyAdminGraphqlService
    ) { }

    // Crea la orden completa en Shopify y retorna su ID GID y nombre (ej : #1023)
    // Si Shopify no tiene credenciales o falla retorna exito : false sin interrumpir el bot
    async crearOrden(entrada: EntradaCrearOrdenShopify): Promise<ResultadoCrearOrdenShopify> {
        try {
            console.log('[crearOrden][Shopify] entrada', {
                shopifyClienteId: entrada.shopifyClienteId,
                tipoEntrega: entrada.tipoEntrega,
                metodoPago: entrada.metodoPago,
                costoEnvio: entrada.costoEnvio,
                itemsCount: entrada.datos?.items?.length,
            });
            if (!this.shopify.tieneCredencialesShopify()) {
                console.log('[crearOrden][Shopify] abort: sin credenciales');
                return { exito: false, error: 'Sin credenciales de Shopify configuradas' };
            }
            const lineItems = this.construirLineItems(entrada.datos.items);
            console.log('[crearOrden][Shopify] lineItems construidos', { count: lineItems.length, lineItems });
            if (!lineItems.length) {
                console.log('[crearOrden][Shopify] abort: lineItems vacío');
                return { exito: false, error: 'Carrito vacío: no se puede crear la orden' };
            }
            const variables = {
                order: {
                    note: entrada.notaPedido || 'Sin nota',
                    currency: 'BOB',
                    lineItems,
                    taxesIncluded: false,
                    taxLines: [
                        {
                            priceSet: { shopMoney: { amount: '0.00', currencyCode: 'BOB' } },
                            rate: 0.0,
                            title: 'Sin impuesto',
                        },
                    ],
                    // Solo se agrega el costo de envío si el pedido es a domicilio.
                    shippingLines: entrada.costoEnvio > 0
                        ? [{
                            title: 'Envío a Domicilio',
                            priceSet: {
                                shopMoney: {
                                    amount: entrada.costoEnvio.toFixed(2),
                                    currencyCode: 'BOB',
                                },
                            },
                        }]
                        : [],
                    customer: {
                        // toAssociate vincula el cliente existente sin crear uno nuevo.
                        toAssociate: {
                            id: `gid://shopify/Customer/${entrada.shopifyClienteId}`,
                        },
                    },
                    // La orden se marca como PAID porque el cobro ocurre en el momento del pedido.
                    financialStatus: 'PAID',
                    shippingAddress: this.construirDireccionEnvio(
                        entrada.nombreCliente,
                        entrada.telefonoCliente,
                        entrada.datos.direccionEntrega,
                    ),
                    customAttributes: this.construirAtributosPersonalizados(entrada),
                    metafields: [
                        {
                            namespace: 'estructura',
                            key: 'datos_carrito_whatsapp',
                            type: 'json_string',
                            value: JSON.stringify(entrada.datos.items),
                        },
                    ],
                },
                options: {
                    // DECREMENT_OBEYING_POLICY respeta la política de inventario del producto.
                    inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
                },
            };
            const mutation = `
                mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
                    orderCreate(order: $order, options: $options) {
                        order { id name totalPrice }
                        userErrors { field message }
                    }
                }
            `;
            const respuesta = await this.shopify.ejecutarGraphqlAdmin<{
                data?: {
                    orderCreate?: {
                        order?: { id?: string; name?: string };
                        userErrors?: Array<{ field?: string; message?: string }>;
                    };
                };
                errors?: unknown;
            }>(mutation, variables);
            console.log('[crearOrden][Shopify] respuesta GraphQL raw', JSON.stringify(respuesta, null, 2));
            if (!respuesta || (respuesta as any).errors) {
                this.logger.error(`orderCreate errores GraphQL: ${JSON.stringify((respuesta as any)?.errors)}`);
                console.log('[crearOrden][Shopify] error capa GraphQL', (respuesta as any)?.errors);
                return { exito: false, error: 'Error en la API de Shopify' };
            }
            const erroresUsuario = respuesta.data?.orderCreate?.userErrors ?? [];
            if (erroresUsuario.length > 0) {
                this.logger.error(`orderCreate userErrors: ${JSON.stringify(erroresUsuario)}`);
                console.log('[crearOrden][Shopify] userErrors', erroresUsuario);
                return { exito: false, error: erroresUsuario.map(e => e.message).join(', ') };
            }
            const orden = respuesta.data?.orderCreate?.order;
            if (!orden?.id) {
                console.log('[crearOrden][Shopify] abort: order sin id', { orden });
                return { exito: false, error: 'Shopify no retornó el ID de la orden' };
            }
            console.log('[crearOrden][Shopify] OK', { ordenId: orden.id, ordenNombre: orden.name });
            return { exito: true, ordenId: orden.id, ordenNombre: orden.name ?? '' };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Error general al crear orden Shopify: ${msg}`);
            console.log('[crearOrden][Shopify] excepción', error);
            return { exito: false, error: msg };
        }
    }

    // Obtiene el primer fulfillmentOrder de la orden y lo mueve a la sucursal indicada.
    // Si ya está en esa sucursal o falla, solo loggea — nunca interrumpe la confirmación al cliente.
    async moverFulfillmentASucursal(shopifyOrdenId: string, shopifyLocationId: string): Promise<void> {
        try {
            console.log('[crearOrden][Shopify] moverFulfillmentASucursal', { shopifyOrdenId, shopifyLocationId });
            const fulfillmentOrderId = await this.obtenerPrimerFulfillmentOrderId(shopifyOrdenId);
            if (!fulfillmentOrderId) {
                this.logger.warn(`No se encontró fulfillmentOrder para la orden ${shopifyOrdenId}`);
                return;
            }
            // Normalizamos el locationId a GID completo si viene solo como número.
            const locationGid = shopifyLocationId.includes('gid://')
                ? shopifyLocationId
                : `gid://shopify/Location/${shopifyLocationId}`;
            const mutation = `
                mutation MoverFulfillment($id: ID!, $newLocationId: ID!) {
                    fulfillmentOrderMove(id: $id, newLocationId: $newLocationId) {
                        movedFulfillmentOrder { id status }
                        originalFulfillmentOrder { id status }
                        userErrors { field message }
                    }
                }
            `;
            const respuesta = await this.shopify.ejecutarGraphqlAdmin<{
                data?: {
                    fulfillmentOrderMove?: {
                        userErrors?: Array<{ message?: string }>;
                    };
                };
            }>(mutation, { id: fulfillmentOrderId, newLocationId: locationGid });
            const errores = respuesta?.data?.fulfillmentOrderMove?.userErrors ?? [];
            if (errores.length > 0) {
                // Shopify puede dar error si el fulfillment ya está en esa ubicación — no es crítico.
                this.logger.warn(`fulfillmentOrderMove userErrors (no crítico): ${JSON.stringify(errores)}`);
            }
        } catch (error) {
            // El movimiento de fulfillment NO debe impedir que el cliente reciba su confirmación.
            this.logger.error(`Error al mover fulfillment (no crítico): ${error instanceof Error ? error.message : error}`);
        }
    }

    // Consulta los fulfillmentOrders de una orden y retorna el ID GID del primero.
    private async obtenerPrimerFulfillmentOrderId(shopifyOrdenId: string): Promise<string | null> {
        const query = `
            query FulfillmentOrders($id: ID!) {
                order(id: $id) {
                    fulfillmentOrders(first: 5) {
                        edges { node { id status } }
                    }
                }
            }
        `;
        const respuesta = await this.shopify.ejecutarGraphqlAdmin<{
            data?: {
                order?: {
                    fulfillmentOrders?: {
                        edges?: Array<{ node?: { id?: string; status?: string } }>;
                    };
                };
            };
        }>(query, { id: shopifyOrdenId });
        return respuesta?.data?.order?.fulfillmentOrders?.edges?.[0]?.node?.id ?? null;
    }

    // Convierte los items del carrito al formato lineItems que espera la mutación orderCreate.
    private construirLineItems(items: ItemOrdenShopify[]): unknown[] {
        return items.map(item => {
            // El precio del lineItem en Shopify es base + suma de todas las opciones seleccionadas.
            const precioOpciones = (item.opciones ?? []).reduce((acc, op) => acc + (op.precio ?? 0), 0);
            const precioTotal = (item.precioBase ?? 0) + precioOpciones;
            // Normalizamos el variantId a GID completo si el frontend envió solo el número.
            const variantId = item.idVarianteShopify.includes('gid://')
                ? item.idVarianteShopify
                : `gid://shopify/ProductVariant/${item.idVarianteShopify}`;
            // Las properties muestran las opciones elegidas como etiquetas en el panel de Shopify.
            const properties: Array<{ name: string; value: string }> = [];
            const opcionesValidas = (item.opciones ?? []).filter(op => op.nombre?.trim());
            if (opcionesValidas.length > 0) {
                properties.push({ name: '🛍️ OPCIONES PRINCIPALES', value: '' });
                opcionesValidas.forEach(op => properties.push({ name: `▸ ${op.nombre}`, value: '' }));
            }
            return {
                variantId,
                quantity: item.cantidad ?? 1,
                priceSet: {
                    shopMoney: { amount: precioTotal.toFixed(2), currencyCode: 'BOB' },
                },
                requiresShipping: true,
                properties,
            };
        });
    }

    // Construye el shippingAddress separando el nombre completo en firstName y lastName.
    private construirDireccionEnvio(
        nombreCliente: string,
        telefono: string,
        direccion?: DireccionEntregaShopify,
    ): Record<string, string> {
        const partes = (nombreCliente ?? '').trim().split(/\s+/);
        const firstName = partes[0] ?? '';
        const lastName = partes.slice(1).join(' ') || '';
        return {
            firstName,
            lastName,
            phone: telefono,
            address1: direccion?.address1 ?? 'Sin dirección',
            address2: direccion?.address2 ?? '',
            city: direccion?.city ?? 'Santa Cruz',
            province: direccion?.province ?? 'Andrés Ibáñez, Santa Cruz de la Sierra',
            provinceCode: direccion?.provinceCode ?? 'SC',
            countryCode: direccion?.countryCode ?? 'BO',
            zip: direccion?.zip ?? '0000',
        };
    }

    // Construye los customAttributes con los datos clave del pedido para visualizarlos en Shopify.
    private construirAtributosPersonalizados(entrada: EntradaCrearOrdenShopify): Array<{ key: string; value: string }> {
        const atributos: Array<{ key: string; value: string }> = [
            { key: 'DATOS CLIENTE', value: '' },
            { key: 'Nombre', value: entrada.nombreCliente },
            { key: 'Celular', value: entrada.telefonoCliente },
            { key: 'Metodo Pago', value: entrada.metodoPago },
            {
                key: 'Metodo Entrega',
                value: entrada.tipoEntrega === 'DELIVERY' ? 'Envío a Domicilio' : 'Recojo en Local',
            },
        ];
        // Email solo se incluye si el cliente lo proporcionó durante el flujo del bot.
        if (entrada.emailCliente) {
            atributos.push({ key: 'Email', value: entrada.emailCliente });
        }
        return atributos;
    }
}