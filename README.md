# ABR-TrackLoad Launcher

## Índice

* Visão Geral
* Características principais
* Pré-requisitos
* Instalação e configuração
* Como usar
* Menu de opções
* Funcionalidades detalhadas
* Solução de problemas
* Estrutura técnica
* Timeouts configuráveis
* Notas importantes

---

## Visão Geral

O ABR-TrackLoad Launcher é uma ferramenta de linha de comando em Node.js para gerenciar os serviços backend e frontend do sistema ABR-TrackLoad. Permite iniciar, parar, reiniciar e monitorar os serviços de forma centralizada, garantindo encerramento completo de processos e liberação de portas.

---

## Características principais

* Gerenciamento unificado de backend e frontend
* Encerramento completo de processos (kill em árvore)
* Monitoramento de CPU e memória por PID
* Verificação e liberação automática de portas antes de iniciar serviços
* Menu interativo simples
* Reinício completo com feedback visual

---

## Pré-requisitos

* Node.js v14+
* npm (incluído com Node.js)
* Projeto ABR-TrackLoad nas pastas:

  * Backend: `C:\Users\supor\Documents\projetos\ABR-TrackLoad\backend`
  * Frontend: `C:\Users\supor\Documents\projetos\ABR-TrackLoad\frontend`

---

## Instalação e configuração

### 1. Configurar caminhos e portas

No topo de `launcher.js`, ajuste para seus caminhos (já sugeridos):

```javascript
const BACKEND_DIR = "C:\\Users\\supor\\Documents\\projetos\\ABR-TrackLoad\\backend";
const FRONTEND_DIR = "C:\\Users\\supor\\Documents\\projetos\\ABR-TrackLoad\\frontend";
const BACKEND_PORT = 5050;
const FRONTEND_PORT = 5173;
```

### 2. Dependência opcional (melhor medição de CPU)

Instale `pidusage` se quiser métricas de CPU mais precisas (opcional):

```bash
npm install pidusage
```

### 3. Executar

No diretório onde está `launcher.js`:

```bash
node launcher.js
```

Recomenda-se abrir o CMD como Administrador para garantir que comandos de kill funcionem em serviços do sistema.

---

## Como usar

### Inicialização

Ao executar o launcher:

* Verifica as portas (5050 backend, 5173 frontend)
* Lista processos conflitantes e propõe ações (matar / manter / sair)
* Exibe o menu principal

### Fluxos comuns

* Primeira execução: escolha **Iniciar Ambos** (opção 3)
* Desenvolvimento: use **Iniciar Backend** (1) ou **Iniciar Frontend** (2) conforme necessidade
* Reiniciar serviços: use **Reiniciar Servidor** (7)
* Sair: use **Sair** (9) e escolha se deseja matar processos remanescentes

---

## Menu de opções (visual de exemplo)

```
==== ABR-TrackLoad Launcher ====

[Backend] ativo  PID:1234
  CPU: 2.5%   RAM: 45.3 MB

[Frontend] ativo  PID:5678
  CPU: 1.2%   RAM: 23.1 MB

[Sistema] RAM: 4.2 GB / 8.0 GB

[Opções]
[1] Iniciar Backend
[2] Iniciar Frontend
[3] Iniciar Ambos
[4] Parar Backend
[5] Parar Frontend
[6] Parar Ambos
[7] Reiniciar Servidor
[8] Refresh
[9] Sair
```

---

## Funcionalidades detalhadas

### Iniciar Backend (opção 1)

* Verifica se a porta `BACKEND_PORT` (5050) está ocupada
* Mata processos conflitantes (kill em árvore) se solicitado
* Executa `node server.js` no diretório do backend
* Aguarda binding da porta e atualiza status

### Iniciar Frontend (opção 2)

* Verifica se a porta `FRONTEND_PORT` (5173) está ocupada
* Mata processos Vite/Node conflitantes se solicitado
* Executa `npm run dev` no diretório do frontend
* Monitora inicialização do servidor de desenvolvimento

### Parada de serviços (opções 4, 5, 6)

* Envia sinal de término (gentil)
* Se necessário, realiza `taskkill /T /F` (Windows) ou `SIGKILL` (Unix) para matar árvore de processos
* Verifica liberação da porta

### Reinicialização (opção 7)

* Mata processos nas portas e eventuais processos iniciados pelo launcher
* Inicia backend e frontend do zero
* Mostra spinner/status enquanto reinicia

### Refresh (opção 8)

* Atualiza imediatamente o status exibido (PID, CPU, RAM, portas)

### Sair (opção 9)

* Pergunta se deve matar processos nas portas antes de encerrar o launcher
* Se confirmar, mata todos os processos detectados nas portas e encerra o launcher

---

## Solução de problemas

### Portas ocupadas

Comando útil:

```bash
netstat -ano | findstr :5050
```

Se a porta estiver ocupada, o launcher oferece:

* `k` — matar processos e continuar
* `m` — manter processos (não iniciar novo)
* `e` — encerrar o launcher

### Processos que não morrem

O launcher aplica:

* kill por PID (`taskkill /T /F` no Windows)
* kill por nome / busca por command line (wmic / ps)
* tentativas múltiplas com rechecagens
  Se persistir, execute o CMD como Administrador e reinsira o comando de diagnóstico acima.

### Diagnóstico adicional (se necessário)

Cole as saídas desses comandos ao pedir suporte:

```bash
netstat -ano | findstr :5050
tasklist /FI "PID eq <PID>"
wmic process where "ProcessId=<PID>" get CommandLine
```

---

## Estrutura técnica

Arquitetura (resumida):

```
launcher.js
├── Configurações (portas, diretórios)
├── Gerenciamento de Processos
│   ├── spawn() para execução
│   ├── killPidTree() para encerramento
│   └── waitForPortFree() para verificação
├── Monitoramento
│   ├── getStatsForPid() para métricas
│   └── renderStatus() para display
└── Interface
    ├── Menu interativo
    └── Fluxos de operação
```

Comandos do sistema usados:

* Windows: `taskkill`, `netstat`, `wmic`, `powershell` (quando aplicável)
* Unix: `pkill`, `lsof`, `ss`, `ps`

---

## Timeouts configuráveis

Ajuste no topo do `launcher.js` conforme sua necessidade:

```javascript
const WAIT_AFTER_KILL_MS = 1500;    // Espera após matar processo
const WAIT_AFTER_START_MS = 1200;   // Espera após iniciar
const GRACEFUL_WAIT_MS = 2000;      // Tempo para shutdown gracioso
const MAX_KILL_ATTEMPTS = 5;        // Tentativas de kill
```

---

## Notas importantes

* O launcher roda no contexto do usuário atual; para matar serviços do sistema execute o CMD como Administrador.
* O launcher evita abrir janelas adicionais (`windowsHide: true`).
* Recomenda-se usar portas pouco comuns (ex.: 5050) para reduzir conflitos.
* Instale `pidusage` se precisar de leituras de CPU por PID mais precisas.

---

Fim.
