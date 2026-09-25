import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Electron-vite 5 starts a replacement before the old app releases its lock.
// Request a normal close so unsaved documents still get their save prompt.
let entry
try {
  entry = import.meta.resolve('electron-vite')
} catch (error) {
  if (
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    process.env.NODE_ENV === 'production'
  )
    process.exit(0)
  throw error
}

const packagePath = fileURLToPath(
  import.meta.resolve('electron-vite/package.json'),
)
const { version } = JSON.parse(await readFile(packagePath, 'utf8'))
if (version !== '5.0.0')
  throw new Error(
    'electron-vite version changed. Review the dev restart patch.',
  )

const chunks = [
  [
    './chunks/lib-7y7CgM8M.js',
    [
      ['        let ps;\n', '        let ps;\n        let restarting;\n'],
      [
        `                if (ps) {
                    ps.removeAllListeners();
                    ps.kill();
                    ps = startElectron(inlineConfig.root);
                    logger.info(colors.green(\`\\nrestarting electron app...\\n\`));
                }`,
        `                if (ps) {
                    if (restarting)
                        return restarting;
                    const previous = ps;
                    previous.removeListener('close', process.exit);
                    let finish;
                    restarting = new Promise((resolve) => { finish = resolve; });
                    let settled = false;
                    let receiptTimer;
                    const stopWaiting = () => {
                        if (settled) return false;
                        settled = true;
                        clearTimeout(receiptTimer);
                        previous.removeListener('close', onClose);
                        previous.removeListener('message', onMessage);
                        previous.on('close', process.exit);
                        restarting = undefined;
                        finish();
                        return true;
                    };
                    const onMessage = (message) => {
                        if (message === 'hibi:dev-restart-accepted') {
                            clearTimeout(receiptTimer);
                            return;
                        }
                        if (message === 'hibi:dev-restart-cancelled' &&
                            previous.exitCode === null && previous.signalCode === null &&
                            stopWaiting())
                            logger.info(colors.yellow(\`\\nelectron restart canceled; keeping current app\\n\`));
                    };
                    const onClose = () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(receiptTimer);
                        previous.removeListener('message', onMessage);
                        ps = startElectron(inlineConfig.root);
                        logger.info(colors.green(\`\\nrestarting electron app...\\n\`));
                        restarting = undefined;
                        finish();
                    };
                    previous.once('close', onClose);
                    previous.on('message', onMessage);
                    if (previous.exitCode === null && previous.signalCode === null) {
                        const failed = (error) => {
                            if (previous.exitCode !== null || previous.signalCode !== null)
                                return;
                            if (stopWaiting())
                                errorHook(new Error(\`Could not request a graceful Electron restart: \${error.message}\`));
                        };
                        receiptTimer = setTimeout(() => {
                            failed(new Error('Electron did not acknowledge the restart request within 10 seconds'));
                        }, 10000);
                        try {
                            if (!previous.connected)
                                throw new Error('IPC channel is closed');
                            previous.send('hibi:dev-restart', (error) => {
                                if (error) failed(error);
                            });
                        }
                        catch (error) {
                            failed(error);
                        }
                    }
                    return restarting;
                }`,
      ],
      [
        `                else {
                    watchHook();
                }`,
        `                else {
                    return watchHook();
                }`,
      ],
    ],
  ],
  [
    './chunks/lib-q6ns0vZr.js',
    [
      [
        "    const ps = spawn(electronPath, [entry].concat(args), { stdio: 'inherit' });",
        "    const ps = spawn(electronPath, [entry].concat(args), { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });",
      ],
    ],
  ],
]

const updates = []
for (const [relativePath, replacements] of chunks) {
  const path = fileURLToPath(new URL(relativePath, entry))
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      'electron-vite layout changed. Review the dev restart patch.',
      {
        cause: error,
      },
    )
  }
  let changed = false
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue
    if (!source.includes(before))
      throw new Error(
        'electron-vite changed. Review the dev restart patch before updating it.',
      )
    source = source.replace(before, after)
    changed = true
  }
  if (changed) updates.push([path, source])
}

for (const [path, source] of updates) await writeFile(path, source)
