const { spawn, spawnSync, execSync } = require('child_process');
const readline = require('readline');
const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = "C:\\Users\\supor\\Documents\\projetos\\INTRANET\\backend";
const FRONTEND_DIR = "C:\\Users\\supor\\Documents\\projetos\\INTRANET\\frontend";
const BACKEND_PORT = 5052;
const FRONTEND_PORT = 5175;

const WAIT_AFTER_KILL_MS = 1500;
const WAIT_AFTER_START_MS = 1200;
const GRACEFUL_WAIT_MS = 2000;
const RESTART_SPINNER_INTERVAL_MS = 100;
const MAX_KILL_ATTEMPTS = 5;
const BACKEND_STABILITY_WAIT_MS = 4000;

let backendProc = null;
let frontendProc = null;
let rl = null;

function question(promptText = '') {
    return new Promise(resolve => rl.question(promptText, ans => resolve(String(ans || '').trim())));
}

function safePid(proc) {
    try { return proc && proc.pid ? proc.pid : null; } catch { return null; }
}

function fmtBytes(bytes) {
    if (!bytes) return '0.0 MB';
    const mb = bytes / 1024 / 1024;
    if (mb < 1) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${mb.toFixed(1)} MB`;
}

function killProcessByName(processNames) {
    if (!Array.isArray(processNames)) processNames = [processNames];
    try {
        if (process.platform === 'win32') {
            for (const name of processNames) {
                try {
                    execSync(`taskkill /IM "${name}" /T /F`, {
                        stdio: ['ignore', 'ignore', 'ignore'],
                        timeout: 5000
                    });
                } catch (_) { }
            }
        } else {
            for (const name of processNames) {
                try {
                    execSync(`pkill -f "${name}"`, {
                        stdio: ['ignore', 'ignore', 'ignore'],
                        timeout: 5000
                    });
                    execSync(`pkill -9 -f "${name}"`, {
                        stdio: ['ignore', 'ignore', 'ignore'],
                        timeout: 5000
                    });
                } catch (_) { }
            }
        }
        return true;
    } catch (_) {
        return false;
    }
}

function getPidsListeningOnPort(port) {
    const platform = process.platform;
    const pids = new Set();

    try {
        if (platform === 'win32') {
            const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf8' });
            const lines = out.split(/\r?\n/);

            for (let line of lines) {
                if (!line.includes('LISTENING')) continue;
                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[parts.length - 1], 10);
                if (!isNaN(pid)) pids.add(pid);
            }
        } else {
            try {
                const out = execSync(`lsof -ti:${port}`, { encoding: 'utf8' });
                out.split(/\r?\n/).forEach(pidStr => {
                    const pid = parseInt(pidStr, 10);
                    if (!isNaN(pid)) pids.add(pid);
                });
            } catch (_) {
                try {
                    const out2 = execSync(`ss -ltnp sport = :${port}`, { encoding: 'utf8' });
                    const pidMatches = out2.match(/pid=(\d+)/g);
                    if (pidMatches) {
                        pidMatches.forEach(m => pids.add(parseInt(m.replace('pid=', ''), 10)));
                    }
                } catch (_) { }
            }
        }
    } catch (_) { }

    return Array.from(pids);
}

function isPidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function killPidTree(pid) {
    if (!pid) return false;

    try {
        if (process.platform === 'win32') {
            try {
                execSync(`taskkill /PID ${pid} /T /F`, {
                    stdio: ['ignore', 'ignore', 'ignore'],
                    timeout: 3000
                });
            } catch (_) { }

            try {
                execSync(`taskkill /PID ${pid} /F`, {
                    stdio: ['ignore', 'ignore', 'ignore'],
                    timeout: 2000
                });
            } catch (_) { }
        } else {
            try {
                process.kill(pid, 'SIGTERM');
                setTimeout(() => {
                    try { process.kill(pid, 'SIGKILL'); } catch (_) { }
                }, 1000);
            } catch (_) {
                try {
                    execSync(`pkill -P ${pid}`, { stdio: 'ignore' });
                    execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
                } catch (_) { }
            }
        }
        return true;
    } catch (_) {
        return false;
    }
}

async function killAllOnPort(port) {
    let attempts = 0;
    const killed = new Set();

    while (attempts < MAX_KILL_ATTEMPTS) {
        const pids = getPidsListeningOnPort(port);
        if (pids.length === 0) return Array.from(killed);

        for (const pid of pids) {
            if (!killed.has(pid)) {
                killPidTree(pid);
                killed.add(pid);
            }
        }

        attempts++;
        await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));

        const rem = getPidsListeningOnPort(port);
        if (rem.length === 0) break;
    }

    return Array.from(killed);
}

async function waitForPortFree(port, timeoutMs = 8000, interval = 500) {
    const start = Date.now();
    let attempts = 0;

    while (Date.now() - start < timeoutMs && attempts < MAX_KILL_ATTEMPTS) {
        const pids = getPidsListeningOnPort(port);
        if (pids.length === 0) return true;

        for (const pid of pids) killPidTree(pid);
        attempts++;
        await new Promise(r => setTimeout(r, interval));
    }

    return getPidsListeningOnPort(port).length === 0;
}

/* =========================
   BACKEND HELPERS
   ========================= */

function readBackendPackageJson() {
    try {
        const pkgPath = path.join(BACKEND_DIR, 'package.json');
        if (!fs.existsSync(pkgPath)) return null;
        return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
        console.error('[BACKEND] Erro ao ler package.json:', e && e.message ? e.message : e);
        return null;
    }
}

function backendFileExists(fileName) {
    try {
        return fs.existsSync(path.join(BACKEND_DIR, fileName));
    } catch (_) {
        return false;
    }
}

function getBackendStartOptions() {
    const pkg = readBackendPackageJson();
    const scripts = pkg && pkg.scripts ? pkg.scripts : {};
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

    const options = [];

    if (scripts.start) {
        options.push({
            label: 'npm run start',
            cmd: npmCmd,
            args: ['run', 'start']
        });
    }

    if (scripts.dev) {
        options.push({
            label: 'npm run dev',
            cmd: npmCmd,
            args: ['run', 'dev']
        });
    }

    if (backendFileExists('server.js')) {
        options.push({
            label: 'node server.js',
            cmd: 'node',
            args: ['server.js']
        });
    }

    if (backendFileExists('index.js')) {
        options.push({
            label: 'node index.js',
            cmd: 'node',
            args: ['index.js']
        });
    }

    if (backendFileExists('app.js')) {
        options.push({
            label: 'node app.js',
            cmd: 'node',
            args: ['app.js']
        });
    }

    const seen = new Set();
    return options.filter(opt => {
        const key = `${opt.cmd}|${opt.args.join(' ')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function attachBackendListeners(proc, label) {
    if (!proc) return;

    proc.on('error', (err) => {
        console.error(`[BACKEND:${label}] erro ao iniciar:`, err && err.message ? err.message : err);
    });

    if (proc.stdout) {
        proc.stdout.on('data', (data) => {
            const out = data.toString().trim();
            if (out) console.log(`[BACKEND:${label}] ${out}`);
        });
    }

    if (proc.stderr) {
        proc.stderr.on('data', (data) => {
            const out = data.toString().trim();
            if (out) console.error(`[BACKEND-ERROR:${label}] ${out}`);
        });
    }
}

async function waitBackendUp(proc, port, waitMs = BACKEND_STABILITY_WAIT_MS) {
    const start = Date.now();

    while (Date.now() - start < waitMs) {
        if (!proc || !proc.pid) return false;

        const portPids = getPidsListeningOnPort(port);
        if (portPids.includes(proc.pid) || portPids.length > 0) {
            return true;
        }

        if (!isPidAlive(proc.pid)) {
            return false;
        }

        await new Promise(r => setTimeout(r, 250));
    }

    if (proc && proc.pid && isPidAlive(proc.pid)) return true;
    return false;
}

async function tryStartBackendOption(option) {
    let proc = null;

    try {
        proc = spawn(option.cmd, option.args, {
            cwd: BACKEND_DIR,
            windowsHide: true,
            shell: false,
            detached: false,
            env: { ...process.env }
        });
    } catch (e) {
        return {
            ok: false,
            reason: e && e.message ? e.message : String(e),
            proc: null
        };
    }

    attachBackendListeners(proc, option.label);

    const ok = await waitBackendUp(proc, BACKEND_PORT, BACKEND_STABILITY_WAIT_MS);

    if (!ok) {
        try { if (proc.pid) killPidTree(proc.pid); } catch (_) { }
        return {
            ok: false,
            reason: 'processo não ficou ativo',
            proc: null
        };
    }

    return {
        ok: true,
        proc
    };
}

/* =========================
   START / STOP BACKEND
   ========================= */

async function startBackendForce() {
    await killAllOnPort(BACKEND_PORT);
    await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));

    const remainingPids = getPidsListeningOnPort(BACKEND_PORT);
    if (remainingPids.length > 0) {
        await killAllOnPort(BACKEND_PORT);
    }

    const options = getBackendStartOptions();

    if (!options.length) {
        console.error('[BACKEND] Nenhuma opção encontrada para iniciar o backend.');
        console.error('[BACKEND] Verifique se existe package.json com scripts ou arquivos como server.js/index.js/app.js.');
        backendProc = null;
        return;
    }

    for (const option of options) {
        console.log(`[BACKEND] Tentando iniciar com: ${option.label}`);

        const result = await tryStartBackendOption(option);

        if (result.ok) {
            backendProc = result.proc;

            backendProc.on('exit', (code, signal) => {
                console.log(`[BACKEND] processo encerrado. code=${code} signal=${signal}`);
                backendProc = null;
            });

            console.log(`[BACKEND] iniciado com sucesso usando: ${option.label}`);
            await new Promise(r => setTimeout(r, WAIT_AFTER_START_MS));
            return;
        }

        console.error(`[BACKEND] Falhou em ${option.label}: ${result.reason}`);
    }

    console.error('[BACKEND] Não foi possível iniciar o backend com nenhuma estratégia.');
    backendProc = null;
}

/* =========================
   START / STOP FRONTEND
   ========================= */

async function startFrontendForce() {
    await killAllOnPort(FRONTEND_PORT);
    await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));

    const remainingPids = getPidsListeningOnPort(FRONTEND_PORT);
    if (remainingPids.length > 0) await killAllOnPort(FRONTEND_PORT);

    try {
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const distPath = path.join(FRONTEND_DIR, 'dist');

        if (!fs.existsSync(distPath)) {
            console.log('[FRONTEND] dist não encontrado — executando npm run build...');
            const res = spawnSync(npmCmd, ['run', 'build'], {
                cwd: FRONTEND_DIR,
                stdio: 'inherit',
                shell: false,
                timeout: 20 * 60 * 1000,
                env: { ...process.env, NODE_ENV: 'production' }
            });

            if (res.status !== 0) {
                console.error('[FRONTEND] build falhou — abortando start do preview.');
                frontendProc = null;
                return;
            }
        } else {
            console.log('[FRONTEND] dist encontrado — executando build para garantir consistência...');
            const res2 = spawnSync(npmCmd, ['run', 'build'], {
                cwd: FRONTEND_DIR,
                stdio: 'inherit',
                shell: false,
                timeout: 20 * 60 * 1000,
                env: { ...process.env, NODE_ENV: 'production' }
            });

            if (res2.status !== 0) {
                console.error('[FRONTEND] build falhou (regeneração) — abortando.');
                frontendProc = null;
                return;
            }
        }

        try {
            const indexPath = path.join(distPath, 'index.html');
            const indexHtml = fs.readFileSync(indexPath, 'utf8');
            const devTokens = ['/@vite/client', '@react-refresh', '/src/main'];
            const found = devTokens.filter(t => indexHtml.includes(t));

            if (found.length) {
                console.error('[FRONTEND] ERRO: o index.html gerado contém referências de desenvolvimento:', found.join(', '));
                console.error('[FRONTEND] Isso causa 404s (/@vite/client, /src/main.jsx). Verifique o build do Vite.');
                frontendProc = null;
                return;
            }
        } catch (e) {
            console.error('[FRONTEND] Não foi possível validar dist/index.html:', e && e.message ? e.message : e);
        }

        frontendProc = spawn(npmCmd, ['run', 'preview', '--', '--port', String(FRONTEND_PORT)], {
            cwd: FRONTEND_DIR,
            windowsHide: true,
            shell: false,
            detached: false,
            env: { ...process.env, NODE_ENV: 'production' }
        });
    } catch (e) {
        console.error('[FRONTEND] falha ao iniciar:', e && e.message ? e.message : e);
        frontendProc = null;
        return;
    }

    frontendProc.on('error', err => {
        frontendProc = null;
        console.error('[FRONTEND] erro ao iniciar:', err && err.message ? err.message : err);
    });

    frontendProc.on('exit', (code, signal) => {
        console.log(`[FRONTEND] processo encerrado. code=${code} signal=${signal}`);
        frontendProc = null;
    });

    if (frontendProc.stdout) {
        frontendProc.stdout.on('data', (data) => {
            const out = data.toString().trim();
            if (out) console.log(`[FRONTEND] ${out}`);
        });
    }

    if (frontendProc.stderr) {
        frontendProc.stderr.on('data', (data) => {
            console.error(`[FRONTEND-ERROR] ${data.toString().trim()}`);
        });
    }

    await new Promise(r => setTimeout(r, WAIT_AFTER_START_MS));
}

/* =========================
   STOP HELPERS
   ========================= */

async function stopSpawned(procName) {
    const port = procName === 'backend' ? BACKEND_PORT : FRONTEND_PORT;
    const proc = procName === 'backend' ? backendProc : frontendProc;

    if (proc && proc.pid) {
        try {
            proc.kill('SIGTERM');
            await new Promise(r => setTimeout(r, GRACEFUL_WAIT_MS));

            if (isPidAlive(proc.pid)) {
                killPidTree(proc.pid);
            }
        } catch (_) {
            try { killPidTree(proc.pid); } catch (_) { }
        }
    }

    await killAllOnPort(port);
    await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));

    if (procName === 'backend') backendProc = null;
    else frontendProc = null;
}

/* =========================
   STATUS / MENU
   ========================= */

async function getStatsForPid(pid) {
    if (!pid) return { cpu: 0, memory: 0 };

    try {
        const pidusage = require('pidusage');
        const s = await pidusage(pid);
        return { cpu: s.cpu || 0, memory: s.memory || 0 };
    } catch (_) {
        try {
            if (process.platform === 'win32') {
                const out = execSync(`tasklist /FI "PID eq ${pid}" /FO LIST`, { encoding: 'utf8' });
                const m = out.match(/Mem Usage:\s*([\d,]+)\sK/i);
                const mem = m ? parseInt(m[1].replace(/,/g, ''), 10) * 1024 : 0;
                return { cpu: 0, memory: mem };
            } else {
                const out = execSync(`ps -p ${pid} -o %cpu=,rss=`, { encoding: 'utf8' }).trim();
                const parts = out.split(/\s+/);
                const cpu = parseFloat(parts[0]) || 0;
                const mem = (parseFloat(parts[1]) || 0) * 1024;
                return { cpu, memory: mem };
            }
        } catch (_) {
            return { cpu: 0, memory: 0 };
        }
    }
}

async function aggregateStatsForPids(pids) {
    let totalCpu = 0;
    let totalMem = 0;

    for (const pid of pids) {
        try {
            const s = await getStatsForPid(pid);
            totalCpu += (s.cpu || 0);
            totalMem += (s.memory || 0);
        } catch (_) { }
    }

    return { cpu: totalCpu, memory: totalMem };
}

async function renderStatus() {
    console.clear();
    console.log('==== ABR-INTRANET ====\n');

    const backPid = safePid(backendProc);
    const frontPid = safePid(frontendProc);

    const externalBackPids = getPidsListeningOnPort(BACKEND_PORT).filter(p => p !== backPid);
    const externalFrontPids = getPidsListeningOnPort(FRONTEND_PORT).filter(p => p !== frontPid);

    let backStats = { cpu: 0, memory: 0 };
    let frontStats = { cpu: 0, memory: 0 };

    if (backPid) backStats = await getStatsForPid(backPid);
    else if (externalBackPids.length) backStats = await aggregateStatsForPids(externalBackPids);

    if (frontPid) frontStats = await getStatsForPid(frontPid);
    else if (externalFrontPids.length) frontStats = await aggregateStatsForPids(externalFrontPids);

    if (backPid) console.log(`[Backend] 🟢 ativo  PID:${backPid}`);
    else if (externalBackPids.length) console.log(`[Backend] 🟠 ativo (externo)  PIDs:${externalBackPids.join(', ')}`);
    else console.log(`[Backend] 🔴 parado  PID:-`);
    console.log(`  CPU: ${backStats.cpu ? backStats.cpu.toFixed(1) + '%' : '0.0%'}   RAM: ${fmtBytes(backStats.memory)}`);

    if (frontPid) console.log(`\n[Frontend] 🟢 ativo  PID:${frontPid}`);
    else if (externalFrontPids.length) console.log(`\n[Frontend] 🟠 ativo (externo)  PIDs:${externalFrontPids.join(', ')}`);
    else console.log(`\n[Frontend] 🔴 parado  PID:-`);
    console.log(`  CPU: ${frontStats.cpu ? frontStats.cpu.toFixed(1) + '%' : '0.0%'}   RAM: ${fmtBytes(frontStats.memory)}`);

    const total = os.totalmem();
    const used = total - os.freemem();
    console.log(`\n[Sistema] RAM: ${fmtBytes(used)} / ${fmtBytes(total)}\n`);
}

async function initialPortCheck() {
    console.clear();
    console.log('==== Checando portas (inicial) ====\n');

    const backPids = getPidsListeningOnPort(BACKEND_PORT);
    const frontPids = getPidsListeningOnPort(FRONTEND_PORT);

    console.log(backPids.length ? `Backend ${BACKEND_PORT}: OCUPADA (PIDs: ${backPids.join(', ')})` : `Backend ${BACKEND_PORT}: LIVRE`);
    console.log(frontPids.length ? `Frontend ${FRONTEND_PORT}: OCUPADA (PIDs: ${frontPids.join(', ')})` : `Frontend ${FRONTEND_PORT}: LIVRE`);
    console.log('');

    if (!backPids.length && !frontPids.length) {
        await question('Nenhuma porta ocupada. Pressione Enter para abrir o menu...');
        return;
    }

    if (backPids.length) {
        console.log(`Backend porta ${BACKEND_PORT} PIDs: ${backPids.join(', ')}`);
        let opt = (await question('Ação para Backend: (k) matar todos, (m) manter, (e) encerrar launcher? [k/m/e]: ')).toLowerCase();

        while (!['k', 'm', 'e', ''].includes(opt)) {
            opt = (await question('Digite k/m/e: ')).toLowerCase();
        }

        if (opt === 'k') {
            for (const pid of backPids) killPidTree(pid);
            await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));
        } else if (opt === 'e') {
            process.exit(0);
        }
    }

    if (frontPids.length) {
        console.log(`Frontend porta ${FRONTEND_PORT} PIDs: ${frontPids.join(', ')}`);
        let opt = (await question('Ação para Frontend: (k) matar todos, (m) manter, (e) encerrar launcher? [k/m/e]: ')).toLowerCase();

        while (!['k', 'm', 'e', ''].includes(opt)) {
            opt = (await question('Digite k/m/e: ')).toLowerCase();
        }

        if (opt === 'k') {
            for (const pid of frontPids) killPidTree(pid);
            await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));
        } else if (opt === 'e') {
            process.exit(0);
        }
    }

    console.log('\nOperação concluída. Pressione Enter para abrir o menu.');
    await question('');
}

async function ensureStartBackendFlow() {
    const pids = getPidsListeningOnPort(BACKEND_PORT);

    if (pids.length) {
        console.log(`Porta ${BACKEND_PORT} ocupada por: ${pids.join(', ')}`);
        let opt = (await question('Ação: (k) matar tudo e iniciar, (m) manter, (c) cancelar? [k/m/c]: ')).toLowerCase();

        while (!['k', 'm', 'c', ''].includes(opt)) {
            opt = (await question('Digite k/m/c: ')).toLowerCase();
        }

        if (opt === 'k') {
            await killAllOnPort(BACKEND_PORT);
            await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));
            await startBackendForce();
        }
    } else {
        await startBackendForce();
    }
}

async function ensureStartFrontendFlow() {
    const pids = getPidsListeningOnPort(FRONTEND_PORT);

    if (pids.length) {
        console.log(`Porta ${FRONTEND_PORT} ocupada por: ${pids.join(', ')}`);
        let opt = (await question('Ação: (k) matar tudo e iniciar, (m) manter, (c) cancelar? [k/m/c]: ')).toLowerCase();

        while (!['k', 'm', 'c', ''].includes(opt)) {
            opt = (await question('Digite k/m/c: ')).toLowerCase();
        }

        if (opt === 'k') {
            await killAllOnPort(FRONTEND_PORT);
            await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));
            await startFrontendForce();
        }
    } else {
        await startFrontendForce();
    }
}

async function restartServerFlow() {
    console.clear();
    const spinner = ['|', '/', '-', '\\'];
    let si = 0;

    const spinnerT = setInterval(() => {
        process.stdout.write('\r' + spinner[si % spinner.length] + ' reiniciando...');
        si++;
    }, RESTART_SPINNER_INTERVAL_MS);

    try {
        await stopSpawned('backend');
        await stopSpawned('frontend');
        await killAllOnPort(BACKEND_PORT);
        await killAllOnPort(FRONTEND_PORT);

        killProcessByName(['node.exe', 'node', 'server.js', 'vite', 'npm.exe', 'npm']);
        await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));

        await startBackendForce();
        await startFrontendForce();
        await new Promise(r => setTimeout(r, WAIT_AFTER_START_MS));
    } catch (_) {
    } finally {
        clearInterval(spinnerT);
        process.stdout.write('\r');
        console.log('Reinício concluído. Pressione Enter para voltar ao menu.');
        await question('');
    }
}

async function exitFlow() {
    if (backendProc) await stopSpawned('backend');
    if (frontendProc) await stopSpawned('frontend');

    await killAllOnPort(BACKEND_PORT);
    await killAllOnPort(FRONTEND_PORT);
    killProcessByName(['node.exe', 'node', 'server.js', 'vite', 'npm.exe', 'npm']);
    await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));

    process.exit(0);
}

async function menuLoop() {
    while (true) {
        try {
            await renderStatus();

            console.log('[Opções]');
            console.log('[1] Iniciar Backend');
            console.log('[2] Iniciar Frontend');
            console.log('[3] Iniciar Ambos');
            console.log('[4] Parar Backend');
            console.log('[5] Parar Frontend');
            console.log('[6] Parar Ambos');
            console.log('[7] Reiniciar Servidor');
            console.log('[8] Refresh (atualiza agora)');
            console.log('[9] Sair\n');

            const choice = (await question('Escolha: ')).trim().toLowerCase();

            if (choice === '1') {
                await ensureStartBackendFlow();
            } else if (choice === '2') {
                await ensureStartFrontendFlow();
            } else if (choice === '3') {
                await ensureStartBackendFlow();
                await ensureStartFrontendFlow();
            } else if (choice === '4') {
                await stopSpawned('backend');
            } else if (choice === '5') {
                await stopSpawned('frontend');
            } else if (choice === '6') {
                await stopSpawned('frontend');
                await stopSpawned('backend');
            } else if (choice === '7') {
                await restartServerFlow();
            } else if (choice === '8') {
                continue;
            } else if (choice === '9') {
                await exitFlow();
                break;
            } else {
                console.log('Opção inválida.');
                await question('Pressione Enter para continuar...');
            }
        } catch (e) {
            console.error('Erro no menu:', e && e.stack ? e.stack : e);
            await question('Pressione Enter para continuar...');
        }
    }
}

(async function main() {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
        await initialPortCheck();
        await menuLoop();
    } catch (e) {
        console.error('Erro fatal:', e && e.stack ? e.stack : e);
        process.exit(1);
    }
})();