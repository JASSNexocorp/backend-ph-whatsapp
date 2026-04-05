/**
 * Tipos del JSON publico WHATSAPP_MENU_URL y del snapshot en memoria que consume el flujo WhatsApp.
 * Viven en core para que el puerto no dependa de infraestructura Nest/HTTP.
 */

/** Item de coleccion dentro del bloque menu (titulo + imagen). */
export interface WhatsappMenuLinkItem {
    title: string;
    image: string;
}

/** Bloque menu con titulo cabecera y lista de enlaces a colecciones. */
export interface WhatsappMenuBlock {
    title: string;
    links: WhatsappMenuLinkItem[];
}

/** Turno de atencion de una sucursal (dias 1-7 como en el JSON). */
export interface WhatsappTurnoSucursal {
    dias: number[];
    horaInicial: string;
    horaFinal: string;
}

/** Sucursal tal como viene en el JSON; id_shopify enriquecido = solo id numerico de Location (ej. 103470530844). */
export interface WhatsappSucursalMenuItem {
    id_ofisistema: string;
    id_shopify: string;
    lat: number;
    lng: number;
    nombre: string;
    estado: boolean;
    servicios: string[];
    turnos: WhatsappTurnoSucursal[];
    telefono: string;
    localizacion: string;
}

/** Reglas de carrito publicadas junto al menu. */
export interface WhatsappConfiguracionCarrito {
    cantidad_minima: number;
    costo_envio_domicilio: number;
}

/** Raiz exacta del JSON devuelto por WHATSAPP_MENU_URL. */
export interface WhatsAppInformacionTienda {
    menu: WhatsappMenuBlock;
    sucursales: WhatsappSucursalMenuItem[];
    configuracion_carrito: WhatsappConfiguracionCarrito;
}

/**
 * Misma forma que WhatsAppInformacionTienda: menu + sucursales + configuracion_carrito.
 * En memoria: sucursales ya vienen con id_shopify resuelto por Shopify cuando hay match;
 * costo_envio_domicilio en configuracion_carrito es el valor efectivo (JSON o override Shopify).
 */
export type WhatsappMenuSnapshot = WhatsAppInformacionTienda;