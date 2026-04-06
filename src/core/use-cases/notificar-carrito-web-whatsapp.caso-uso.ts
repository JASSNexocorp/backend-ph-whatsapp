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
 * Traduce el claim del JWT a texto amigable en el cuerpo del mensaje.
 */
function etiquetaTipoEntrega(raw: string): string {
    const t = raw.trim().toLowerCase();
    if (t === 'domicilio') {
        return 'A domicilio';
    }
    if (t === 'retiro' || t === 'retiro_local') {
        return 'Retiro en local';
    }
    return raw.trim() || '—';
}

/**
 * Construye el cuerpo del interactivo respetando el tope de caracteres de Meta.
 */
export function formatearCuerpoResumenCarritoWhatsapp(
    e: NotificarCarritoWebWhatsappEntrada,
): string {
    const lineasDetalle: string[] = [];
    for (const linea of e.lineas) {
        const partesOpciones = linea.opciones.map(
            (o) => `${o.tituloSeccion}: ${o.nombreOpcion}`,
        );
        const sufijo =
            partesOpciones.length > 0 ? `\n   ${partesOpciones.join(' · ')}` : '';
        lineasDetalle.push(`• ${linea.cantidad}× *${linea.nombre}*${sufijo}`);
    }

    const bloqueMontos: string[] = [
        `Subtotal productos: *${e.subtotalProductos}*`,
    ];
    if (
        e.subtotalComparacion != null &&
        e.subtotalComparacion > 0 &&
        e.subtotalComparacion !== e.subtotalProductos
    ) {
        bloqueMontos.push(`Referencia: ${e.subtotalComparacion}`);
    }
    if (e.costoEnvio > 0) {
        bloqueMontos.push(`Envío: *${e.costoEnvio}*`);
    }
    bloqueMontos.push(`*Total: ${e.total}*`);

    const armarCuerpo = (detalleLineas: string[]): string =>
        [
            '🛒 *Tu pedido desde el menú web*',
            '',
            `🏪 Sucursal: *${e.nombreSucursal}*`,
            `📦 ${etiquetaTipoEntrega(e.tipoEntrega)}`,
            '',
            ...detalleLineas,
            '',
            bloqueMontos.join('\n'),
            '',
            '¿Qué querés hacer?',
        ].join('\n');

    let cuerpo = armarCuerpo(lineasDetalle);
    if (cuerpo.length <= LIMITE_CUERPO_META) {
        return cuerpo;
    }

    // Si excede el límite, recortamos líneas desde el final y dejamos el total visible.
    const pie = ['', bloqueMontos.join('\n'), '', '¿Qué querés hacer?'].join('\n');
    const cabecera = [
        '🛒 *Tu pedido desde el menú web*',
        '',
        `🏪 Sucursal: *${e.nombreSucursal}*`,
        `📦 ${etiquetaTipoEntrega(e.tipoEntrega)}`,
        '',
    ].join('\n');

    const truncado = '_(Hay más productos; el total abajo incluye todo el carrito.)_';
    let usadas = [...lineasDetalle];
    while (usadas.length > 0) {
        const intento = `${cabecera}${usadas.join('\n')}\n${truncado}${pie}`;
        if (intento.length <= LIMITE_CUERPO_META) {
            return intento;
        }
        usadas = usadas.slice(0, -1);
    }

    return `${cabecera}${truncado}${pie}`.slice(0, LIMITE_CUERPO_META);
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
        const footer = 'Escribí *menu* para ir al inicio cuando quieras.';
        await this.whatsapp.enviarMensajeBotones(entrada.numeroWhatsappDestino, cuerpo, footer, [
            { id: IDS_BOTONES_CARRITO_WEB.confirmar, texto: 'Confirmar' },
            { id: IDS_BOTONES_CARRITO_WEB.modificar, texto: 'Modificar' },
            { id: IDS_BOTONES_CARRITO_WEB.cancelar, texto: 'Cancelar' },
        ]);
    }
}
