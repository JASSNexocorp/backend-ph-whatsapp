/**
 * Catalogo alineado al JSON: por cada entrada { titulo, imagen } se resuelve la coleccion en Shopify y luego los productos.
 * El lote solo pide id+title de collections (bajo coste GraphQL); los productos van en queries separadas por coleccion para no superar max 1000 puntos de coste.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
    WhatsappCatalogoProducto,
    WhatsappCatalogoStockUbicacion,
    WhatsappColeccionJsonItem,
    WhatsappColeccionTienda,
} from '../../core/whatsapp/informacion-tienda-whatsapp.types';
import { ShopifyAdminGraphqlService } from './shopify-admin-graphql.service';

/** Fragmento de campos de Product reutilizado en la paginacion products(first) por gid de coleccion. */
const FRAGMENTO_NODO_PRODUCTO = `
  id
  handle
  title
  totalInventory
  collections(first: 5) {
    edges { node { title } }
  }
  images(first: 1) { edges { node { url } } }
  variants(first: 1) {
    edges {
      node {
        id
        price
        compareAtPrice
        availableForSale
        inventoryItem {
          inventoryLevels(first: 25) {
            edges {
              node {
                location { name }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
`;

@Injectable()
export class ShopifyCatalogCollectionsService {
    private readonly logger = new Logger(ShopifyCatalogCollectionsService.name);

    constructor(
        private readonly config: ConfigService,
        private readonly shopifyAdmin: ShopifyAdminGraphqlService,
    ) {}

    /**
     * Misma normalizacion que el match contra collections(query) — usada al fusionar productos en WebScrapingPhService.
     */
    normalizarTituloParaMatch(titulo: string): string {
        return this.normalizarTitulo(titulo);
    }

    /**
     * Por cada lote del JSON: busca collections por titulo (query barata) y carga productos por gid en llamadas aparte.
     */
    async obtenerCatalogoPorColeccionesEntrada(
        entradas: WhatsappColeccionJsonItem[],
    ): Promise<WhatsappColeccionTienda[] | null> {
        if (!entradas.length) {
            return [];
        }
        const tamanoLote = this.leerEntero('WHATSAPP_CATALOG_COLLECTION_BATCH_SIZE', 3);
        const productosPorPagina = this.leerEntero('WHATSAPP_CATALOG_PRODUCTS_PAGE_SIZE', 25);
        const delayMs = this.leerEntero('WHATSAPP_CATALOG_BATCH_DELAY_MS', 150);
        const imagenDefecto = this.config.get<string>('WHATSAPP_CATALOG_DEFAULT_IMAGE_URL') ?? '';

        const resultado: WhatsappColeccionTienda[] = [];
        const lotes = this.partirEnLotes(entradas, tamanoLote);

        for (let i = 0; i < lotes.length; i++) {
            const lote = lotes[i];
            const condicionLote = lote.map((e) => this.armarClausulaBusquedaTituloColeccion(e.titulo)).join(' OR ');
            // first mas alto que el lote: con OR Shopify puede devolver menos de una fila por clausula si first es chico.
            const firstCollections = Math.min(250, Math.max(lote.length * 5, 25));

            let edgesLote = await this.obtenerEdgesColeccionesSoloCabecera(condicionLote, firstCollections);
            if (edgesLote === null) {
                return null;
            }
            if (edgesLote.length === 0 && lote.length > 0) {
                this.logger.warn(
                    `Catalogo: lote sin resultados con query="${condicionLote}" — se reintenta titulo por titulo`,
                );
            }

            let mapaNodos = this.armarMapaTituloANodo(edgesLote);

            for (const entradaJson of lote) {
                const clave = this.normalizarTitulo(entradaJson.titulo);
                let nodoShopify = mapaNodos.get(clave);
                if (!nodoShopify) {
                    const encontrado = await this.buscarColeccionUnTituloConRespaldo(entradaJson.titulo);
                    if (encontrado) {
                        nodoShopify = encontrado;
                        mapaNodos.set(clave, encontrado);
                    }
                }
                if (!nodoShopify) {
                    this.logger.warn(`Catalogo: sin coleccion Shopify para "${entradaJson.titulo}" (revisa titulo en Admin vs JSON)`);
                    continue;
                }
                const { id } = nodoShopify;
                const productos = await this.acumularProductosDeConexion(
                    id,
                    undefined,
                    productosPorPagina,
                    imagenDefecto,
                );
                if (productos === null) {
                    return null;
                }
                resultado.push({
                    titulo: entradaJson.titulo,
                    imagen: entradaJson.imagen,
                    productos,
                });
            }

            if (delayMs > 0 && i < lotes.length - 1) {
                await this.esperar(delayMs);
            }
        }

        return resultado;
    }

    /**
     * Pagina products de una coleccion; si no hay primera pagina precargada, la pide con after null (evita mezclar todo en un solo query de coste alto).
     */
    private async acumularProductosDeConexion(
        collectionGid: string,
        primera: ConexionProductos | undefined,
        pageSize: number,
        imagenDefecto: string,
    ): Promise<WhatsappCatalogoProducto[] | null> {
        const lista: WhatsappCatalogoProducto[] = [];
        let conn: ConexionProductos | undefined = primera;

        const queryPagina = `
      query CatalogoProductosPagina($id: ID!, $first: Int!, $after: String) {
        collection(id: $id) {
          products(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { ${FRAGMENTO_NODO_PRODUCTO} } }
          }
        }
      }
    `;

        if (!conn) {
            const datosInicial = await this.shopifyAdmin.ejecutarGraphqlAdmin<RespuestaSoloProductos>(queryPagina, {
                id: collectionGid,
                first: pageSize,
                after: null,
            });
            if (datosInicial?.errors) {
                this.logger.warn(
                    `Catalogo primera pagina productos errors: ${JSON.stringify(datosInicial.errors)}`,
                );
                return null;
            }
            conn = datosInicial?.data?.collection?.products;
        }

        while (conn) {
            for (const edge of conn.edges ?? []) {
                const p = this.mapearProducto(edge?.node, imagenDefecto);
                if (p) {
                    lista.push(p);
                }
            }
            const hasNext = Boolean(conn.pageInfo?.hasNextPage);
            const after = conn.pageInfo?.endCursor ?? null;
            if (!hasNext) {
                break;
            }
            const datos = await this.shopifyAdmin.ejecutarGraphqlAdmin<RespuestaSoloProductos>(queryPagina, {
                id: collectionGid,
                first: pageSize,
                after,
            });
            if (datos?.errors) {
                this.logger.warn(`Catalogo pagina productos errors: ${JSON.stringify(datos.errors)}`);
                return null;
            }
            conn = datos?.data?.collection?.products;
        }

        return lista;
    }

    /**
     * Convierte nodo Product de Admin API al DTO del core (sin metafield: id_ofisistema usa handle).
     */
    private mapearProducto(nodo: unknown, imagenDefecto: string): WhatsappCatalogoProducto | null {
        if (!nodo || typeof nodo !== 'object') {
            return null;
        }
        const producto = nodo as Record<string, unknown>;
        const handle = String(producto.handle ?? '');
        const variants = producto.variants as { edges?: Array<{ node?: Record<string, unknown> }> } | undefined;
        const v0 = variants?.edges?.[0]?.node;
        if (!v0?.id) {
            return null;
        }
        const idShopify = String(v0.id).split('/').pop() ?? '';

        const sucursales: WhatsappCatalogoStockUbicacion[] = [];
        const invEdges = (
            v0.inventoryItem as
                | { inventoryLevels?: { edges?: Array<{ node?: Record<string, unknown> }> } }
                | undefined
        )?.inventoryLevels?.edges;
        for (const ne of invEdges ?? []) {
            const nivel = ne?.node;
            if (!nivel) {
                continue;
            }
            const nombreLoc = (nivel.location as { name?: string } | undefined)?.name ?? '';
            const qtys = nivel.quantities as Array<{ name?: string; quantity?: number }> | undefined;
            const disp = qtys?.find((q) => q.name === 'available');
            sucursales.push({ nombre: nombreLoc, stock: disp?.quantity ?? 0 });
        }

        const imgs = producto.images as { edges?: Array<{ node?: { url?: string } }> } | undefined;
        const urlImg = imgs?.edges?.[0]?.node?.url ?? imagenDefecto;

        const cols = producto.collections as { edges?: Array<{ node?: { title?: string } }> } | undefined;
        const nombresCols = (cols?.edges ?? []).map((e) => e.node?.title).filter(Boolean) as string[];

        let tags: string[] = [];
        if (Array.isArray(producto.tags)) {
            tags = producto.tags as string[];
        } else if (typeof producto.tags === 'string') {
            tags = [producto.tags];
        }

        const precio = Number.parseFloat(String(v0.price ?? '0'));
        const cmp = v0.compareAtPrice;
        const precioCmp = cmp != null ? Number.parseFloat(String(cmp)) : 0;

        return {
            id_shopify: idShopify,
            id_ofisistema: handle,
            obj_num: '',
            handle,
            nombre: String(producto.title ?? ''),
            colecciones: nombresCols,
            estado: Boolean(v0.availableForSale),
            precio: Number.isNaN(precio) ? 0 : precio,
            precio_comparacion: Number.isNaN(precioCmp) ? 0 : precioCmp,
            imagen: urlImg,
            stock_total: Number(producto.totalInventory ?? 0),
            sucursales,
        };
    }

    /**
     * Sintaxis de busqueda Shopify: title:"..." exige frase exacta (incluye mayusculas) y suele fallar si el JSON dice ENTRADAS y en Admin esta "Entradas".
     * Sin comillas en una sola palabra el match es mas tolerante; con espacios o & hay que usar comillas escapadas.
     */
    private armarClausulaBusquedaTituloColeccion(titulo: string): string {
        const t = titulo.trim();
        if (!t) {
            return 'title:""';
        }
        const necesitaComillas = /[\s&|()]/.test(t);
        if (necesitaComillas) {
            const inner = t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `title:"${inner}"`;
        }
        const atomo = t.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
        return `title:${atomo}`;
    }

    /**
     * Solo id y title de collections: coste bajo; los productos se cargan despues por coleccion.
     */
    private async obtenerEdgesColeccionesSoloCabecera(
        condicion: string,
        firstCollections: number,
    ): Promise<Array<{ node?: Record<string, unknown> }> | null> {
        const querySoloCabecera = `
        query CatalogoColeccionesCabecera($first: Int!, $q: String!) {
          collections(first: $first, query: $q) {
            edges {
              node {
                id
                title
              }
            }
          }
        }
      `;
        const datos = await this.shopifyAdmin.ejecutarGraphqlAdmin<RespuestaCollectionsLote>(querySoloCabecera, {
            first: firstCollections,
            q: condicion,
        });
        if (datos?.errors) {
            this.logger.warn(`Catalogo lote GraphQL errors: ${JSON.stringify(datos.errors)}`);
            return null;
        }
        return datos?.data?.collections?.edges ?? [];
    }

    /**
     * Si el lote OR no devolvio fila, reintenta una coleccion con clausula flexible y luego con frase entre comillas exacta.
     */
    private async buscarColeccionUnTituloConRespaldo(
        titulo: string,
    ): Promise<{ id: string; title: string } | null> {
        const clave = this.normalizarTitulo(titulo);
        const intentos = [
            this.armarClausulaBusquedaTituloColeccion(titulo),
            `title:"${titulo.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
        ];
        const unicos = [...new Set(intentos)];
        for (const q of unicos) {
            const edges = await this.obtenerEdgesColeccionesSoloCabecera(q, 15);
            if (edges === null) {
                return null;
            }
            const mapa = this.armarMapaTituloANodo(edges);
            const hit = mapa.get(clave);
            if (hit) {
                return hit;
            }
            if (edges.length === 1 && edges[0]?.node) {
                const n = edges[0].node as Record<string, unknown>;
                const title = String(n.title ?? '');
                if (this.normalizarTitulo(title) === clave) {
                    const id = String(n.id ?? '');
                    if (id) {
                        return { id, title };
                    }
                }
            }
        }
        return null;
    }

    private armarMapaTituloANodo(
        edges: Array<{ node?: Record<string, unknown> }>,
    ): Map<string, { id: string; title: string }> {
        const mapa = new Map<string, { id: string; title: string }>();
        for (const edge of edges) {
            const n = edge?.node;
            if (!n || typeof n !== 'object') {
                continue;
            }
            const id = String((n as { id?: string }).id ?? '');
            const title = String((n as { title?: string }).title ?? '');
            if (!id || !title) {
                continue;
            }
            mapa.set(this.normalizarTitulo(title), { id, title });
        }
        return mapa;
    }

    private normalizarTitulo(t: string): string {
        return t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    private partirEnLotes<T>(items: T[], tamano: number): T[][] {
        const out: T[][] = [];
        const n = Math.max(1, tamano);
        for (let j = 0; j < items.length; j += n) {
            out.push(items.slice(j, j + n));
        }
        return out;
    }

    private leerEntero(envKey: string, predeterminado: number): number {
        const raw = this.config.get<string>(envKey);
        const parsed = raw !== undefined ? Number.parseInt(raw, 10) : predeterminado;
        if (!Number.isFinite(parsed) || parsed < 1) {
            return predeterminado;
        }
        return parsed;
    }

    private esperar(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }
}

type ConexionProductos = {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string };
    edges?: Array<{ node?: unknown }>;
};

type RespuestaCollectionsLote = {
    errors?: unknown;
    data?: {
        collections?: { edges?: Array<{ node?: Record<string, unknown> }> };
    };
};

type RespuestaSoloProductos = {
    errors?: unknown;
    data?: { collection?: { products?: ConexionProductos } };
};
