import type {
    DatosOrdenSerializado,
    DireccionEntregaShopify,
    ItemOrdenShopify,
} from 'src/infrastructure/shopify/shopify-crear-orden.service';

/**
 * Línea mínima del POST notificar-carrito (misma forma que el DTO, sin depender del adaptador).
 */
export interface LineaCarritoNotificacionPlana {
    idOfisistema?: string;
    idShopify?: string;
    nombre: string;
    cantidad: number;
    opciones?: Array<{
        tituloSeccion: string;
        nombreOpcion: string;
        idOfisistema?: string;
    }>;
}

/**
 * Dirección mínima para Shopify/OfiSistema cuando el front no manda `datosOrdenSerializado`.
 * La dirección detallada puede completarse después desde el carrito de WhatsApp (ubicación).
 */
const DIRECCION_ENTREGA_POR_DEFECTO: DireccionEntregaShopify = {
    address1: 'Pedido vía WhatsApp — dirección en conversación',
    city: 'Santa Cruz de la Sierra',
    province: 'Andrés Ibáñez, Santa Cruz de la Sierra',
    provinceCode: 'SC',
    countryCode: 'BO',
    zip: '0000',
};

/**
 * Reparte el subtotal del pedido entre líneas en proporción a la cantidad de unidades,
 * para obtener un precioBase por ítem cuando no viene el JSON completo del front.
 */
function repartirSubtotalPorLineas(
    lineas: LineaCarritoNotificacionPlana[],
    subtotalProductos: number,
): number[] {
    const totalUnidades = lineas.reduce((acc, l) => acc + (l.cantidad ?? 0), 0);
    if (totalUnidades <= 0) {
        const n = lineas.length || 1;
        return lineas.map(() => subtotalProductos / n);
    }
    return lineas.map((l) => subtotalProductos * ((l.cantidad ?? 0) / totalUnidades));
}

/**
 * Arma `DatosOrdenSerializado` solo con líneas + subtotal del POST notificar-carrito.
 * Así el front no está obligado a enviar `datosOrdenSerializado` si ya manda ids y líneas.
 */
export function construirDatosOrdenDesdeLineasNotificacion(
    subtotalProductos: number,
    lineas: LineaCarritoNotificacionPlana[],
): DatosOrdenSerializado {
    const subtotal = subtotalProductos ?? 0;
    const subtotalesLinea = repartirSubtotalPorLineas(lineas, subtotal);

    const items: ItemOrdenShopify[] = lineas.map((l, idx) => {
        const subLinea = subtotalesLinea[idx] ?? 0;
        const cant = l.cantidad ?? 1;
        const precioBase = cant > 0 ? Math.round((subLinea / cant) * 100) / 100 : 0;
        const nombreLower = (l.nombre ?? '').toLowerCase();
        const coleccionesNombre = nombreLower.includes('pizza') ? ['pizza'] : undefined;

        return {
            idVarianteShopify: (l.idShopify ?? '').trim(),
            idOfisistema: (l.idOfisistema ?? '').trim() || '0',
            objNum: '',
            nombre: l.nombre,
            cantidad: cant,
            precioBase,
            coleccionesNombre,
            opciones: (l.opciones ?? []).map((o) => ({
                idOfisistema: (o.idOfisistema ?? '').trim() || '0',
                nombre: o.nombreOpcion,
                precio: 0,
                titulo: o.tituloSeccion,
            })),
        };
    });

    return {
        items,
        direccionEntrega: { ...DIRECCION_ENTREGA_POR_DEFECTO },
    };
}
