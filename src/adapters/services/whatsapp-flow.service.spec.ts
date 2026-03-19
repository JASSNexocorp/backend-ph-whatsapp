import { WhatsAppFlowService } from './whatsapp-flow.service';
import { CoverageUtil } from '../../core/whatsapp/utils/coverage.util';

describe('WhatsAppFlowService - flujo 1', () => {
  const flow = new WhatsAppFlowService();

  const nowDay = new Date().getDay();
  const candidatePoints = [
    { lat: -17.66, lng: -63.171 },
    { lat: -17.68, lng: -63.185 },
    { lat: -17.725, lng: -63.196 },
    { lat: -17.76, lng: -63.235 },
    { lat: -17.80, lng: -63.240 },
  ];

  const insidePoint =
    candidatePoints.find((p) => CoverageUtil.isInsideCoverage(p.lat, p.lng)) ??
    candidatePoints[0];

  const lat = insidePoint.lat;
  const lng = insidePoint.lng;

  const context = {
    bannerImageLink: undefined,
    menuUrl: 'https://pizzahut.com.bo/pages/whatsapp',
    menuMapping: {
      menu: { title: 'x', links: [] },
      configuracion_carrito: { cantidad_minima: 1, costo_envio_domicilio: 0 },
      sucursales: [
        {
          id_publico: '1',
          id: '1',
          lat,
          lng,
          nombre: 'SAN MARTIN',
          estado: true,
          servicios: ['domicilio'],
          turnos: [
            { dias: [nowDay], horaInicial: '11:05', horaFinal: '23:59' },
          ],
          telefono: '123456',
          backend: 'x',
          localizacion: '6RR2+97 Santa Cruz de la Sierra',
        },
      ],
    } as any,
  };

  it('avanza al solicitar ubicación al elegir DOMICILIO', () => {
    const result = flow.handleFlow({
      tipoFlujo: 'primera_compra',
      nodoActual: 'elegir_tipo_pedido',
      carrito: { estado_flujo: {} },
      input: { buttonReplyId: 'ORDER_DOMICILIO' },
      context,
    });

    expect(result.nextNode).toBe('solicitar_ubicacion');
    expect(result.outgoingMessages[0].kind).toBe('text');
  });

  it('valida cobertura y elige sucursal mas cercana con location', () => {
    const result = flow.handleFlow({
      tipoFlujo: 'primera_compra',
      nodoActual: 'solicitar_ubicacion',
      carrito: { estado_flujo: { orderType: 'domicilio' } },
      input: {
        location: { latitude: lat, longitude: lng },
      },
      context,
    });

    expect(result.nextNode).toBe('solicitar_indicaciones');
    expect(result.outgoingMessages[0].kind).toBe('text');
    expect((result.carrito as any).estado_flujo.sucursal.nombre).toBe('SAN MARTIN');
  });

  it('cuando envian indicaciones de texto, pide confirmacion con 3 botones', () => {
    const result = flow.handleFlow({
      tipoFlujo: 'primera_compra',
      nodoActual: 'solicitar_indicaciones',
      carrito: { estado_flujo: { orderType: 'domicilio' } },
      input: { text: 'color del porton azul, timbre y piso 2' },
      context,
    });

    expect(result.nextNode).toBe('solicitar_indicaciones');
    expect(result.outgoingMessages[0].kind).toBe('interactive_reply_buttons');
    expect((result.outgoingMessages[0] as any).buttons).toHaveLength(3);
  });

  it('al confirmar SI, envia 3 mensajes y resetea nodo a inicio', () => {
    const result = flow.handleFlow({
      tipoFlujo: 'primera_compra',
      nodoActual: 'solicitar_indicaciones',
      carrito: {
        estado_flujo: {
          orderType: 'domicilio',
          sucursal: {
            nombre: 'SAN MARTIN',
            localizacion: '6RR2+97 Santa Cruz de la Sierra',
            lat,
            lng,
            telefono: '123456',
            turnos: [{ dias: [nowDay], horaInicial: '11:05', horaFinal: '23:59' }],
          },
          indicaciones: 'x',
        },
      },
      input: { buttonReplyId: 'CONFIRMAR_SI' },
      context,
    });

    expect(result.nextNode).toBe('inicio');
    expect(result.outgoingMessages).toHaveLength(3);
  });
});

