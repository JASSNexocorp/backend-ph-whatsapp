/**
 * Tipos del JSON publico WHATSAPP_WEBSCRAPING_URL y de la informacion de tienda cacheada en RAM (flujo WhatsApp).
 * Viven en core para que el puerto no dependa de infraestructura Nest/HTTP.
 */

/** Coleccion tal como viene en el JSON raiz (titulo + imagen; sin id Shopify en el contrato publico). */
export interface WhatsappColeccionJsonItem {
    titulo: string;
    imagen: string;
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

/** Reglas de carrito publicadas junto a colecciones y sucursales. */
export interface WhatsappConfiguracionCarrito {
    cantidad_minima: number;
    costo_envio_domicilio: number;
}

/**
 * Raiz exacta del JSON devuelto por WHATSAPP_WEBSCRAPING_URL (solo titulo + imagen por coleccion; sin productos en origen).
 */
export interface WhatsAppInformacionTienda {
    colecciones: WhatsappColeccionJsonItem[];
    sucursales: WhatsappSucursalMenuItem[];
    configuracion_carrito: WhatsappConfiguracionCarrito;
}

/**
 * Stock por ubicacion Shopify en un producto del catalogo (no es el mismo concepto que sucursal del JSON).
 */
export interface WhatsappCatalogoStockUbicacion {
    nombre: string;
    stock: number;
}

/**
 * Producto listo para API / flujo WhatsApp (alineado al modelo legacy del front, sin metafields).
 * id_shopify = id numerico de la primera variante.
 */
export interface WhatsappCatalogoProducto {
    id_shopify: string;
    id_ofisistema: string;
    obj_num: string;
    handle: string;
    nombre: string;
    colecciones: string[];
    estado: boolean;
    precio: number;
    precio_comparacion: number;
    imagen: string;
    stock_total: number;
    sucursales: WhatsappCatalogoStockUbicacion[];
}

/**
 * Coleccion tal como se expone en GET /tienda/informacion: titulo e imagen del JSON + productos desde Shopify por titulo.
 */
export interface WhatsappColeccionTienda {
    titulo: string;
    imagen: string;
    productos: WhatsappCatalogoProducto[];
}

/**
 * Informacion de tienda en RAM y en la API: colecciones ya con productos embebidos (mismo orden que el JSON).
 */
export interface WhatsappInformacionTiendaCache {
    colecciones: WhatsappColeccionTienda[];
    sucursales: WhatsappSucursalMenuItem[];
    configuracion_carrito: WhatsappConfiguracionCarrito;
}

/** Par titulo + handle de coleccion en Admin API (detalle de producto). */
export interface WhatsappColeccionProductoDetalle {
    titulo: string;
    handle: string;
}

/**
 * Producto resuelto por titulo o handle vía GET /tienda/producto (paridad con el front legacy + metafield estructura).
 */
export interface WhatsappProductoDetalleTienda extends WhatsappCatalogoProducto {
    metafield: Record<string, unknown>;
    tipo_producto: string;
    dia: string;
    url: string;
    colecciones_detalle: WhatsappColeccionProductoDetalle[];
}
