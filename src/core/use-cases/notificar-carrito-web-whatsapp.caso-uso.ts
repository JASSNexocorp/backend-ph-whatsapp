import type { PuertoWhatsappGraphApi } from '../ports/puerto-whatsapp-graph-api';

/** IDs fijos de botones reply: deben coincidir con el manejador del webhook. */
export const IDS_BOTONES_CARRITO_WEB = {
    confirmar: 'carrito_web_confirmar',
    modificar: 'carrito_web_modificar',
    cancelar: 'carrito_web_cancelar',
} as const;

/** Línea ya normalizada para armar el texto del mensaje (sin ids de integración). */
export interface LineaCarritoNotificacionEntrada {
    nombre: string;
    cantidad: number;
    opciones: Array<{ tituloSeccion: string; nombreOpcion: string }>;
}

/**
 * Entrada del caso de uso: todo lo necesario para pintar el resumen y enviar los 3 botones.
 */
export interface NotificarCarritoWebWhatsappEntrada {
    numeroWhatsappDestino: string;
    nombreSucursal: string;
    tipoEntrega: string;
    subtotalProductos: number;
    subtotalComparacion?: number;
    costoEnvio: number;
    total: number;
    lineas: LineaCarritoNotificacionEntrada[];
}

const LIMITE_CUERPO_META = 1024;

/**
 * Traduce el claim del JWT a texto corto (sin palabras técnicas tipo "sucursal").
 */
function etiquetaTipoEntrega(raw: string): string {
    const t = raw.trim().toLowerCase();
    if (t === 'domicilio') {
        return 'Entrega a domicilio';
    }
    if (t === 'retiro' || t === 'retiro_local') {
        return 'Retiro en restaurante';
    }
    return raw.trim() || '—';
}

/**
 * Lista solo lo elegido (nombreOpcion), en el mismo orden que manda el front.
 * No se muestra tituloSeccion ("Ingredientes extra", "Tamaño", etc.).
 */
function listaSoloElecciones(
    opciones: Array<{ tituloSeccion: string; nombreOpcion: string }>,
): string[] {
    const lineas: string[] = [];
    for (const o of opciones ?? []) {
        const valor = (o.nombreOpcion ?? '').trim();
        if (!valor) {
            continue;
        }
        lineas.push(`_${valor}_`);
    }
    return lineas;
}

/**
 * Ítem: producto en negrita; debajo, una línea por cada elección (solo texto elegido).
 */
function formatearLineaPedido(linea: LineaCarritoNotificacionEntrada): string {
    const titulo = `*${linea.cantidad}× ${linea.nombre}*`;
    const detalles = listaSoloElecciones(linea.opciones ?? []);
    if (detalles.length === 0) {
        return titulo;
    }
    return [titulo, ...detalles].join('\n');
}

function armarCabeceraResumen(e: NotificarCarritoWebWhatsappEntrada): string {
    return [
        '🍕 *Resumen de tu pedido*',
        '',
        `🏪 _${e.nombreSucursal}_`,
        `📦 _${etiquetaTipoEntrega(e.tipoEntrega)}_`,
        '',
    ].join('\n');
}

function armarBloqueMontos(e: NotificarCarritoWebWhatsappEntrada): string {
    const lineas: string[] = [`_Subtotal: ${e.subtotalProductos}_`];
    // No mostramos subtotalComparacion en WhatsApp: confunde frente al subtotal/total del pedido.
    if (e.costoEnvio > 0) {
        lineas.push(`_Envío: ${e.costoEnvio}_`);
    }
    lineas.push(`*Total: ${e.total}*`);
    return lineas.join('\n');
}

/**
 * Construye el cuerpo del interactivo respetando el tope de caracteres de Meta (un solo mensaje + 3 botones).
 */
export function formatearCuerpoResumenCarritoWhatsapp(
    e: NotificarCarritoWebWhatsappEntrada,
): string {
    const bloqueMontos = armarBloqueMontos(e);
    // Sin texto extra al pie del cuerpo: los botones ya indican la acción (negocio pidió quitar "cómo continuar").
    const pie = `\n${bloqueMontos}`;

    const lineasDetalle: string[] = [];
    for (const linea of e.lineas) {
        lineasDetalle.push(formatearLineaPedido(linea));
    }

    // Entre productos: línea en blanco (más aire, sin barras decorativas).
    const cuerpoItems = lineasDetalle.join('\n\n');

    const armarCuerpo = (bloqueItems: string): string =>
        [armarCabeceraResumen(e), bloqueItems, pie].join('\n');

    let cuerpo = armarCuerpo(cuerpoItems);
    if (cuerpo.length <= LIMITE_CUERPO_META) {
        return cuerpo;
    }

    // Si excede el límite, quitamos productos desde el final hasta caber; el total siempre visible.
    const cabecera = armarCabeceraResumen(e);
    const truncado = '\n_(Incluye más productos; el total es el monto completo de tu pedido.)_\n';
    let items = [...lineasDetalle];
    while (items.length > 0) {
        const bloque = items.join('\n\n');
        const intento = `${cabecera}${bloque}${truncado}\n${bloqueMontos}`;
        if (intento.length <= LIMITE_CUERPO_META) {
            return intento;
        }
        items = items.slice(0, -1);
    }

    return `${cabecera}${truncado}\n${bloqueMontos}`.slice(0, LIMITE_CUERPO_META);
}

/**
 * Envía el resumen del carrito por WhatsApp con tres botones: confirmar, modificar, cancelar.
 * No usa indicador de escritura: el disparo viene del API web, no de un mensaje entrante.
 */
export class NotificarCarritoWebWhatsappCasoUso {
    constructor(private readonly whatsapp: PuertoWhatsappGraphApi) {}

    async ejecutar(entrada: NotificarCarritoWebWhatsappEntrada): Promise<void> {
        const cuerpo = formatearCuerpoResumenCarritoWhatsapp(entrada);
        // Footer corto: Meta limita a 60 caracteres en mensajes interactivos tipo botón.
        const footer = 'Escribí _menu_ para volver al inicio.';
        await this.whatsapp.enviarMensajeBotones(entrada.numeroWhatsappDestino, cuerpo, footer, [
            { id: IDS_BOTONES_CARRITO_WEB.confirmar, texto: 'Confirmar' },
            { id: IDS_BOTONES_CARRITO_WEB.modificar, texto: 'Modificar' },
            { id: IDS_BOTONES_CARRITO_WEB.cancelar, texto: 'Cancelar' },
        ]);
    }
}
