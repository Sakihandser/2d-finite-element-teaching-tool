/*
  本地开发服务器。
  功能：
  1. 提供 index.html、CSS、前端脚本、材料文件等静态资源。
  2. 提供 /api/materials 读写接口，让浏览器页面可以把材料库保存回项目文件夹。
  3. 通过 /api/calculation-runs 使用二进制管道把结构化模型直接交给 C++ 核心并接收结果。
  4. 提供 /api/calculation-models 作为用户主动导出纯文本计算输入的兼容接口。
  5. 启动时同步生成 materials/materials.js，保证直接打开静态文件时也能读取内嵌材料库。

  这里没有使用 Express 等框架，而是采用 Node.js 内置 http 模块。
  算法思路是“路由分发 + 白名单式静态文件路径校验”：先判断是否命中材料 API，
  其余请求再映射到项目目录下的安全文件路径，防止 ../ 这类路径穿越访问项目外文件。
*/
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { encodeCalculationModelBinary, decodeCalculationResultBinary } = require("./calculation-ipc");

// 项目根目录、材料库文件位置，以及用户可选生成的计算 TXT 目录。
const ROOT = __dirname;
const MATERIALS_DIR = path.join(ROOT, "materials");
const MATERIALS_JSON = path.join(MATERIALS_DIR, "materials.json");
const MATERIALS_JS = path.join(MATERIALS_DIR, "materials.js");
const CALCULATION_DATA_DIR = path.join(ROOT, "calculation-data");
const CALCULATION_INPUT_TXT = path.join(CALCULATION_DATA_DIR, "calculation-input.txt");
const CALCULATION_RESULT_TXT = path.join(CALCULATION_DATA_DIR, "calculation-result.txt");
const CALCULATION_CORE_DIR = path.join(ROOT, "计算力学程序计算核心");
const CALCULATION_CORE_EXECUTABLE_CANDIDATES = [
  path.join(CALCULATION_CORE_DIR, "x64", "Release", "计算力学程序计算核心.exe"),
  path.join(CALCULATION_CORE_DIR, "Release", "计算力学程序计算核心.exe"),
  path.join(CALCULATION_CORE_DIR, "x64", "Debug", "计算力学程序计算核心.exe"),
  path.join(CALCULATION_CORE_DIR, "Debug", "计算力学程序计算核心.exe"),
];
const REQUEST_BODY_LIMIT_BYTES = 50_000_000;
const CALCULATION_RUN_TIMEOUT_MS = 120_000;
const ADAPTIVE_RUN_TIMEOUT_MS = 10_000;
const CALCULATION_BINARY_RESULT_LIMIT_BYTES = 100_000_000;
const LOCAL_HOST = "127.0.0.1";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
};

// 默认监听 5173；如果环境变量 PORT 存在，则优先使用外部指定端口。
const DEFAULT_PORT = Number(process.env.PORT) || 5173;
const SHOULD_OPEN_BROWSER = process.env.FEM_OPEN_BROWSER !== "0";
let lastCalculationBundle = null;

// 静态文件 MIME 类型映射。浏览器依赖这些类型正确解析 HTML/CSS/JS/JSON。
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// 启动前保证材料目录和材料 JSON 存在，并把 JSON 同步写成可被 <script> 加载的 JS 文件。
async function ensureMaterialFiles() {
  await fs.mkdir(MATERIALS_DIR, { recursive: true });
  await fs.mkdir(CALCULATION_DATA_DIR, { recursive: true });
  try {
    await fs.access(MATERIALS_JSON);
  } catch (error) {
    const emptyPayload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      materials: [],
    };
    await writeMaterialPayload(emptyPayload);
    return;
  }
  const payload = await readMaterialPayload();
  await writeMaterialScript(payload);
}

// 用户主动导出或开启“额外生成计算 TXT”时，覆盖写入兼容格式输入文件。
async function writeCalculationModelText(text) {
  await fs.mkdir(CALCULATION_DATA_DIR, { recursive: true });
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const content = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  await fs.writeFile(CALCULATION_INPUT_TXT, content, "utf8");
  return {
    ok: true,
    savedAt: new Date().toISOString(),
    directory: "calculation-data",
    filename: "calculation-input.txt",
    path: path.relative(ROOT, CALCULATION_INPUT_TXT).replace(/\\/g, "/"),
    bytes: Buffer.byteLength(content, "utf8"),
  };
}

// 查找已编译好的 C++ 计算核心。正式计算优先使用 Release，未编译时才回退到 Debug。
async function findCalculationCoreExecutable() {
  for (const candidate of CALCULATION_CORE_EXECUTABLE_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      // 继续尝试下一个候选路径。
    }
  }
  throw new Error("未找到已编译的 C++ 计算核心 exe，请先在 Visual Studio 中编译计算核心项目。");
}

// 通过 stdin/stdout 二进制管道运行 C++ 核心；TXT 只在用户明确开启时额外生成。
async function runCalculationCore(model, options = {}) {
  const executable = await findCalculationCoreExecutable();
  if (!model || !Array.isArray(model.nodes) || !Array.isArray(model.elements)) {
    throw new Error("计算请求缺少结构化节点或单元数据。");
  }
  const generateTextFiles = options.generateTextFiles === true;
  const adaptiveTimeoutMs = Number(options.timeLimitMs ?? ADAPTIVE_RUN_TIMEOUT_MS);
  if (options.adaptive === true && (!Number.isInteger(adaptiveTimeoutMs) || adaptiveTimeoutMs < 100 || adaptiveTimeoutMs > 2147483000)) {
    throw new Error("自适应单轮最长耗时必须为 0.1–2147483 秒。");
  }
  let inputFile = null;
  if (generateTextFiles) {
    if (!String(options.inputText || "").trim()) {
      throw new Error("已开启额外计算 TXT，但请求中没有可导出的输入文本。");
    }
    inputFile = await writeCalculationModelText(options.inputText);
    await fs.rm(CALCULATION_RESULT_TXT, { force: true });
  }

  const binaryInput = encodeCalculationModelBinary(model);
  let execution;
  try {
    execution = await executeCalculationCoreBinary(
      executable,
      binaryInput,
      generateTextFiles ? ["--binary-ipc", "--write-text"] : ["--binary-ipc"],
      options.useGpuAcceleration === true,
      options.adaptive === true ? adaptiveTimeoutMs : CALCULATION_RUN_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      ok: false,
      executable: path.relative(ROOT, executable).replace(/\\/g, "/"),
      stderr: error.stderr || error.message,
      exitCode: error.code ?? 1,
      timedOut: error.code === "ETIMEDOUT",
    };
  }

  if (execution.exitCode !== 0) {
    return {
      ok: false,
      executable: path.relative(ROOT, executable).replace(/\\/g, "/"),
      stderr: execution.stderr || `C++ 计算核心退出，代码 ${execution.exitCode}。`,
      exitCode: execution.exitCode,
    };
  }

  const ranAt = new Date().toISOString();
  let resultData;
  try {
    resultData = decodeCalculationResultBinary(execution.stdout, {
      modelName: model.modelName,
      generatedAt: ranAt,
      units: { displacement: model.units?.length || "model", strain: "1", stress: model.units?.elasticModulus || "Pa" },
    });
  } catch (error) {
    return {
      ok: false,
      executable: path.relative(ROOT, executable).replace(/\\/g, "/"),
      stderr: `${execution.stderr || ""}\n${error.message}`.trim(),
      exitCode: 1,
    };
  }

  const resultStats = generateTextFiles ? await fs.stat(CALCULATION_RESULT_TXT).catch(() => null) : null;
  if (generateTextFiles && !resultStats) {
    return {
      ok: false,
      executable: path.relative(ROOT, executable).replace(/\\/g, "/"),
      stderr: execution.stderr || "已请求生成 TXT，但 C++ 未生成 calculation-result.txt。",
      exitCode: 1,
    };
  }

  const response = {
    ok: true,
    ranAt,
    executable: path.relative(ROOT, executable).replace(/\\/g, "/"),
    transport: "binary-pipe",
    textFilesGenerated: generateTextFiles,
    input: generateTextFiles ? inputFile : { generated: false, transport: "binary-pipe", bytes: binaryInput.length },
    result: generateTextFiles
      ? {
          generated: true,
          directory: "calculation-data",
          filename: "calculation-result.txt",
          path: path.relative(ROOT, CALCULATION_RESULT_TXT).replace(/\\/g, "/"),
          bytes: resultStats.size,
        }
      : { generated: false, transport: "binary-pipe", bytes: execution.stdout.length },
    stderr: execution.stderr || "",
    resultData,
  };
  lastCalculationBundle = {
    ok: true,
    source: "binary-pipe-memory",
    input: response.input,
    result: response.result,
    inputData: model,
    resultData,
    ranAt,
  };
  return response;
}

function executeCalculationCoreBinary(executable, binaryInput, args, useGpuAcceleration = false, timeoutMs = CALCULATION_RUN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // Per-request selection overrides inherited environment without changing
      // process.env or affecting another simultaneous calculation request.
      env: { ...process.env, FEM_COMPUTE: useGpuAcceleration ? "gpu" : "cpu" },
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      const error = new Error(`C++ 计算超过 ${timeoutMs} ms，已终止。`);
      error.code = "ETIMEDOUT";
      error.stderr = Buffer.concat(stderrChunks).toString("utf8");
      finishReject(error);
    }, timeoutMs);

    child.on("error", finishReject);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > CALCULATION_BINARY_RESULT_LIMIT_BYTES) {
        child.kill();
        finishReject(new Error("C++ 二进制计算结果超过允许大小。"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finishReject(error);
    });
    child.stdin.end(binaryInput);
  });
}

// 优先返回本次二进制计算保存在内存中的结构化数据；没有本次结果时兼容读取旧 TXT。
async function readCalculationResultBundle() {
  if (lastCalculationBundle) {
    return lastCalculationBundle;
  }
  const [inputStats, resultStats] = await Promise.all([
    fs.stat(CALCULATION_INPUT_TXT).catch(() => null),
    fs.stat(CALCULATION_RESULT_TXT).catch(() => null),
  ]);
  if (!inputStats) {
    const error = new Error("未找到 calculation-data/calculation-input.txt。");
    error.statusCode = 404;
    throw error;
  }
  if (!resultStats) {
    const error = new Error("未找到 calculation-data/calculation-result.txt，请先完成计算。");
    error.statusCode = 404;
    throw error;
  }
  const [inputText, resultText] = await Promise.all([
    fs.readFile(CALCULATION_INPUT_TXT, "utf8"),
    fs.readFile(CALCULATION_RESULT_TXT, "utf8"),
  ]);
  return {
    ok: true,
    source: "api",
    input: {
      filename: "calculation-input.txt",
      path: path.relative(ROOT, CALCULATION_INPUT_TXT).replace(/\\/g, "/"),
      bytes: inputStats.size,
    },
    result: {
      filename: "calculation-result.txt",
      path: path.relative(ROOT, CALCULATION_RESULT_TXT).replace(/\\/g, "/"),
      bytes: resultStats.size,
    },
    inputText,
    resultText,
  };
}

// 读取材料 JSON 并进行一次归一化，避免手工编辑后的字段类型污染前端。
async function readMaterialPayload() {
  const text = await fs.readFile(MATERIALS_JSON, "utf8");
  const payload = JSON.parse(text);
  return normalizeMaterialPayload(payload);
}

// 写入材料 JSON；同一份规范化结果也同步生成 materials.js，保持两种读取方式一致。
async function writeMaterialPayload(payload) {
  const normalized = normalizeMaterialPayload(payload);
  await fs.writeFile(MATERIALS_JSON, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await writeMaterialScript(normalized);
  return normalized;
}

// 把材料 JSON 包装为 window.PROJECT_MATERIAL_LIBRARY，供没有 API 的静态打开方式兜底使用。
async function writeMaterialScript(payload) {
  const header = [
    "/*",
    "  自动生成的材料库镜像文件。",
    "  数据来源是 materials/materials.json；server.js 每次保存材料库时会重写本文件。",
    "  前端在无法访问 /api/materials 时，通过这个全局变量读取项目内置材料。",
    "*/",
    "",
  ].join("\n");
  await fs.writeFile(MATERIALS_JS, `${header}window.PROJECT_MATERIAL_LIBRARY = ${JSON.stringify(payload, null, 2)};\n`, "utf8");
}

// 材料载荷归一化算法：兼容数组或 { materials } 两种格式，并过滤掉没有名称的空记录。
function normalizeMaterialPayload(payload) {
  const materials = Array.isArray(payload) ? payload : Array.isArray(payload?.materials) ? payload.materials : [];
  return {
    version: 1,
    updatedAt: String(payload?.updatedAt || new Date().toISOString()),
    materials: materials.map(normalizeMaterial).filter((material) => material.name),
  };
}

// 单条材料记录归一化：字符串去空格，数值转 number/null，颜色限定为十六进制。
function normalizeMaterial(raw = {}, index = 0) {
  const now = new Date().toISOString();
  return {
    id: String(raw.id || `mat-${index + 1}`),
    name: String(raw.name || "").trim(),
    elasticModulus: nullableNumber(raw.elasticModulus),
    poissonRatio: nullableNumber(raw.poissonRatio),
    density: nullableNumber(raw.density),
    yieldStrength: nullableNumber(raw.yieldStrength),
    tensileStrength: nullableNumber(raw.tensileStrength),
    compressiveStrength: nullableNumber(raw.compressiveStrength),
    color: normalizeColor(raw.color),
    sourceUrl: String(raw.sourceUrl || "").trim(),
    sourceUrls: Array.isArray(raw.sourceUrls) ? raw.sourceUrls.map((url) => String(url).trim()).filter(Boolean) : [],
    notes: String(raw.notes || "").trim(),
    createdAt: String(raw.createdAt || now),
    updatedAt: String(raw.updatedAt || now),
  };
}

// 可空数值解析：允许空值保留为 null，非空值去掉逗号后转数字，并抑制浮点噪声。
function nullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? Math.round(number * 1000000) / 1000000 : null;
}

// 颜色字段校验：只接受 #RRGGBB，其余输入回退到默认青色。
function normalizeColor(color) {
  const value = String(color || "").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#007c89";
}

// 统一 JSON 响应格式，禁用缓存，让前端总能看到最新材料库。
function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendNoContent(response) {
  response.writeHead(204, CORS_HEADERS);
  response.end();
}

// 流式读取 POST 请求体；超过限制立即中断，避免异常大请求占用内存。
async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > REQUEST_BODY_LIMIT_BYTES) {
      throw new Error("请求体过大");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

// 将 URL 路径映射到项目内文件，并用 path.relative 检查是否越过 ROOT。
function safeFilePath(requestPath) {
  const pathname = decodeURIComponent(requestPath.split("?")[0]);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(ROOT, relativePath));
  const relativeFromRoot = path.relative(ROOT, filePath);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    return null;
  }
  return filePath;
}

// 静态资源服务：通过安全路径读取文件，并根据扩展名返回合适 Content-Type。
async function serveStatic(request, response) {
  const filePath = safeFilePath(request.url || "/");
  if (!filePath) {
    response.writeHead(403, { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(data);
  } catch (error) {
    response.writeHead(404, { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

// 路由分发入口：材料 API 优先处理，其余请求全部交给静态文件服务。
async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || "/", "http://localhost");
  if (request.method === "OPTIONS") {
    sendNoContent(response);
    return;
  }
  if (requestUrl.pathname === "/api/materials" && request.method === "GET") {
    const payload = await readMaterialPayload();
    sendJson(response, 200, payload);
    return;
  }
  if (requestUrl.pathname === "/api/materials" && request.method === "POST") {
    try {
      const body = await readRequestBody(request);
      const payload = await writeMaterialPayload(JSON.parse(body || "{}"));
      sendJson(response, 200, payload);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }
  if (requestUrl.pathname === "/api/materials") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (requestUrl.pathname === "/api/calculation-models" && request.method === "POST") {
    try {
      const body = await readRequestBody(request);
      const saved = await writeCalculationModelText(calculationTextFromRequestBody(body, request.headers["content-type"]));
      sendJson(response, 200, saved);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }
  if (requestUrl.pathname === "/api/calculation-models") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (requestUrl.pathname === "/api/calculation-runs" && request.method === "POST") {
    try {
      const body = await readRequestBody(request);
      const payload = JSON.parse(body || "{}");
      const result = await runCalculationCore(payload.model, {
        useGpuAcceleration: payload.useGpuAcceleration === true,
        adaptive: payload.adaptive === true,
        timeLimitMs: payload.timeLimitMs,
        generateTextFiles: payload.generateTextFiles === true,
        inputText: payload.inputText || "",
      });
      sendJson(response, result.ok ? 200 : 500, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (requestUrl.pathname === "/api/calculation-runs") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (requestUrl.pathname === "/api/calculation-results" && request.method === "GET") {
    try {
      sendJson(response, 200, await readCalculationResultBundle());
    } catch (error) {
      sendJson(response, error.statusCode || 500, { ok: false, error: error.message });
    }
    return;
  }
  if (requestUrl.pathname === "/api/calculation-results") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  await serveStatic(request, response);
}

function calculationTextFromRequestBody(body, contentType = "") {
  if (!String(contentType).toLowerCase().includes("application/json")) {
    return body;
  }
  const payload = JSON.parse(body || "{}");
  return String(payload?.content || payload?.text || "");
}

// 双击启动时自动打开浏览器。URL 必须等 listen 成功后再生成，才能拿到真实端口。
function openBrowser(url) {
  if (!SHOULD_OPEN_BROWSER) return;
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.env.ComSpec || "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = isWindows ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    console.warn(`浏览器自动打开失败，请手动访问：${url}`);
    console.warn(error.message);
  }
}

// 启动 HTTP 服务；如果端口被占用，最多向后尝试 20 个端口。
async function startServer(port) {
  await ensureMaterialFiles();
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < DEFAULT_PORT + 20) {
      startServer(port + 1);
      return;
    }
    throw error;
  });
  server.listen(port, LOCAL_HOST, () => {
    const url = `http://${LOCAL_HOST}:${port}/`;
    console.log(`二维有限元程序已启动：${url}`);
    console.log("材料库文件：materials/materials.json");
    console.log("计算模型数据目录：calculation-data");
    console.log(SHOULD_OPEN_BROWSER ? "浏览器会自动打开；如果没有弹出页面，请复制上面的地址访问。" : "已禁用自动打开浏览器；请复制上面的地址访问。");
    openBrowser(url);
  });
}

// 程序入口：从默认端口启动，启动失败时打印错误并退出。
if (require.main === module) startServer(DEFAULT_PORT).catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = { runCalculationCore, executeCalculationCoreBinary };
