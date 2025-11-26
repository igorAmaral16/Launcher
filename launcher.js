const { spawn, spawnSync, execSync } = require('child_process');
const readline = require('readline');
const os = require('os');
const path = require('path');
const fs = require('fs');

const BACKEND_DIR = "C:\\Users\\supor\\Documents\\projetos\\ABR-TrackLoad\\backend";
const FRONTEND_DIR = "C:\\Users\\supor\\Documents\\projetos\\ABR-TrackLoad\\frontend";
const BACKEND_PORT = 5050;
const FRONTEND_PORT = 5173;

const WAIT_AFTER_KILL_MS = 1500;
const WAIT_AFTER_START_MS = 1200;
const GRACEFUL_WAIT_MS = 2000;
const RESTART_SPINNER_INTERVAL_MS = 100;
const MAX_KILL_ATTEMPTS = 5;

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
                    execSync(`taskkill /IM "${name}" /T /F`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
                } catch (e) { }
            }
        } else {
            for (const name of processNames) {
                try {
                    execSync(`pkill -f "${name}"`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
                    execSync(`pkill -9 -f "${name}"`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
                } catch (e) { }
            }
        }
        return true;
    } catch (e) {
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
            } catch (e) {
                try {
                    const out2 = execSync(`ss -ltnp sport = :${port}`, { encoding: 'utf8' });
                    const pidMatches = out2.match(/pid=(\d+)/g);
                    if (pidMatches) pidMatches.forEach(m => pids.add(parseInt(m.replace('pid=', ''), 10)));
                } catch (ee) { }
            }
        }
    } catch (e) { }
    return Array.from(pids);
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

function killPidTree(pid) {
    if (!pid) return false;
    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 3000 });
            try { execSync(`wmic process where "ParentProcessId=${pid}" delete`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 2000 }); } catch (e) { }
            execSync(`taskkill /PID ${pid} /F`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 2000 });
        } else {
            try { process.kill(pid, 'SIGTERM'); setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch (e) { } }, 1000); } catch (e) {
                try { execSync(`pkill -P ${pid}`, { stdio: 'ignore' }); execSync(`kill -9 ${pid}`, { stdio: 'ignore' }); } catch (ee) { }
            }
        }
        return true;
    } catch (e) { return false; }
}

async function killAllOnPort(port) {
    let attempts = 0;
    const killed = new Set();
    while (attempts < MAX_KILL_ATTEMPTS) {
        const pids = getPidsListeningOnPort(port);
        if (pids.length === 0) return Array.from(killed);
        for (const pid of pids) { if (!killed.has(pid)) { killPidTree(pid); killed.add(pid); } }
        attempts++;
        await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));
        const rem = getPidsListeningOnPort(port);
        if (rem.length === 0) break;
    }
    return Array.from(killed);
}

async function startBackendForce() {
    await killAllOnPort(BACKEND_PORT);
    await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));
    const remainingPids = getPidsListeningOnPort(BACKEND_PORT);
    if (remainingPids.length > 0) await killAllOnPort(BACKEND_PORT);

    try {
        backendProc = spawn('node', ['server.js'], { cwd: BACKEND_DIR, windowsHide: true, shell: false, detached: false });
    } catch (e) { backendProc = null; return; }

    backendProc.on('error', () => { backendProc = null; });
    backendProc.on('exit', () => { backendProc = null; });

    backendProc.stdout.on('data', (data) => {
        console.log(`[BACKEND] ${data.toString().trim()}`);
    });

    backendProc.stderr.on('data', (data) => {
        console.error(`[BACKEND-ERROR] ${data.toString().trim()}`);
    });

    await new Promise(r => setTimeout(r, WAIT_AFTER_START_MS));
}

async function startFrontendForce() {
    await killAllOnPort(FRONTEND_PORT);
    await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));
    const remainingPids = getPidsListeningOnPort(FRONTEND_PORT);
    if (remainingPids.length > 0) await killAllOnPort(FRONTEND_PORT);

    try {
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const distPath = path.join(FRONTEND_DIR, 'dist');

        // Se não existe dist, roda build com NODE_ENV=production
        if (!fs.existsSync(distPath)) {
            console.log('[FRONTEND] dist não encontrado — executando npm run build (aguarde)...');
            const res = spawnSync(npmCmd, ['run', 'build'], {
                cwd: FRONTEND_DIR,
                stdio: 'inherit',
                shell: false,
                timeout: 20 * 60 * 1000,
                env: { ...process.env, NODE_ENV: 'production' } // garante modo produção
            });
            if (res.status !== 0) {
                console.error('[FRONTEND] build falhou — abortando start do preview.');
                frontendProc = null;
                return;
            }
        } else {
            // mesmo se dist existir, tentamos limpar/regerar para garantir consistência
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

        // verificar se o index.html gerado contém strings de dev (sinal de build incorreto)
        try {
            const indexPath = path.join(distPath, 'index.html');
            const indexHtml = fs.readFileSync(indexPath, 'utf8');
            const devTokens = ['@vite/client', '@react-refresh', '/src/', 'vite-plugin-pwa', '@vite-plugin-pwa'];
            const found = devTokens.filter(t => indexHtml.includes(t));
            if (found.length) {
                console.error('[FRONTEND] ERRO: o index.html gerado contém referências de desenvolvimento:', found.join(', '));
                console.error('[FRONTEND] Isso causa 404s (/@vite/client, /src/main.jsx). Verifique o build do Vite.');
                frontendProc = null;
                return;
            }
        } catch (e) {
            console.error('[FRONTEND] Não foi possível validar dist/index.html:', e && e.message ? e.message : e);
            // seguir mesmo assim
        }

        // inicia vite preview
        frontendProc = spawn(npmCmd, ['run', 'preview', '--', '--port', String(FRONTEND_PORT)], {
            cwd: FRONTEND_DIR,
            windowsHide: true,
            shell: false,
            detached: false,
            env: { ...process.env, NODE_ENV: 'production' }
        });
    } catch (e) {
        frontendProc = null;
        return;
    }

    frontendProc.on('error', err => {
        frontendProc = null;
        console.error('[FRONTEND] erro ao iniciar:', err && err.message ? err.message : err);
    });

    frontendProc.on('exit', () => { frontendProc = null; });

    frontendProc.stdout.on('data', (data) => {
        const out = data.toString().trim();
        if (out) console.log(`[FRONTEND] ${out}`);
    });

    frontendProc.stderr.on('data', (data) => {
        console.error(`[FRONTEND-ERROR] ${data.toString().trim()}`);
    });

    await new Promise(r => setTimeout(r, WAIT_AFTER_START_MS));
}

async function stopSpawned(procName) {
    const port = procName === 'backend' ? BACKEND_PORT : FRONTEND_PORT;
    const proc = procName === 'backend' ? backendProc : frontendProc;

    if (proc && proc.pid) {
        try {
            proc.kill('SIGTERM');
            await new Promise(r => setTimeout(r, GRACEFUL_WAIT_MS));
            try { process.kill(proc.pid, 0); killPidTree(proc.pid); } catch (e) { }
        } catch (e) {
            killPidTree(proc.pid);
        }
    }

    await killAllOnPort(port);
    await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS));

    if (procName === 'backend') backendProc = null;
    else frontendProc = null;
}

async function renderStatus() {
    console.clear();
    console.log('==== ABR-TrackLoad Launcher ====\n');

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
        while (!['k', 'm', 'e', ''].includes(opt)) opt = (await question('Digite k/m/e: ')).toLowerCase();
        if (opt === 'k') { for (const pid of backPids) killPidTree(pid); await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS)); }
        else if (opt === 'e') process.exit(0);
    }

    if (frontPids.length) {
        console.log(`Frontend porta ${FRONTEND_PORT} PIDs: ${frontPids.join(', ')}`);
        let opt = (await question('Ação para Frontend: (k) matar todos, (m) manter, (e) encerrar launcher? [k/m/e]: ')).toLowerCase();
        while (!['k', 'm', 'e', ''].includes(opt)) opt = (await question('Digite k/m/e: ')).toLowerCase();
        if (opt === 'k') { for (const pid of frontPids) killPidTree(pid); await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS)); }
        else if (opt === 'e') process.exit(0);
    }

    console.log('\nOperação concluída. Pressione Enter para abrir o menu.');
    await question('');
}

async function ensureStartBackendFlow() {
    const pids = getPidsListeningOnPort(BACKEND_PORT);
    if (pids.length) {
        console.log(`Porta ${BACKEND_PORT} ocupada por: ${pids.join(', ')}`);
        let opt = (await question('Ação: (k) matar tudo e iniciar, (m) manter, (c) cancelar? [k/m/c]: ')).toLowerCase();
        while (!['k', 'm', 'c', ''].includes(opt)) opt = (await question('Digite k/m/c: ')).toLowerCase();
        if (opt === 'k') { await killAllOnPort(BACKEND_PORT); await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS)); await startBackendForce(); }
    } else { await startBackendForce(); }
}

async function ensureStartFrontendFlow() {
    const pids = getPidsListeningOnPort(FRONTEND_PORT);
    if (pids.length) {
        console.log(`Porta ${FRONTEND_PORT} ocupada por: ${pids.join(', ')}`);
        let opt = (await question('Ação: (k) matar tudo e iniciar, (m) manter, (c) cancelar? [k/m/c]: ')).toLowerCase();
        while (!['k', 'm', 'c', ''].includes(opt)) opt = (await question('Digite k/m/c: ')).toLowerCase();
        if (opt === 'k') { await killAllOnPort(FRONTEND_PORT); await new Promise(r => setTimeout(r, WAIT_AFTER_KILL_MS)); await startFrontendForce(); }
    } else { await startFrontendForce(); }
}

async function restartServerFlow() {
    console.clear();
    const spinner = ['|', '/', '-', '\\'];
    let si = 0;
    const spinnerT = setInterval(() => { process.stdout.write('\r' + spinner[si % spinner.length] + ' reiniciando...'); si++; }, RESTART_SPINNER_INTERVAL_MS);

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
    } catch (e) {
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

            if (choice === '1') await ensureStartBackendFlow();
            else if (choice === '2') await ensureStartFrontendFlow();
            else if (choice === '3') { await ensureStartBackendFlow(); await ensureStartFrontendFlow(); }
            else if (choice === '4') await stopSpawned('backend');
            else if (choice === '5') await stopSpawned('frontend');
            else if (choice === '6') { await stopSpawned('frontend'); await stopSpawned('backend'); }
            else if (choice === '7') await restartServerFlow();
            else if (choice === '8') continue;
            else if (choice === '9') { await exitFlow(); break; }
            else { console.log('Opção inválida.'); await question('Pressione Enter para continuar...'); }
        } catch (e) {
            console.error('Erro no menu:', e && e.stack ? e.stack : e);
            await question('Pressione Enter para continuar...');
        }
    }
}

async function getStatsForPid(pid) {
    if (!pid) return { cpu: 0, memory: 0 };
    try {
        const pidusage = require('pidusage');
        const s = await pidusage(pid);
        return { cpu: s.cpu || 0, memory: s.memory || 0 };
    } catch (e) {
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
        } catch (ee) {
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
        } catch (e) { }
    }
    return { cpu: totalCpu, memory: totalMem };
}

(async function main() {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        await initialPortCheck();
        await menuLoop();
    } catch (e) {
        console.error('Erro fatal:', e.stack || e);
        process.exit(1);
    }
})();
