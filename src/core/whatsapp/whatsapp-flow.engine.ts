import type { WhatsAppMenuMapping } from './types/menu-mapping.type';
import type { OutgoingMessage } from './types/outgoing-message.type';
import { CoverageUtil } from './utils/coverage.util';
import { getNearestBranch } from './utils/branch.util';

type OrderType = 'domicilio' | 'retiro';

type FlowState = {
  orderType?: OrderType;
  ubicacion?: { lat: number; lng: number };
  sucursal?: {
    nombre: string;
    localizacion: string;
    lat: number;
    lng: number;
    telefono: string;
    turnos: Array<{ dias: number[]; horaInicial: string; horaFinal: string }>;
  };
  indicaciones?: string;
};

export type FlowInput = {
  text?: string;
  buttonReplyId?: string;
  location?: { latitude?: number; longitude?: number };
  messageType?: string;
};

export type FlowContext = {
  menuMapping: WhatsAppMenuMapping;
  bannerImageLink: string | undefined;
  menuUrl: string | undefined;
};

export type FlowResult = {
  nextNode: string;
  carrito: unknown;
  outgoingMessages: OutgoingMessage[];
};

const NODE_INICIO = 'inicio';
const NODE_OPCIONES_INICIO = 'opciones_inicio';
const NODE_ELEGIR_TIPO_PEDIDO = 'elegir_tipo_pedido';
const NODE_SOLICITAR_UBICACION = 'solicitar_ubicacion';
const NODE_SOLICITAR_INDICACIONES = 'solicitar_indicaciones';

const BUTTON_HACER_PEDIDO = 'FLOW1_HACER_PEDIDO';
const BUTTON_VER_SUCURSALES = 'FLOW1_VER_SUCURSALES';

const BUTTON_TIPO_DOMICILIO = 'ORDER_DOMICILIO';
const BUTTON_TIPO_RETIRO = 'ORDER_RETIRO';

const BUTTON_CONFIRMAR_SI = 'CONFIRMAR_SI';
const BUTTON_CONFIRMAR_NO = 'CONFIRMAR_NO';
const BUTTON_CONFIRMAR_CAMBIAR_TIPO = 'CONFIRMAR_CAMBIAR_TIPO';

/**
 * Motor puro del flujo WhatsApp.
 * Dado `nodoActual` + input del cliente + contexto (menú/cobertura),
 * decide los mensajes a enviar y cuál será el siguiente nodo.
 */
export class WhatsAppFlowEngine {
  handleFlow(params: {
    tipoFlujo: 'primera_compra' | 'segunda_compra';
    nodoActual: string;
    carrito: unknown;
    input: FlowInput;
    context: FlowContext;
  }): FlowResult {
    const { tipoFlujo, nodoActual, carrito, input, context } = params;

    // FLUJO 2: por ahora se comporta igual; queda como extensión.
    void tipoFlujo;

    const prevFlowState = this.readFlowState(carrito);
    const menuCommand = this.normalizeText(input.text) === 'menu';

    if (menuCommand) {
      return this.goToInicio({ context });
    }

    if (nodoActual === NODE_INICIO) {
      return this.sendInicioAndAdvance(context);
    }

    if (nodoActual === NODE_OPCIONES_INICIO) {
      return this.handleOpcionesInicio({
        carrito: prevFlowState,
        input,
        context,
      });
    }

    if (nodoActual === NODE_ELEGIR_TIPO_PEDIDO) {
      return this.handleElegirTipoPedido({
        carrito: prevFlowState,
        input,
        context,
      });
    }

    if (nodoActual === NODE_SOLICITAR_UBICACION) {
      return this.handleSolicitarUbicacion({
        carrito: prevFlowState,
        input,
        context,
      });
    }

    if (nodoActual === NODE_SOLICITAR_INDICACIONES) {
      return this.handleSolicitarIndicaciones({
        carrito: prevFlowState,
        input,
        context,
      });
    }

    return this.goToInicio({ context });
  }

  private goToInicio(params: { context: FlowContext }): FlowResult {
    const estadoCarrito = this.buildCarritoWithFlowState([], {});
    return {
      nextNode: NODE_OPCIONES_INICIO,
      carrito: estadoCarrito,
      outgoingMessages: this.buildInicioMessages(params.context),
    };
  }

  private sendInicioAndAdvance(context: FlowContext): FlowResult {
    const currentFlowState: FlowState = {};
    return {
      nextNode: NODE_OPCIONES_INICIO,
      carrito: this.buildCarritoWithFlowState([], currentFlowState),
      outgoingMessages: this.buildInicioMessages(context),
    };
  }

  private handleOpcionesInicio(params: {
    carrito: FlowState;
    input: FlowInput;
    context: FlowContext;
  }): FlowResult {
    const { input, context } = params;
    const buttonId = input.buttonReplyId;

    if (buttonId === BUTTON_HACER_PEDIDO) {
      return {
        nextNode: NODE_ELEGIR_TIPO_PEDIDO,
        carrito: this.buildCarritoWithFlowState([], params.carrito),
        outgoingMessages: [
          {
            kind: 'interactive_reply_buttons',
            headerImage: this.tryBanner(context),
            bodyText: 'Elige tu tipo de pedido y su forma de pago aceptada.',
            footerText: undefined,
            buttons: [
              { id: BUTTON_TIPO_DOMICILIO, title: 'A Domicilio : efectivo 🛵' },
              { id: BUTTON_TIPO_RETIRO, title: 'Retiro Local : efectivo 🚶🏻‍♂️' },
            ],
          },
        ],
      };
    }

    if (buttonId === BUTTON_VER_SUCURSALES) {
      const branches = context.menuMapping.sucursales
        .filter((s) => s.estado)
        .map((s) => `🏪 ${s.nombre}\n📍 ${s.localizacion}`);

      const text =
        branches.length > 0
          ? `Estas son nuestras sucursales disponibles:\n\n${branches
              .slice(0, 8)
              .join('\n\n')}\n\nIngresa a nuestro menú para descubrir combos y productos.`
          : 'Por el momento no tenemos sucursales disponibles.';

      return {
        nextNode: NODE_OPCIONES_INICIO,
        carrito: this.buildCarritoWithFlowState([], params.carrito),
        outgoingMessages: [
          { kind: 'text', text },
          ...(context.menuUrl
            ? [{ kind: 'text', text: `Nuestro Menu\n${context.menuUrl}` } as const]
            : []),
        ],
      };
    }

    return this.fallbackAndKeepNode({
      context,
      carrito: params.carrito,
      node: NODE_OPCIONES_INICIO,
    });
  }

  private handleElegirTipoPedido(params: {
    carrito: FlowState;
    input: FlowInput;
    context: FlowContext;
  }): FlowResult {
    const { input, context } = params;
    const buttonId = input.buttonReplyId;

    let orderType: OrderType | undefined;
    if (buttonId === BUTTON_TIPO_DOMICILIO) orderType = 'domicilio';
    if (buttonId === BUTTON_TIPO_RETIRO) orderType = 'retiro';

    if (!orderType) {
      return this.fallbackAndKeepNode({
        context,
        carrito: params.carrito,
        node: NODE_ELEGIR_TIPO_PEDIDO,
      });
    }

    const text =
      'Te solicitaremos 2 datos para la toma de tu pedido.\n\n' +
      'Comparteme la ubicacion en la que quieres tu pedido 📝📌\n' +
      '(la ubicacion que envies sera donde entregaremos tu pedido)\n\n' +
      'Si quieres seleccionar un lugar distinto al de tu ubicacion actual, debes ingresar la direccion completa en el mapa 📍\n\n' +
      'Ejemplo : Av Banzer, Edif. Cristobal';

    return {
      nextNode: NODE_SOLICITAR_UBICACION,
      carrito: this.buildCarritoWithFlowState([], { ...params.carrito, orderType }),
      outgoingMessages: [{ kind: 'text', text }],
    };
  }

  private handleSolicitarUbicacion(params: {
    carrito: FlowState;
    input: FlowInput;
    context: FlowContext;
  }): FlowResult {
    const { input } = params;
    const orderType = params.carrito.orderType;
    if (!orderType) {
      return this.fallbackAndKeepNode({
        context: params.context,
        carrito: params.carrito,
        node: NODE_SOLICITAR_UBICACION,
      });
    }

    const lat = input.location?.latitude;
    const lng = input.location?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return {
        nextNode: NODE_SOLICITAR_UBICACION,
        carrito: this.buildCarritoWithFlowState([], params.carrito),
        outgoingMessages: [
          {
            kind: 'text',
            text: 'Por favor envíanos tu ubicación (compartir ubicación) para continuar con tu compra.',
          },
        ],
      };
    }

    const insideCoverage = CoverageUtil.isInsideCoverage(lat, lng);
    if (!insideCoverage) {
      return {
        nextNode: NODE_SOLICITAR_UBICACION,
        carrito: this.buildCarritoWithFlowState([], {
          ...params.carrito,
          ubicacion: { lat, lng },
        }),
        outgoingMessages: [
          {
            kind: 'text',
            text: 'Lo sentimos, tu ubicación está fuera de cobertura. Por favor envía otra ubicación para continuar con tu pedido.',
          },
        ],
      };
    }

    const candidates = params.context.menuMapping.sucursales.filter((s) => s.estado);
    const filteredByService = candidates.filter((s) =>
      this.branchHasService(s, orderType),
    );

    const nearest = getNearestBranch(lat, lng, filteredByService);
    if (!nearest) {
      return {
        nextNode: NODE_SOLICITAR_UBICACION,
        carrito: this.buildCarritoWithFlowState([], {
          ...params.carrito,
          ubicacion: { lat, lng },
        }),
        outgoingMessages: [
          {
            kind: 'text',
            text: 'No encontramos una sucursal disponible para tu tipo de pedido en esta zona. Por favor envíanos otra ubicación.',
          },
        ],
      };
    }

    const sucursalState = {
      nombre: String(nearest.nombre ?? 'Sucursal'),
      localizacion: String(nearest.localizacion ?? ''),
      lat: Number(nearest.lat),
      lng: Number(nearest.lng),
      telefono: String(nearest.telefono ?? ''),
      turnos: Array.isArray(nearest.turnos) ? nearest.turnos : [],
    };

    const indicacionesText =
      '¡Genial! Por último, déjanos alguna indicación para el repartidor 🏠.\n\n' +
      'Por ejemplo: color del portón, timbre, piso, referencia cercana, número de contacto, etc.\n\n' +
      '📝 Esto nos ayuda a encontrarte más rápido. (Máximo 128 caracteres)';

    return {
      nextNode: NODE_SOLICITAR_INDICACIONES,
      carrito: this.buildCarritoWithFlowState([], {
        ...params.carrito,
        ubicacion: { lat, lng },
        sucursal: sucursalState,
      }),
      outgoingMessages: [{ kind: 'text', text: indicacionesText }],
    };
  }

  private handleSolicitarIndicaciones(params: {
    carrito: FlowState;
    input: FlowInput;
    context: FlowContext;
  }): FlowResult {
    const { input, context } = params;
    const hasConfirmButtons =
      input.buttonReplyId === BUTTON_CONFIRMAR_SI ||
      input.buttonReplyId === BUTTON_CONFIRMAR_NO ||
      input.buttonReplyId === BUTTON_CONFIRMAR_CAMBIAR_TIPO;

    if (!hasConfirmButtons && input.text) {
      const indicaciones = input.text.trim();
      if (!indicaciones) {
        return this.fallbackAndKeepNode({
          context,
          carrito: params.carrito,
          node: NODE_SOLICITAR_INDICACIONES,
        });
      }
      if (indicaciones.length > 128) {
        return {
          nextNode: NODE_SOLICITAR_INDICACIONES,
          carrito: this.buildCarritoWithFlowState([], params.carrito),
          outgoingMessages: [
            {
              kind: 'text',
              text: 'Por favor ingresa indicaciones con un máximo de 128 caracteres.',
            },
          ],
        };
      }

      return {
        nextNode: NODE_SOLICITAR_INDICACIONES,
        carrito: this.buildCarritoWithFlowState([], {
          ...params.carrito,
          indicaciones,
        }),
        outgoingMessages: [
          {
            kind: 'interactive_reply_buttons',
            headerImage: this.tryBanner(context),
            bodyText:
              `Perfecto! 🛵 Estas son las indicaciones que nos diste para el repartidor:\n\n` +
              `📝 Trabajo\n¿Confirmas que son correctas?\nSelecciona la opción que necesitas`,
            buttons: [
              { id: BUTTON_CONFIRMAR_SI, title: 'SI' },
              { id: BUTTON_CONFIRMAR_NO, title: 'NO' },
              { id: BUTTON_CONFIRMAR_CAMBIAR_TIPO, title: 'CAMBIAR TIPO' },
            ],
          },
        ],
      };
    }

    if (input.buttonReplyId === BUTTON_CONFIRMAR_SI) {
      const sucursal = params.carrito.sucursal;
      if (!sucursal) {
        return this.fallbackAndKeepNode({
          context,
          carrito: params.carrito,
          node: NODE_SOLICITAR_INDICACIONES,
        });
      }

      const horario = this.buildHorarioStr(sucursal.turnos);
      const mapsUrl = `https://maps.google.com/?q=${sucursal.lat},${sucursal.lng}`;
      const menuUrl = context.menuUrl ?? '';

      return {
        nextNode: NODE_INICIO,
        carrito: this.buildCarritoWithFlowState([], {}),
        outgoingMessages: [
          { kind: 'text', text: 'Dame un momento, estoy verificando la cobertura... ⌛' },
          {
            kind: 'text',
            text:
              '¡Perfecto! La sucursal que te atenderá es:\n\n' +
              `🏪 ${sucursal.nombre}\n` +
              `📍 ${sucursal.localizacion}\n` +
              `🗺️ ${mapsUrl}\n\n` +
              `Horario: ${horario}\n\n` +
              'Ingresa a nuestro menú y descubre los mejores combos y productos al mejor precio. 🍕\n' +
              'Recuerda regresar a la conversación.',
          },
          ...(menuUrl
            ? [{ kind: 'text' as const, text: `Nuestro Menu\n${menuUrl}` }]
            : []),
        ],
      };
    }

    if (input.buttonReplyId === BUTTON_CONFIRMAR_NO) {
      return {
        nextNode: NODE_SOLICITAR_UBICACION,
        carrito: this.buildCarritoWithFlowState([], {
          ...params.carrito,
          sucursal: undefined,
          ubicacion: undefined,
          indicaciones: undefined,
        }),
        outgoingMessages: [
          {
            kind: 'text',
            text: 'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕\n\nComparteme la ubicacion en la que quieres tu pedido 📝📌',
          },
        ],
      };
    }

    if (input.buttonReplyId === BUTTON_CONFIRMAR_CAMBIAR_TIPO) {
      return {
        nextNode: NODE_ELEGIR_TIPO_PEDIDO,
        carrito: this.buildCarritoWithFlowState([], {
          ...params.carrito,
          orderType: undefined,
          sucursal: undefined,
          ubicacion: undefined,
          indicaciones: undefined,
        }),
        outgoingMessages: [
          {
            kind: 'interactive_reply_buttons',
            headerImage: this.tryBanner(context),
            bodyText: 'Elige tu tipo de pedido y su forma de pago aceptada.',
            buttons: [
              { id: BUTTON_TIPO_DOMICILIO, title: 'A Domicilio : efectivo 🛵' },
              { id: BUTTON_TIPO_RETIRO, title: 'Retiro Local : efectivo 🚶🏻‍♂️' },
            ],
          },
        ],
      };
    }

    return this.fallbackAndKeepNode({
      context,
      carrito: params.carrito,
      node: NODE_SOLICITAR_INDICACIONES,
    });
  }

  private fallbackAndKeepNode(params: {
    context: FlowContext;
    carrito: FlowState;
    node: string;
  }): FlowResult {
    return {
      nextNode: params.node,
      carrito: this.buildCarritoWithFlowState([], params.carrito),
      outgoingMessages: [
        {
          kind: 'text',
          text: 'Por favor sigue el flujo para continuar con tu compra. 👨‍🍳🍕',
        },
      ],
    };
  }

  private buildInicioMessages(context: FlowContext): OutgoingMessage[] {
    const banner = context.bannerImageLink;
    const welcome1 = '¡Hola! Bienvenid@ a pedidos Pizza Hut 🍕';
    const welcome2 =
      'Selecciona una de las siguientes opciones 👇🏼\n' +
      'En cualquier momento puedes regresar al menú enviando *menu*';

    const bannerMsg: OutgoingMessage = banner
      ? { kind: 'image', imageLink: banner, caption: welcome1 }
      : { kind: 'text', text: welcome1 };

    return [
      bannerMsg,
      {
        kind: 'interactive_reply_buttons',
        headerImage: this.tryBanner(context),
        bodyText: welcome2,
        buttons: [
          { id: BUTTON_HACER_PEDIDO, title: 'Hacer un pedido' },
          { id: BUTTON_VER_SUCURSALES, title: 'Ver sucursales' },
        ],
      },
    ];
  }

  private tryBanner(context: FlowContext): { link: string } | undefined {
    return context.bannerImageLink ? { link: context.bannerImageLink } : undefined;
  }

  private normalizeText(text?: string): string {
    return (text ?? '').trim().toLowerCase();
  }

  private readFlowState(carrito: unknown): FlowState {
    if (!carrito) return {};
    if (Array.isArray(carrito)) return {};
    if (typeof carrito === 'object') {
      const maybe = carrito as any;
      const estado = maybe.estado_flujo ?? {};
      if (estado && typeof estado === 'object') return estado as FlowState;
    }
    return {};
  }

  private buildCarritoWithFlowState(items: unknown[], state: FlowState): unknown {
    return {
      items,
      estado_flujo: state,
    };
  }

  private branchHasService(branch: any, orderType: OrderType): boolean {
    const services = Array.isArray(branch.servicios) ? branch.servicios.map((s: unknown) => String(s).toLowerCase()) : [];

    if (orderType === 'domicilio') {
      return services.some(
        (s: string) => s.includes('domicilio') || s.includes('delivery') || s.includes('casa'),
      );
    }

    return services.some(
      (s: string) => s.includes('retiro') || s.includes('local') || s.includes('pickup'),
    );
  }

  private buildHorarioStr(turnos: Array<{ dias: number[]; horaInicial: string; horaFinal: string }>): string {
    if (!turnos?.length) return 'Sin horario disponible';

    const day = new Date().getDay();
    const turno = turnos.find((t) => t.dias?.includes(day)) ?? turnos[0];
    if (!turno) return 'Sin horario disponible';

    return `${turno.horaInicial} - ${turno.horaFinal}`;
  }
}

