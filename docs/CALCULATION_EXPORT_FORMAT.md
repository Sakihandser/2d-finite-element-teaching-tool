# C++ 计算输入导出格式

更新时间：2026-10-08

## 接口位置

- 浏览器界面：计算页左侧“导出计算文件”按钮。
- 程序接口：`window.femSketchApi.buildCalculationInputText()` 返回纯文本输入内容；`window.femSketchApi.buildCalculationInputExport()` 保留为内部调试用 JSON 对象。
- 文件接口：`window.femSketchApi.exportCalculationInputFile()` 会直接覆盖写入项目内 `calculation-data/calculation-input.txt`。
- 正常求解接口：`window.femSketchApi.startCalculationWorkflow()` 把结构化模型交给本地 Node.js 服务，再通过二进制管道直接传给 C++。
- 实现文件：`src/core/calculation-export.js`、`calculation-ipc.js` 和 `server.js`。

## 设计目标

这个文本格式用于人工检查、外部程序交换和旧命令行兼容，不保存画布缩放、标签页、选中对象等前端编辑状态。当前程序已经可以自动生成计算节点，并通过 `triangle-wasm` 的 PSLG 约束 Delaunay triangulation 自动生成 TRI3 单元。网格只有在约束边完整且各区域面积覆盖校验通过后才会进入求解或导出流程。“开始计算”默认直接传输结构化数据；只有用户开启“额外生成计算 TXT”或点击“导出计算文件”时才写入 `calculation-data/`。

## 文本结构

文本文件使用固定段落和空格分隔字段，方便 C++ 用普通文件流读取：

```text
FEM_CALCULATION_INPUT_TXT_V1
MODEL model_name
GENERATED_AT iso_time
UNITS LENGTH=model FORCE=N ELASTIC_MODULUS=Pa DENSITY=kg/m3 STRENGTH=Pa
COUNTS NODES=n ELEMENTS=m MATERIALS=k POINT_LOADS=p DISTRIBUTED_LOADS=q

MATERIALS
# matNo E nu rho yield tensile compressive

NODES
# nodeNo x y fixUx fixUy dofUx dofUy Fx Fy matNo regionNo

ELEMENTS
# elemNo n1 n2 n3 area cx cy matNo E nu rho yield tensile compressive

ELEMENT_NODE_LOADS
# elemNo Fx1 Fy1 Fx2 Fy2 Fx3 Fy3

WARNINGS
END
```

## 单位约定

- 坐标：保持当前模型坐标，默认按 m 或工程建模时采用的长度单位解释。
- 力：`N`。
- 分布力：`N/m`。
- 弹性模量：导出为 `Pa`。
- 屈服、抗拉、抗压强度：导出为 `Pa`。
- 密度：`kg/m^3`。
- 泊松比：无量纲。

材料库界面中输入的弹性模量是 `GPa`，强度是 `MPa`；导出时已经转换成 C++ 更常用的 SI 数值。

## 节点字段

`NODES` 段按一行一个节点输出，适合 C++ 按顺序读取。每个节点包含：

- `nodeNo`：连续 1 基节点号。
- `x`、`y`：节点坐标。
- `fixUx`、`fixUy`：约束标记，固定为 1，自由为 0。
- `dofUx`、`dofUy`：二维平面问题自由度号。
- `Fx`、`Fy`：该节点上的全局等效载荷，包含点载荷、分布力等效载荷和体力等效载荷。
- `matNo`、`regionNo`：材料号和结构区域号，缺省为 0。

`placement.sourceType` 用于说明节点如何生成，常见值包括 `geometryNode`、`curveBoundary`、`pointLoad`、`regionCentroid` 和 `regionInterior`。后续网格划分模块也可以直接读取场景中的 `analysisNodePlacement.boundarySegments` 和 `analysisNodePlacement.regionNodeSets` 作为边界约束与区域节点集。

## 单元字段

`ELEMENTS` 段目前只导出三节点三角形单元：

- `elemNo`：连续 1 基单元号。
- `n1`、`n2`、`n3`：该单元包含的三个节点号，按逆时针顺序。
- `area`、`cx`、`cy`：单元面积和质心。
- `matNo`：材料号。
- `E`、`nu`、`rho`、`yield`、`tensile`、`compressive`：该单元直接使用的力学参数。

导出时会检查三角形有向面积；如果节点顺序是顺时针，会自动交换后两个节点，保证三个节点按逆时针顺序输出。

## 载荷字段

节点总载荷直接写在 `NODES` 段的 `Fx`、`Fy` 字段中，可用于组装整体右端项。当前节点总载荷会累加点载荷、边界分布力等效节点载荷和体力等效节点载荷。

`ELEMENT_NODE_LOADS` 段按单元记录分布力和体力折算后的等效节点载荷。每行顺序为 `elemNo Fx1 Fy1 Fx2 Fy2 Fx3 Fy3`，节点顺序对应 `ELEMENTS` 段中的 `n1 n2 n3`。点载荷只写入全局节点载荷，不在相邻单元中重复写入，避免装配时重复加载。

## 后续网格模块对接

自动布置计算节点可调用：

```js
const { analysisNodes, placement } = window.femSketchApi.autoPlaceAnalysisNodes({
  maxNodes: 2000
});
```

若只想预览布点结果而不写入场景，可调用 `window.femSketchApi.buildAutomaticAnalysisNodePlacement({ maxNodes })`。自动划分 TRI3 网格可调用：

```js
const { elements, mesh } = await window.femSketchApi.autoGenerateAnalysisMesh({
  maxNodes: 2000
});
```

`autoGenerateAnalysisMesh()` 和 `buildAutomaticAnalysisMesh()` 会异步加载本地 WASM 并返回 Promise；前者会在缺少计算节点或布点已失效时自动重新布点，然后生成 `mesh.elements` 和 `mesh.metadata`。如果外部模块自己生成网格，仍可继续调用：

```js
window.femSketchApi.setAnalysisMesh({
  analysisNodes: [
    { id: "A1", x: 0, y: 0 },
    { id: "A2", x: 1, y: 0 },
    { id: "A3", x: 0, y: 1 }
  ],
  elements: [
    { id: "E1", analysisNodeIds: ["A1", "A2", "A3"] }
  ]
});
```

`setAnalysisMesh()` 会继续负责节点/单元的区域、材料和静态/自由分类；文本导出器只读取这些统一字段，不需要知道网格划分算法来自哪里。

## 可选文本文件导出

本地服务器提供 `POST /api/calculation-models`。用户点击“导出计算文件”，或在“输出设置”中开启“额外生成计算 TXT”时，服务器固定覆盖保存到：

```text
calculation-data/calculation-input.txt
```

如果直接以静态文件方式打开页面，Chrome/Edge 会在首次写入时弹出文件夹选择。选择项目根目录或 `calculation-data` 文件夹都可以，程序会创建或覆盖 `calculation-data/calculation-input.txt`。这是浏览器安全机制要求的用户授权，不会再下载整份 JSON 模型文件。

首次授权后，前端会把 `calculation-data` 的文件夹句柄保存在浏览器本地缓存中。后续再次点击“导出计算文件”时，会优先复用该文件夹并直接覆盖写入；如果浏览器需要重新确认，文件夹选择器会优先从上一次授权的位置打开。自动运行 C++ 计算核心仍需通过本地服务启动页面。

## C++ 导入接口

C++ 控制台程序位于 `TensoraCore/`。正常界面计算使用 `CalculationBinaryIO.h/.cpp` 从 stdin 解码模型；文本兼容导入拆分在 `CalculationData.h/.cpp`。两个入口最终使用同一个 `CalculationModel` 和同一套校验。

本地服务使用以下参数启动直接传输：

```text
TensoraCore.exe --binary-ipc
```

不带参数直接运行程序时，才会自动向上查找兼容输入文件：

```text
calculation-data/calculation-input.txt
```

解析后的数据存储在 `fem::CalculationModel`：

- `materials`：材料参数。
- `nodes`：节点坐标、约束、自由度和节点总载荷。
- `elements`：TRI3 单元节点、面积、质心和材料参数。
- `elementNodeLoads`：分布力折算到每个单元三个节点的等效节点载荷。
- `fileWarnings` / `parserWarnings`：前端导出警告和 C++ 导入校验警告。

完整模型和逐节点控制台输出默认关闭，可用 `--verbose` 临时开启。

## C++ 计算结果输出

C++ 计算核心默认把结果以二进制帧写回 stdout，由 Node.js 解码并直接交给结果页，不生成结果 TXT。用户开启“额外生成计算 TXT”时，本地服务追加 `--write-text`，才会覆盖写入：

```text
calculation-data/calculation-result.txt
```

文本实现位于 `TensoraCore/CalculationResultExport.h` 和 `CalculationResultExport.cpp`；二进制结果实现位于 `CalculationBinaryIO.h` 和 `CalculationBinaryIO.cpp`。

结果文件结构如下：

```text
FEM_CALCULATION_RESULT_TXT_V1
MODEL model_name
GENERATED_AT iso_time
SOURCE_INPUT path_to_calculation_input
UNITS DISPLACEMENT=model STRAIN=1 STRESS=Pa
COUNTS NODES=n ELEMENTS=m

NODE_DISPLACEMENTS
# nodeNo ux uy magnitude

ELEMENT_RESULTS
# elemNo strain_xx strain_xy strain_yx strain_yy stress_xx stress_xy stress_yx stress_yy safetyCode safetyText

SAFETY_CODE_MEANING
# 0 OK
# 1 COMPRESSION_LIMIT
# 2 TENSILE_LIMIT
# 3 YIELD_LIMIT
END
```

读取时可以先识别首行版本号，再按段落名读取。所有数值字段使用空格分隔，适合 C++、JavaScript 或其他主程序用普通文本流逐项读取。
