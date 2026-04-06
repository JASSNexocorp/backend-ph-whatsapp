import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { NotificarCarritoWhatsappDto } from 'src/adapters/controllers/dtos/notificar-carrito-whatsapp.dto';
import { TOKEN_PUERTO_WHATSAPP_GRAPH_API } from 'src/core/ports/puerto-whatsapp-graph-api';
import type { PuertoWhatsappGraphApi } from 'src/core/ports/puerto-whatsapp-graph-api';
import {
    NotificarCarritoWebWhatsappCasoUso,
    type NotificarCarritoWebWhatsappEntrada,
} from 'src/core/use-cases/notificar-carrito-web-whatsapp.caso-uso';
import { MenuClienteJwtService } from 'src/infrastructure/auth/menu-cliente-jwt.service';
import { WhatsAppClienteEntity } from 'src/infrastructure/database/schemas/cliente-whatsapp.entity';
import { WhatsAppConversacionEntity } from 'src/infrastructure/database/schemas/whatsapp-conversation.entity';
import { Repository } from 'typeorm';

/**
 * Orquesta validación JWT, resolución del número WhatsApp, persistencia de contexto para "Modificar"
 * y envío del mensaje interactivo con el resumen del carrito.
 */
@Injectable()
export class NotificarCarritoWebWhatsappService {
    private readonly logger = new Logger(NotificarCarritoWebWhatsappService.name);

    constructor(
        private readonly menuClienteJwt: MenuClienteJwtService,
        @Inject(TOKEN_PUERTO_WHATSAPP_GRAPH_API)
        private readonly whatsapp: PuertoWhatsappGraphApi,
        @InjectRepository(WhatsAppClienteEntity)
        private readonly repoCliente: Repository<WhatsAppClienteEntity>,
        @InjectRepository(WhatsAppConversacionEntity)
        private readonly repoConversacion: Repository<WhatsAppConversacionEntity>,
        private readonly notificarCarrito: NotificarCarritoWebWhatsappCasoUso,
    ) {}

    /**
     * Valida el token, guarda sucursal/tipo de entrega en el carrito JSONB y envía el WhatsApp al cliente.
     */
    async ejecutar(dto: NotificarCarritoWhatsappDto): Promise<{ ok: true }> {
        const validacion = await this.menuClienteJwt.validarTokenMenu(dto.token);
        if (!validacion.valido) {
            throw new UnauthorizedException({
                ok: false,
                motivo: validacion.motivo,
                detalle: validacion.detalle,
            });
        }

        const idCliente = Number.parseInt(validacion.clienteId, 10);
        if (!Number.isFinite(idCliente)) {
            throw new UnauthorizedException({
                ok: false,
                motivo: 'TOKEN_INCOMPLETO',
                detalle: 'El identificador de cliente en el token no es válido.',
            });
        }

        const cliente = await this.repoCliente.findOne({
            where: { idCliente, activo: true },
        });
        if (!cliente) {
            throw new NotFoundException('Cliente no encontrado para este token.');
        }

        await this.persistirContextoMenuWeb(cliente, validacion.nombreSucursal, validacion.tipoEntrega, dto);

        const entrada: NotificarCarritoWebWhatsappEntrada = {
            numeroWhatsappDestino: cliente.numeroWhatsapp,
            nombreSucursal: validacion.nombreSucursal,
            tipoEntrega: validacion.tipoEntrega,
            subtotalProductos: dto.subtotalProductos,
            subtotalComparacion: dto.subtotalComparacion,
            costoEnvio: dto.costoEnvio,
            total: dto.total,
            lineas: dto.lineas.map((l) => ({
                nombre: l.nombre,
                cantidad: l.cantidad,
                opciones: (l.opciones ?? []).map((o) => ({
                    tituloSeccion: o.tituloSeccion,
                    nombreOpcion: o.nombreOpcion,
                })),
            })),
        };

        try {
            await this.notificarCarrito.ejecutar(entrada);
        } catch (err) {
            this.logger.error(
                `Fallo al enviar resumen de carrito por WhatsApp: ${err instanceof Error ? err.message : err}`,
            );
            throw err;
        }

        return { ok: true };
    }

    /**
     * Deja en el carrito un marcador con sucursal y tipo de entrega para regenerar el enlace al menú si el usuario toca "Modificar".
     */
    private async persistirContextoMenuWeb(
        cliente: WhatsAppClienteEntity,
        nombreSucursal: string,
        tipoEntrega: string,
        dto: NotificarCarritoWhatsappDto,
    ): Promise<void> {
        let conversacion = await this.repoConversacion.findOne({
            where: { cliente: { idCliente: cliente.idCliente } },
            relations: { cliente: true },
        });

        if (!conversacion) {
            const creada = await this.repoConversacion.save(
                this.repoConversacion.create({
                    cliente,
                    tipoFlujo: cliente.shopifyClienteId ? 'segunda_compra' : 'primera_compra',
                    nodoActual: 'menu_principal',
                    carrito: [],
                    activo: true,
                } as any),
            );
            conversacion = Array.isArray(creada) ? creada[0]! : creada;
        }

        if (!conversacion) {
            this.logger.warn(`Sin conversación para cliente ${cliente.idCliente}; no se persiste contexto menú web.`);
            return;
        }

        const raw = Array.isArray(conversacion.carrito) ? [...(conversacion.carrito as unknown[])] : [];
        const filtrado = raw.filter((x: any) => x?._contexto !== 'menu_web_activo');
        filtrado.push({
            _contexto: 'menu_web_activo',
            nombreSucursal: nombreSucursal.trim(),
            tipoEntrega: tipoEntrega.trim(),
            notificadoEn: new Date().toISOString(),
            resumenMontos: {
                subtotalProductos: dto.subtotalProductos,
                total: dto.total,
                lineas: dto.lineas.length,
            },
        });
        conversacion.carrito = filtrado as any;
        conversacion.ultimaActividad = new Date();
        await this.repoConversacion.save(conversacion);
    }
}
