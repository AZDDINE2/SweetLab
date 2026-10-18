// Lancé automatiquement avant "npm start" (script "prestart").
// Si un ancien serveur SweetLab occupe encore les ports 3000 / 3001, on l'arrête.
// Un port pris par un AUTRE programme n'est jamais touché : on affiche seulement un message.
const { execSync } = require('child_process');

const PORTS = [Number(process.env.PORT || 3000), Number(process.env.PUBLIC_PORT || 3001)];
const isWindows = process.platform === 'win32';

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// PID du programme qui écoute sur le port (ou null).
function pidOnPort(port) {
  if (isWindows) {
    for (const line of run('netstat -ano -p tcp').split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === 'TCP' && cols[3] === 'LISTENING' && cols[1].endsWith(`:${port}`)) return Number(cols[4]);
    }
    return null;
  }
  const out = run(`lsof -ti tcp:${port} -sTCP:LISTEN`).trim();
  return out ? Number(out.split('\n')[0]) : null;
}

function commandLine(pid) {
  if (isWindows) {
    return run(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`).trim();
  }
  return run(`ps -o command= -p ${pid}`).trim();
}

function kill(pid) {
  if (isWindows) run(`taskkill /PID ${pid} /F`);
  else run(`kill ${pid}`);
}

const done = new Set();
for (const port of PORTS) {
  const pid = pidOnPort(port);
  if (!pid || pid === process.pid) continue;
  if (done.has(pid)) continue;
  const cmd = commandLine(pid);
  if (/node/i.test(cmd) && /server\.js/.test(cmd)) {
    kill(pid);
    done.add(pid);
    console.log(`Ancien serveur SweetLab arrêté (port ${port}, processus ${pid}).`);
  } else {
    console.log(`Attention : le port ${port} est utilisé par un autre programme (processus ${pid}) : ${cmd || 'inconnu'}`);
  }
}

// Laisse le temps au système de libérer les ports.
if (done.size) {
  const until = Date.now() + 1500;
  while (Date.now() < until && PORTS.some((p) => pidOnPort(p))) { /* attente courte */ }
}
