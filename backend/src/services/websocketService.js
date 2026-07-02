const { WebSocketServer } = require('ws');
const logger = require('./logger').child('WS');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Set();
  }

  _removeClient(socket, logLevel = 'info', event = 'client:removed') {
    if (!socket) {
      return;
    }
    const deleted = this.clients.delete(socket);
    if (!deleted) {
      return;
    }
    logger[logLevel](event, { clients: this.clients.size });
  }

  init(httpServer) {
    if (this.wss) {
      return;
    }

    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      logger.info('client:connected', { clients: this.clients.size });

      try {
        socket.send(
          JSON.stringify({
            type: 'WS_CONNECTED',
            payload: { connectedAt: new Date().toISOString() }
          })
        );
      } catch (error) {
        logger.warn('client:connected:initial-send-failed', {
          clients: this.clients.size,
          error: error?.message || String(error)
        });
        this._removeClient(socket, 'warn', 'client:connected:removed-after-send-failure');
        return;
      }

      socket.on('close', () => {
        this._removeClient(socket, 'info', 'client:closed');
      });

      socket.on('error', (error) => {
        logger.warn('client:error', {
          clients: this.clients.size,
          error: error?.message || String(error)
        });
        this._removeClient(socket, 'warn', 'client:error:removed');
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
      if (!client || client.readyState !== client.OPEN) {
        if (client && client.readyState === client.CLOSED) {
          this._removeClient(client, 'info', 'client:pruned-closed');
        }
        continue;
      }

      try {
        client.send(message, (error) => {
          if (!error) {
            return;
          }
          logger.warn('broadcast:send-failed', {
            type,
            clients: this.clients.size,
            error: error?.message || String(error)
          });
          this._removeClient(client, 'warn', 'client:removed-after-send-failure');
          try {
            client.terminate();
          } catch (_error) {
            // noop
          }
        });
      } catch (error) {
        logger.warn('broadcast:send-threw', {
          type,
          clients: this.clients.size,
          error: error?.message || String(error)
        });
        this._removeClient(client, 'warn', 'client:removed-after-send-throw');
        try {
          client.terminate();
        } catch (_terminateError) {
          // noop
        }
      }
    }
  }
}

module.exports = new WebSocketService();
