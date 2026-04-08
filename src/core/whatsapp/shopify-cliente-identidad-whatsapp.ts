/**
 * Identidad sintetica solo al crear Customer nuevo desde WhatsApp:
 * nombre, apellido y base del email = pizzahut + fecha + hora (La Paz) + sufijo ms, todo corrido.
 * Al enlazar un cliente ya existente en Shopify no se usa esto (se conservan sus datos).
 */

/**
 * Genera firstName, lastName (iguales) y email unicos con pizzahut + yyyymmddHHmmss + ultimos digitos del timestamp.
 */
export function generarIdentidadShopifyWhatsappClienteNuevo(): {
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
    const horaCompacta = hora.replace(/:/g, '');
    const codigoFechaHora = `${y ?? ''}${m ?? ''}${d ?? ''}${horaCompacta}`;
    const sufijoUnicidad = String(ahora.getTime()).slice(-8);
    const id = `pizzahut${codigoFechaHora}${sufijoUnicidad}`;
    return {
        firstName: id,
        lastName: id,
        email: `${id}@gmail.com`,
    };
}
