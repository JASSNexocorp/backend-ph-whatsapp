import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { PuertoManejadorMensajeEntrante } from "src/core/ports/puerto-manejador-mensaje-entrante";
import { MensajeEntranteWhatsappNormalizado } from "src/core/whatsapp/mensaje-entrante-whatsapp-normalizado";
import { WhatsAppGraphApiService } from "src/infrastructure/external-services/whatsapp-graph-api.service";
import { WhatsAppClienteEntity } from "src/infrastructure/database/schemas/cliente-whatsapp.entity";
import { WhatsAppConversacionEntity } from "src/infrastructure/database/schemas/whatsapp-conversation.entity";
import { Repository } from "typeorm";


type NodoConversacion =
    | 'inicio'
    | 'menu_principal'
    | 'seleccionar_tipo_pedido'
    | 'esperando_ubicacion_domicilio'
    | 'esperando_indicaciones_repartidor'
    | 'confirmar_indicaciones';

/**
 * Handler de flujo : interpreta el mensaje entrante segun el nodo_actual y responde 
 * Implementa el subflujo pedido : 
 * -> Hacer pedido
 * -> A Domicilio
 * -> Indicaciones
 * -> Confirmacion
 */

@Injectable()
export class AdaptadorManejadorMensajeEntranteFlujoDomicilio implements PuertoManejadorMensajeEntrante {
    constructor(
        private readonly whatsapp: WhatsAppGraphApiService,
        @InjectRepository(WhatsAppClienteEntity)
        private readonly repoCliente: Repository<WhatsAppClienteEntity>,
        @InjectRepository(WhatsAppConversacionEntity)
        private readonly repoConversacion: Repository<WhatsAppConversacionEntity>,
    ) { }

    async manejar(mensaje: MensajeEntranteWhatsappNormalizado): Promise<void> {
        // PASO 1 : Asegurar cliente + conversacion (memoria del bot)
        const { cliente, conversacion } = await this.asegurarClienteYConversacion(mensaje.numeroWhatsappOrigen);

        // PASO 2 : Renovar expiracion y actualizar actidad (regla 2 horas)
        await this.renovarConversacion(conversacion);
        // Persistir ultima_actividad / expira_en tras renovar (antes de enviar respuestas).
        await this.repoConversacion.save(conversacion);

        // PASO 3 : Marcar como leido y mostrar (typing)
        await this.whatsapp.marcarComoLeido(mensaje.idMensajeWhatsapp);
        await this.whatsapp.mostrarIndicadorEscritura(mensaje.idMensajeWhatsapp);

        // PASO 4 : Enrutar por nodo_actual
        const nodo = (conversacion.nodoActual as NodoConversacion) ?? 'inicio';

        // Atajo global : si el usuario escribe menu, volvemos al menu principal
        if (mensaje.tipo === 'texto') {
            const texto = (mensaje.textoPlano ?? '').trim().toLowerCase();
            if (texto === 'menu') {
                await this.enviarMenuPrincipal(mensaje.numeroWhatsappOrigen);
                conversacion.nodoActual = 'menu_principal';
                await this.repoConversacion.save(conversacion);
                return;
            }
        }

        if (nodo === 'inicio' || nodo === 'menu_principal') {
            // Si llega boton hacer_pedido => pasar a seleccionar tipo de pedido
            if (mensaje.idBotonPresionado === 'hacer_pedido') {
                await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
                conversacion.nodoActual = 'seleccionar_tipo_pedido';
                await this.repoConversacion.save(conversacion);
                return;
            }

            // Si el usuario manda cualquier cosa fuera del flujo, le pedimos seguir el flujo
            await this.whatsapp.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
            );
            await this.enviarMenuPrincipal(mensaje.numeroWhatsappOrigen);
            conversacion.nodoActual = 'menu_principal';
            await this.repoConversacion.save(conversacion);
            return;
        }

        if (nodo === 'seleccionar_tipo_pedido') {
            if (mensaje.idBotonPresionado === 'a_domicilio') {
                await this.whatsapp.enviarTexto(
                    mensaje.numeroWhatsappOrigen,
                    [
                        'Te solicitaremos 2 datos para la toma de tu pedido.',
                        '',
                        'Comparteme la ubicacion en la que quieres tu pedido 📝📌',
                        '(la ubicacion que envies sera donde entregaremos tu pedido)',
                        '',
                        'Si quieres seleccionar un lugar distinto al de tu ubicacion actual, debes ingresar la direccion completa en el mapa 📍',
                        '',
                        'Ejemplo : Av Banzer, Edif. Cristobal',
                    ].join('\n'),
                );
                conversacion.nodoActual = 'esperando_ubicacion_domicilio';
                await this.repoConversacion.save(conversacion);
                return;
            }

            if (mensaje.idBotonPresionado === 'retiro_local') {
                // Por ahora: según tu definición, siempre trabajamos domicilio
                await this.whatsapp.enviarTexto(
                    mensaje.numeroWhatsappOrigen,
                    'Por el momento solo estamos atendiendo pedidos A Domicilio. 🛵',
                );
                await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
                return;
            }

            await this.whatsapp.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
            );
            await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
            return;
        }

        if (nodo === 'esperando_ubicacion_domicilio') {
            if (mensaje.tipo === 'ubicacion' && mensaje.ubicacion) {
                // Guardamos ubicacion en carrito como contexto temporal
                // Nota : tu entidad tipa carrito como CarritoLinea[] por rapidez usamos any
                const carrito: any[] = Array.isArray(conversacion.carrito) ? (conversacion.carrito as any[]) : [];
                const sinContexto = carrito.filter((x) => x?._contexto !== 'domicilio');
                sinContexto.push({
                    _contexto: 'domicilio',
                    ubicacion: mensaje.ubicacion,
                });
                conversacion.carrito = sinContexto as any;

                await this.whatsapp.enviarTexto(
                    mensaje.numeroWhatsappOrigen,
                    [
                        '¡Genial! Por último, déjanos alguna indicación para el repartidor 🏠.',
                        '',
                        'Por ejemplo: color del portón, timbre, piso, referencia cercana, número de contacto, etc.',
                        '',
                        '📝 Esto nos ayuda a encontrarte más rápido. (Máximo 128 caracteres)',
                    ].join('\n'),
                );

                conversacion.nodoActual = 'esperando_indicaciones_repartidor';
                await this.repoConversacion.save(conversacion);
                return;
            }

            await this.whatsapp.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
            );
            return;
        }

        if (nodo === 'esperando_indicaciones_repartidor') {
            if (mensaje.tipo === 'texto') {
                const indicaciones = (mensaje.textoPlano ?? '').trim();
                if (!indicaciones || indicaciones.length > 128) {
                    await this.whatsapp.enviarTexto(
                        mensaje.numeroWhatsappOrigen,
                        'Por favor envía una indicación válida (máximo 128 caracteres).',
                    );
                    return;
                }

                // Guardamos indicaciones en contexto temporal
                const carrito: any[] = Array.isArray(conversacion.carrito) ? (conversacion.carrito as any[]) : [];
                const sinContexto = carrito.filter((x) => x?._contexto !== 'repartidor');
                sinContexto.push({
                    _contexto: 'repartidor',
                    indicaciones,
                });
                conversacion.carrito = sinContexto as any;

                await this.whatsapp.enviarTexto(
                    mensaje.numeroWhatsappOrigen,
                    [
                        '¡Perfecto! 🛵 Estas son las indicaciones que nos diste para el repartidor:',
                        '',
                        `📝 ${indicaciones}`,
                        '',
                        '¿Confirmas que son correctas?',
                        'Selecciona la opción que necesitas',
                    ].join('\n'),
                );

                await this.whatsapp.enviarMensajeBotones(
                    mensaje.numeroWhatsappOrigen,
                    '¿Confirmas que son correctas?',
                    'Selecciona la opción que necesitas',
                    [
                        { id: 'confirmar_indicaciones_si', texto: 'Si' },
                        { id: 'confirmar_indicaciones_no', texto: 'No' },
                        { id: 'cambiar_tipo_pedido', texto: 'Cambiar tipo pedido' },
                    ],
                );

                conversacion.nodoActual = 'confirmar_indicaciones';
                await this.repoConversacion.save(conversacion);
                return;
            }

            await this.whatsapp.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
            );

            return;
        }

        if (nodo === 'confirmar_indicaciones') {
            if (mensaje.idBotonPresionado === 'confirmar_indicaciones_si') {
                await this.whatsapp.enviarTexto(
                    mensaje.numeroWhatsappOrigen,
                    '¡Gracias! Continuamos con tu pedido. 🍕',
                );
                // Próximo paso pendiente: aquí iría selección de sucursal/productos/checkout.
                return;
            }

            if (mensaje.idBotonPresionado === 'confirmar_indicaciones_no') {
                await this.whatsapp.enviarTexto(
                    mensaje.numeroWhatsappOrigen,
                    'Entendido. Envíanos nuevamente tus indicaciones (máximo 128 caracteres).',
                );
                conversacion.nodoActual = 'esperando_indicaciones_repartidor';
                await this.repoConversacion.save(conversacion);
                return;
            }

            if (mensaje.idBotonPresionado === 'cambiar_tipo_pedido') {
                await this.enviarMenuTipoPedido(mensaje.numeroWhatsappOrigen);
                conversacion.nodoActual = 'seleccionar_tipo_pedido';
                await this.repoConversacion.save(conversacion);
                return;
            }


            await this.whatsapp.enviarTexto(
                mensaje.numeroWhatsappOrigen,
                'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
            );
            return;
        }
    }

    private async asegurarClienteYConversacion(numeroWhatsapp: string): Promise<{
        cliente: WhatsAppClienteEntity;
        conversacion: WhatsAppConversacionEntity;
    }> {
        // Busca o crea el cliente por numero
        let cliente = await this.repoCliente.findOne({ where: { numeroWhatsapp } });
        if (!cliente) {
            cliente = await this.repoCliente.save(
                this.repoCliente.create({
                    numeroWhatsapp,
                    nombre: null,
                    shopifyClienteId: null,
                    activo: true,
                })
            );
        }

        // Busca o crea la conversación (memoria del bot)
        let conversacion = await this.repoConversacion.findOne({
            where: { cliente: { idCliente: cliente.idCliente } } as any,
            relations: { cliente: true } as any,
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
            throw new Error('No se pudo crear u obtener la conversación de WhatsApp');
        }

        return { cliente, conversacion };
    }

    private async renovarConversacion(conversacion: WhatsAppConversacionEntity): Promise<void> {
        const ahora = new Date();
        const expira = new Date(conversacion.expiraEn);

        // Si expiro reseteamos estado segun la regla (carrito vacio y volver al inicio)
        if (ahora.getTime() > expira.getTime()) {
            conversacion.carrito = [] as any;
            conversacion.nodoActual = 'menu_principal';
        }

        // Siempre actualizamos timestamps/expiracion a 2 horas
        conversacion.ultimaActividad = ahora;
        conversacion.expiraEn = new Date(ahora.getTime() + 2 * 60 * 60 * 1000);
    }

    private async enviarMenuPrincipal(numeroDestino: string): Promise<void> {
        await this.whatsapp.enviarMensajeBotones(
            numeroDestino,
            'Selecciona una de las siguientes opciones 👇🏼',
            'En cualquier momento puedes regresar al menú enviando *menu*',
            [
                { id: 'hacer_pedido', texto: 'Hacer pedido' },
                { id: 'otras_opciones', texto: 'Otras opciones' },
            ],
        );
    }

    private async enviarMenuTipoPedido(numeroDestino: string): Promise<void> {
        await this.whatsapp.enviarMensajeBotones(
            numeroDestino,
            [
                'Elige tu tipo de pedido y su forma de pago aceptada.',
                '      - A Domicilio : efectivo 🛵',
                '      - Retiro Local : efectivo 🚶🏻‍♂️',
            ].join('\n'),
            'Selecciona una opción',
            [
                { id: 'a_domicilio', texto: 'A Domicilio' },
                { id: 'retiro_local', texto: 'Retiro Local' },
            ],
        );
    }
}