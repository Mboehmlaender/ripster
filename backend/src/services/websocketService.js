const { WebSocketServer } = require('ws');
const logger = require('./logger').child('WS');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Set();
  }

  init(httpServer) {
    if (this.wss) {
      return;
    }

    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      logger.info('client:connected', { clients: this.clients.size });

      socket.send(
        JSON.stringify({
          type: 'WS_CONNECTED',
          payload: { connectedAt: new Date().toISOString() }
        })
      );

      socket.on('close', () => {
        this.clients.delete(socket);
        logger.info('client:closed', { clients: this.clients.size });
      });

      socket.on('error', () => {
        this.clients.delete(socket);
        logger.warn('client:error', { clients: this.clients.size });
      });
    });
  }

  broadcast(type, payload) {
    if (!this.wss) {
      return;
    }

    logger.debug('broadcast', {
      type,
      clients: this.clients.size,
      payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : []
    });

    const message = JSON.stringify({
      type,
      payload,
      timestamp: new Date().toISOString()
    });

    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }
}

module.exports = new WebSocketService();
