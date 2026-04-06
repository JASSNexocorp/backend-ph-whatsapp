/**
 * Busqueda puntual de un producto en Admin API por titulo o por handle (misma heuristica que el front legacy).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
    WhatsappCatalogoStockUbicacion,
    WhatsappColeccionProductoDetalle,
    WhatsappProductoDetalleTienda,
} from '../../core/whatsapp/informacion-tienda-whatsapp.types';
import { ShopifyAdminGraphqlService } from './shopify-admin-graphql.service';

type RespuestaProductoTitulo = {
    errors?: unknown;
    data?: {
        products?: {
            edges?: Array<{ node?: Record<string, unknown> }>;
        };
    };
};

@Injectable()
export class ShopifyProductByTitleService {
    private readonly logger = new Logger(ShopifyProductByTitleService.name);

    constructor(
        private readonly config: ConfigService,
        private readonly shopifyAdmin: ShopifyAdminGraphqlService,
    ) {}

    /**
     * Si el texto es solo digitos se asume busqueda por handle; si no, por title (comportamiento heredado del navegador).
     */
    async obtenerProductoDetallePorTituloOHandle(texto: string): Promise<WhatsappProductoDetalleTienda | null> {
        const termino = texto.trim();
        if (!termino) {
            return null;
        }
        const esSoloDigitos = /^\d+$/.test(termino);
        const campo = esSoloDigitos ? 'handle' : 'title';
        const queryFiltro = `${campo}:"${this.escaparParaQueryShopify(termino)}"`;

        const consulta = `
      query ProductoPorTituloOHandle($q: String!) {
        products(first: 1, query: $q) {
          edges {
            node {
              id
              handle
              title
              description
              totalInventory
              tags
              collections(first: 8) {
                edges {
                  node {
                    title
                    handle
                  }
                }
              }
              images(first: 1) {
                edges {
                  node {
                    url
                  }
                }
              }
              variants(first: 1) {
                edges {
                  node {
                    id
                    title
                    price
                    compareAtPrice
                    availableForSale
                    inventoryItem {
                      inventoryLevels(first: 50) {
                        edges {
                          node {
                            location {
                              name
                              id
                            }
                            quantities(names: ["available"]) {
                              name
                              quantity
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
              metafield(namespace: "estructura", key: "PersonalizableSecciones") {
                value
              }
            }
          }
        }
      }
    `;

        const datos = await this.shopifyAdmin.ejecutarGraphqlAdmin<RespuestaProductoTitulo>(consulta, {
            q: queryFiltro,
        });

        if (datos?.errors) {
            this.logger.warn(`ProductoPorTitulo GraphQL errors: ${JSON.stringify(datos.errors)}`);
            return null;
        }

        const nodo = datos?.data?.products?.edges?.[0]?.node;
        if (!nodo) {
            return null;
        }

        const imagenDefecto = this.config.get<string>('WHATSAPP_CATALOG_DEFAULT_IMAGE_URL') ?? '';
        return this.mapearNodoADetalle(nodo, imagenDefecto);
    }

    /**
     * Transforma el nodo Product de Shopify al DTO expuesto por la API REST.
     */
    private mapearNodoADetalle(nodo: Record<string, unknown>, imagenDefecto: string): WhatsappProductoDetalleTienda | null {
        const handle = String(nodo.handle ?? '');
        const variants = nodo.variants as { edges?: Array<{ node?: Record<string, unknown> }> } | undefined;
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

        const imgs = nodo.images as { edges?: Array<{ node?: { url?: string } }> } | undefined;
        const urlImg = imgs?.edges?.[0]?.node?.url ?? imagenDefecto;

        const cols = nodo.collections as {
            edges?: Array<{ node?: { title?: string; handle?: string } }>;
        } | undefined;
        const coleccionesDetalle: WhatsappColeccionProductoDetalle[] = (cols?.edges ?? [])
            .map((e) => ({
                titulo: String(e.node?.title ?? ''),
                handle: String(e.node?.handle ?? ''),
            }))
            .filter((c) => c.titulo.length > 0);
        const nombresCols = coleccionesDetalle.map((c) => c.titulo);

        let tags: string[] = [];
        if (Array.isArray(nodo.tags)) {
            tags = nodo.tags as string[];
        } else if (typeof nodo.tags === 'string') {
            tags = [nodo.tags];
        }

        const precio = Number.parseFloat(String(v0.price ?? '0'));
        const cmp = v0.compareAtPrice;
        const precioCmp = cmp != null ? Number.parseFloat(String(cmp)) : 0;

        let datosMetafield: Record<string, unknown> = {};
        const mf = nodo.metafield as { value?: string } | undefined;
        if (mf?.value) {
            try {
                const parsed = JSON.parse(mf.value) as unknown;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    datosMetafield = parsed as Record<string, unknown>;
                }
            } catch {
                datosMetafield = {};
            }
        }

        const idTrabajo = String(datosMetafield.id ?? handle);
        const objNum = String(datosMetafield.object_number ?? '');

        return {
            id_shopify: idShopify,
            id_ofisistema: idTrabajo,
            obj_num: objNum,
            handle,
            nombre: String(nodo.title ?? ''),
            colecciones: nombresCols,
            estado: Boolean(v0.availableForSale),
            precio: Number.isNaN(precio) ? 0 : precio,
            precio_comparacion: Number.isNaN(precioCmp) ? 0 : precioCmp,
            imagen: urlImg,
            stock_total: Number(nodo.totalInventory ?? 0),
            sucursales,
            metafield: datosMetafield,
            tipo_producto: '',
            dia: String(datosMetafield.dia ?? ''),
            url: `/products/${handle}`,
            colecciones_detalle: coleccionesDetalle,
        };
    }

    private escaparParaQueryShopify(valor: string): string {
        return valor.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
}
