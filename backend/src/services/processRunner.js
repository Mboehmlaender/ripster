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
    stdio: ['ignore', 'pipe', 'pipe']
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

  const cancel = () => {
    if (child.killed) {
      return;
    }

    logger.warn('spawn:cancel:requested', { cmd, args, context, pid: child.pid });
    child.kill('SIGINT');

    setTimeout(() => {
      if (!child.killed) {
        logger.warn('spawn:cancel:force-kill', { cmd, args, context, pid: child.pid });
        child.kill('SIGKILL');
      }
    }, 3000);
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
