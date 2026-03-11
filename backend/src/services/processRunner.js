const { spawn } = require('child_process');
const logger = require('./logger').child('PROCESS');
const { errorToMeta } = require('../utils/errorMeta');

function streamLines(stream, onLine) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r\n|\n|\r/);
    buffer = parts.pop() ?? '';

    for (const line of parts) {
      if (line.length > 0) {
        onLine(line);
      }
    }
  });

  stream.on('end', () => {
    if (buffer.length > 0) {
      onLine(buffer);
    }
  });
}

function spawnTrackedProcess({
  cmd,
  args,
  cwd,
  onStdoutLine,
  onStderrLine,
  onStart,
  context = {}
}) {
  logger.info('spawn:start', { cmd, args, cwd, context });

  const child = spawn(cmd, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });

  if (onStart) {
    onStart(child);
  }

  if (child.stdout && onStdoutLine) {
    streamLines(child.stdout, onStdoutLine);
  }

  if (child.stderr && onStderrLine) {
    streamLines(child.stderr, onStderrLine);
  }

  const promise = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      logger.error('spawn:error', { cmd, args, context, error: errorToMeta(error) });
      reject(error);
    });

    child.on('close', (code, signal) => {
      logger.info('spawn:close', { cmd, args, code, signal, context });
      if (code === 0) {
        resolve({ code, signal });
      } else {
        const error = new Error(`Prozess ${cmd} beendet mit Code ${code ?? 'null'} (Signal ${signal ?? 'none'}).`);
        error.code = code;
        error.signal = signal;
        reject(error);
      }
    });
  });

  let cancelCalled = false;
  const killProcessTree = (signal) => {
    const pid = Number(child.pid);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(-pid, signal);
        return true;
      } catch (_error) {
        // fallback below
      }
    }
    try {
      child.kill(signal);
      return true;
    } catch (_error) {
      return false;
    }
  };
  const cancel = () => {
    if (cancelCalled) {
      return;
    }
    cancelCalled = true;

    logger.warn('spawn:cancel:requested', { cmd, args, context, pid: child.pid });
    // Instant cancel by user request.
    killProcessTree('SIGKILL');
  };

  return {
    child,
    promise,
    cancel
  };
}

module.exports = {
  spawnTrackedProcess
};
