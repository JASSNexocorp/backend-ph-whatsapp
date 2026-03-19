import { extractMessagesFromMeta } from '../../core/whatsapp/parsers/whatsapp-meta-parser';

describe('WhatsAppWebhookController - parsing', () => {
  it('parsea interactive button_reply y expone buttonReply.id y title', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '+59111122233',
                    id: 'wamid.test.1',
                    timestamp: 1714510003,
                    type: 'interactive',
                    interactive: {
                      button_reply: { id: 'FLOW1_HACER_PEDIDO', title: 'Hacer un pedido' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const extracted = extractMessagesFromMeta(payload);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].from).toBe('+59111122233');
    expect(extracted[0].messageId).toBe('wamid.test.1');
    expect(extracted[0].type).toBe('interactive');
    expect(extracted[0].buttonReply?.id).toBe('FLOW1_HACER_PEDIDO');
    expect(extracted[0].text).toBe('Hacer un pedido');
  });

  it('parsea location y expone coordenadas latitude/longitude', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '+59111122233',
                    id: 'wamid.test.2',
                    timestamp: 1714510004,
                    type: 'location',
                    location: { latitude: -17.66, longitude: -63.17, address: 'X', name: 'Y' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const extracted = extractMessagesFromMeta(payload);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].type).toBe('location');
    expect(extracted[0].location?.latitude).toBeCloseTo(-17.66);
    expect(extracted[0].location?.longitude).toBeCloseTo(-63.17);
  });
});

