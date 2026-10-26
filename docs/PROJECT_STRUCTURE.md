# 项目结构说明

更新时间：2026-10-08

## 当前状态

项目已经完成前置搭建：结构绘制页、计算页预留界面、材料库、本地材料读写服务器，以及前端代码拆分整理。

本次整理把原来集中在 `app.js` 和 `styles.css` 的代码拆成了“全局 -> 核心 -> 标签页 -> 页面内功能”的层级。根目录的 `app.js` 现在只负责启动、事件注册和对外 API，后续新增功能不要再把大段业务逻辑堆回入口文件。

## 启动和端口

- 推荐启动方式：双击 `计算力学程序.exe`，后台启动服务并打开独立浏览器应用窗口，关窗时结束本次服务。详见 `docs/WINDOWS_LAUNCHER.md`。
- 开发调试方式：双击 `start.bat`，或在项目根目录运行 `node server.js`。
- 默认端口：`5173`。
- 如果端口被占用，`server.js` 会自动向后尝试，最多尝试到 `5193`。
- 材料库读写接口：`/api/materials`。
- 直接计算接口：`POST /api/calculation-runs`，Node.js 与 C++ 之间使用二进制 stdin/stdout 管道。
- 计算结果接口：`GET /api/calculation-results`，优先返回本次内存中的结构化结果。
- 文本导出兼容接口：`/api/calculation-models`。
- 材料主数据文件：`materials/materials.json`。
- 静态兜底材料脚本：`materials/materials.js`。
- 计算输入/结果 TXT 默认不生成；用户开启“额外生成计算 TXT”后才写入 `calculation-data/`，格式说明见 `docs/CALCULATION_EXPORT_FORMAT.md`。
- 不推荐直接双击 `index.html`；本地 HTML 会受到浏览器文件访问限制，无法稳定自动运行 C++ 核心。

## 根目录文件

- `index.html`：页面结构、顶部标签页、绘图页、计算页、材料库页和脚本加载顺序。
- `styles.css`：样式入口，只通过 `@import` 引入拆分后的样式文件。
- `app.js`：应用入口，只保留 `wireEvents()`、启动初始化和 `window.femSketchApi`。
- `server.js`：本地 HTTP 服务、材料库读写 API、计算请求路由和 C++ 子进程管理。
- `calculation-ipc.js`：Node.js 端有限元模型二进制编码与结果解码。
- `计算力学程序.exe`：面向用户的 Windows 双击启动入口；源码及构建测试在 `windows-launcher/`。
- `start.bat`：Windows 本地服务启动脚本，会自动打开浏览器。
- `calculation-data/`：用户可选的计算 TXT 导出目录；不再参与默认求解数据传输。
- `计算力学程序计算核心/`：C++ 控制台计算核心，包含二进制管道、TXT 兼容接口、有限元求解。

## 前端代码目录

- `src/global/state.js`：全局 DOM 引用、颜色常量、材料配置、`scene`、视图状态、图层状态、交互状态。
- `src/global/i18n.js`：中文/英文界面切换、语言偏好、动态 DOM、弹窗和 Canvas 标签翻译。
- `src/core/numbers.js`：跨页面共用的数字格式化和范围限制工具。
- `src/core/material-utils.js`：材料数值、颜色和材料属性显示的共用工具。
- `src/core/viewports.js`：绘图页和计算页的 canvas 尺寸、坐标转换、网格步长。
- `src/core/tools.js`：结构绘制工具、载荷方向模式、体力作用范围模式、计算页工具按钮状态。
- `src/core/scene-objects.js`：对象 ID、几何节点、曲线、点载荷、分布力、体力、基础几何曲线函数。
- `src/core/regions.js`：闭合区域识别、边界交点几何节点同步、区域类型、区域材料快照、点在区域内判断。
- `src/core/analysis-classification.js`：计算节点和网格单元分类，给后续求解模块提供材料和边界归属。
- `src/core/analysis-node-placement.js`：根据结构区域、边界曲线、几何节点和载荷锚点自动布置计算节点，并生成后续网格划分可复用的边界分段和区域节点集。
- `src/core/analysis-mesh.js`：使用 `triangle-wasm`/Triangle 1.6 把结构面域的 PSLG 外轮廓、嵌套孔洞、约束边和内部计算节点剖分为 TRI3 单元；写回前校验约束边完整性和面积覆盖率，不再使用旧版裁剪与局部补洞算法。
- `src/vendor/triangle-wasm/`：本地浏览器运行时、Triangle WASM 二进制和第三方许可证说明；由本地服务以 `application/wasm` 提供。
- `src/core/calculation-export.js`：构造连续编号的求解模型，默认发起直接二进制计算，也保留计算 TXT 的主动导出。
- `src/core/scene-io.js`：清空、导出、导入和旧 JSON 数据兼容。
- `src/pages/tabs.js`：顶部标签页切换。
- `src/pages/drawing/*`：结构绘制页内部功能，包括绘制层、鼠标交互、右键材料菜单、命中测试、选择删除、视图适配、检查器和动画。
- `src/pages/calculation/*`：计算页预留显示、计算视图状态和计算页鼠标交互。
- `src/pages/materials/library.js`：材料库加载、保存、表单、颜色、列表和浏览器搜索。

## 样式目录

- `src/styles/global.css`：设计变量、基础盒模型、窗口和标签页基础样式。
- `src/styles/workspace.css`：绘图页和计算页共用的三栏工作台、工具栏、画布和检查器样式。
- `src/styles/materials.css`：材料库页面样式。
- `src/styles/responsive.css`：窄屏压缩规则。

## 重要全局变量

- `scene`：核心数据模型，保存 `geometryNodes`、`curves`、`regions`、`pointLoads`、`distributedLoads`、`bodyLoads`、`analysisNodes`、`analysisNodePlacement`、`mesh.elements` 和 `mesh.metadata`。
- `view`：结构绘制页坐标视图。
- `calculationView`：计算页独立坐标视图。
- `layers`：结构绘制页图层开关。
- `calculationLayers`：计算页图层开关。
- `materialLibrary`：当前材料库数组。
- `selected`、`hovered`、`interaction`、`draft`：绘图页选择、悬停和交互状态。
- `activeTool`、`activeCalculationTool`：当前绘图工具和计算页工具。

## 对外预留接口

`window.femSketchApi` 是后续自动布置节点、自动布置网格、计算核心接入的稳定入口。当前已经暴露：

- 场景读取：`getScene()`。
- 区域和材料查询：`getStructureRegionAtPoint()`、`getStructureRegionsAtPoint()`、`getMaterialAtPoint()`。
- 边界状态查询：`getGeometryStateAtPoint()`、`getMechanicalStateAtPoint()`。
- 计算节点自动布置：`buildAutomaticAnalysisNodePlacement()`、`autoPlaceAnalysisNodes()`。
- 自动网格划分：`buildAutomaticAnalysisMesh()`、`autoGenerateAnalysisMesh()`。
- 计算节点和网格写入：`createAnalysisNode()`、`setAnalysisMesh()`。
- 分类刷新：`classifyAnalysisNode()`、`classifyAnalysisNodes()`、`classifyAnalysisElement()`、`classifyAnalysisElements()`。
- 计算输入导出：`prepareCalculationModelData()`、`buildCalculationInputExport()`、`buildCalculationInputText()`、`exportCalculationInputFile()`、`saveCalculationInputToProjectFolder()`、`startCalculationWorkflow()`。
- 计算视图控制：`renderCalculationView()`、`fitCalculationViewToScene()`、`getCalculationViewState()`、`setCalculationViewState()`、`setCalculationLayer()`、`setCalculationTool()`。
- 边界交点维护：`detectCurveIntersections()`、`syncIntersectionGeometryNodes()`。
- 区域维护：`rebuildClosedRegions()`、`assignMaterialToRegion()`、`setRegionKind()`。

## 后续新增代码约定

新增功能优先按页面归属放入 `src/pages/<page>/`。多个页面共用的几何、材料、分类、数据格式逻辑放入 `src/core/`。只有全局配置、DOM 引用和跨页面共享状态放入 `src/global/state.js`。`app.js` 保持入口职责，不放具体算法。
