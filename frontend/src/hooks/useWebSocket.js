import { useEffect, useRef } from 'react';

function buildWsUrl() {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function normalizeStage(value) {
  return String(value || '').trim().toUpperCase();
}

function isRunningStage(value) {
  const normalized = normalizeStage(value);
  return normalized === 'ANALYZING'
    || normalized === 'RIPPING'
    || normalized === 'MEDIAINFO_CHECK'
    || normalized === 'ENCODING'
    || normalized === 'CD_ANALYZING'
    || normalized === 'CD_RIPPING'
    || normalized === 'CD_ENCODING';
}

export function useWebSocket({ onMessage }) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let socket;
    let reconnectTimer;
    let progressFlushTimer = null;
    let progressFlushRaf = null;
    const latestProgressMessagesByJob = new Map();
    let isUnmounted = false;

    const clearProgressFlush = () => {
      if (progressFlushRaf !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(progressFlushRaf);
      }
      if (progressFlushTimer) {
        clearTimeout(progressFlushTimer);
      }
      progressFlushRaf = null;
      progressFlushTimer = null;
    };

    const flushProgressMessage = () => {
      progressFlushRaf = null;
      progressFlushTimer = null;
      if (latestProgressMessagesByJob.size === 0) {
        return;
      }
      const messages = Array.from(latestProgressMessagesByJob.values());
      latestProgressMessagesByJob.clear();
      for (const message of messages) {
        onMessageRef.current?.(message);
      }
    };

    const scheduleProgressFlush = () => {
      if (progressFlushRaf !== null || progressFlushTimer) {
        return;
      }
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        progressFlushRaf = window.requestAnimationFrame(flushProgressMessage);
        return;
      }
      progressFlushTimer = setTimeout(flushProgressMessage, 16);
    };

    const connect = () => {
      if (isUnmounted) {
        return;
      }

      socket = new WebSocket(buildWsUrl());

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message?.type === 'PIPELINE_PROGRESS') {
            const progressJobId = message?.payload?.activeJobId;
            const jobKey = progressJobId == null ? '__global__' : String(progressJobId);
            const progressStage = normalizeStage(message?.payload?.state);
            if (isRunningStage(progressStage)) {
              latestProgressMessagesByJob.set(jobKey, message);
              scheduleProgressFlush();
            } else {
              latestProgressMessagesByJob.delete(jobKey);
              clearProgressFlush();
              flushProgressMessage();
              onMessageRef.current?.(message);
            }
            return;
          }
          flushProgressMessage();
          onMessageRef.current?.(message);
        } catch (error) {
          // ignore invalid json
        }
      };

      socket.onclose = () => {
        if (!isUnmounted) {
          reconnectTimer = setTimeout(connect, 1500);
        }
      };

      socket.onerror = () => {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      };
    };

    connect();

    return () => {
      isUnmounted = true;
      clearProgressFlush();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }
    };
  }, []);
}
