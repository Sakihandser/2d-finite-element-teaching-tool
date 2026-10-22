# 计算核心导入接口说明

## 可选 GPU 单元计算

计算页面提供“使用 GPU 加速”，默认关闭，开启时提醒建议单元超过 200 万个再打开。服务器按每次请求明确选择 CPU/GPU，自适应各轮沿用开始时的设置，无兼容 GPU 时自动回退。

新增双精度 OpenCL 单元刚度、应变应力计算后端，检测兼容 GPU 并在失败时回退现有 CPU。`FEM_COMPUTE=cpu/auto/gpu` 可覆盖选择策略。经规模扫描未找到 GPU 优势时，默认 `auto` 保持 CPU；不再使用未经验证的 131072 单元门槛。其他机器测得交叉点后可通过 `FEM_GPU_MIN_ELEMENTS` 设置自动切换阈值。全局装配与 Eigen LDLT 求解仍在 CPU 上执行。实现范围及回退规则见 [GPU_COMPUTE.md](../docs/GPU_COMPUTE.md)。

更新时间：2026-10-08

## 已完成工作

- 新增 `CalculationData.h`：保存计算输入文件中所有当前求解相关数据结构。
- 新增 `CalculationBinaryIO.h` / `CalculationBinaryIO.cpp`：通过 stdin/stdout 二进制管道直接接收结构化模型并返回计算结果。
- `CalculationData.cpp`：保留 `calculation-data/calculation-input.txt` 的兼容解析，并提供文本与二进制入口共用的模型校验。
- `CalculationResultExport.h` / `CalculationResultExport.cpp`：在用户开启额外 TXT 输出或使用旧命令行方式时生成 `calculation-data/calculation-result.txt`。
- 新增 `PerformanceLog.h` / `PerformanceLog.cpp`：用稳定时钟记录输入、装配、求解、后处理和导出阶段耗时。
- 新增 `ElementCalculations.h`：统一三节点三角形单元的固定尺寸计算接口。
- 精简 `main.cpp`：只保留 `CalculationModel calculationModel` 变量和 `main()` 调用流程，不直接实现解析函数。
- 更新 Visual Studio 工程文件：把导入、导出和单元计算接口文件加入工程，启用 C++17 与 OpenMP。
- `Release` 构建使用 `/MT` 静态链接 MSVC C/C++ 运行库；便携包只需在 exe 同目录附带 OpenMP 的 `vcomp140.dll`。

## 默认二进制计算通道

由本地 Node.js 服务启动时，计算核心使用：

```text
计算力学程序计算核心.exe --binary-ipc
```

Node.js 把模型编码成版本化的 little-endian 二进制帧写入子进程 stdin，C++ 完成求解后把节点位移和单元结果帧写到 stdout。stdout 只承载二进制数据，诊断信息写入 stderr。这个流程不会读取或写入计算输入/结果 TXT。

如果操作界面开启“额外生成计算 TXT”，服务器会改用：

```text
计算力学程序计算核心.exe --binary-ipc --write-text
```

此时计算仍通过二进制管道传输，只额外生成输入和结果 TXT 供检查。性能日志始终生成，但它不参与前后端数据传输。

## TXT 兼容读取路径

不带 `--binary-ipc` 直接运行 exe 时，程序仍会从当前工作目录开始向上查找固定文件：

```text
calculation-data/calculation-input.txt
```

因此从项目根目录、C++ 工程目录，或 Visual Studio 生成目录运行时都能找到同一份输入文件。

## 数据存储结构

入口函数：

```cpp
std::filesystem::path fem::FindDefaultCalculationInputPath();
fem::CalculationModel fem::LoadCalculationInput(const std::filesystem::path& inputPath);
void fem::PrintCalculationModel(const fem::CalculationModel& model, std::ostream& output);
```

核心数据都存储在 `fem::CalculationModel` 中：

- `materials`：材料编号、弹性模量、泊松比、密度、屈服强度、抗拉强度、抗压强度。
- `nodes`：节点编号、坐标、`ux/uy` 约束、自由度号、节点载荷、材料号、区域号。
- `elements`：单元编号、逆时针节点编号、面积、质心、材料号和单元力学参数。
- `elementNodeLoads`：每个单元三个节点上的等效节点载荷。
- `counts`、`units`、`modelName`、`generatedAt`：文件头和统计信息。
- `fileWarnings`、`parserWarnings`：前端导出警告和 C++ 导入校验警告。

后续组装刚度矩阵时，直接从 `calculationModel.nodes`、`calculationModel.elements`、`calculationModel.materials` 和 `calculationModel.elementNodeLoads` 读取即可。

## TXT 兼容结果输出

使用旧命令行方式或指定 `--write-text` 时，求解完成后 `main.cpp` 会调用：

```cpp
fem::ExportCalculationResults(
    calculationModel,
    nodeDisplacement,
    Strain,
    Stress,
    securityCheckList);
```

结果会写入：

```text
calculation-data/calculation-result.txt
```

输出内容包括：

- `NODE_DISPLACEMENTS`：每个节点的 `ux`、`uy` 和位移模长。
- `ELEMENT_RESULTS`：每个单元的应变张量、应力张量和安全校核码。
- `SAFETY_CODE_MEANING`：安全校核码含义，`0` 正常，`1` 超过抗压强度，`2` 超过抗拉强度，`3` 超过屈服强度。

这个接口用于兼容人工检查和外部文本交换；浏览器中的正常计算和结果展示不依赖该文件。

## 性能分析日志

每次运行都会在计算核心目录的 `log` 文件夹生成一个带毫秒时间戳的独立日志：

```text
计算力学程序计算核心/log/performance-YYYYMMDD-HHMMSS-mmm.txt
```

日志包含模型名称、节点/单元/自由度数量、约束和载荷规模、Triplet 数量、稀疏矩阵非零元与密度、构建类型、求解器，以及各阶段总耗时、总耗时占比、调用次数和单次平均耗时。日志同时按执行顺序和耗时从高到低各输出一张表，便于直接定位瓶颈。程序在输入校验、矩阵分解或导出阶段提前退出时也会尽力生成失败日志并记录原因。

性能比较建议使用 `Release|x64`，对同一输入连续运行多次，并避免把 Debug 构建的耗时直接用于优化结论。

本地服务器会优先运行 `x64/Release/计算力学程序计算核心.exe`；只有 Release 未编译时才回退到 Debug。性能基准建议先运行一次预热，再对同一模型至少运行五次并取中位数。

完整模型表和逐节点位移的控制台输出默认关闭。需要排查输入或位移时，可以使用以下任一方式临时开启：

```text
计算力学程序计算核心.exe --verbose
```

或在启动前设置环境变量 `FEM_VERBOSE=1`。性能日志始终生成，不受详细输出开关影响。

二进制入口先批量读取 stdin，再通过边界检查的连续指针解码；二进制结果在连续缓冲区内组帧后一次写入 stdout。兼容 TXT 输入使用 `std::from_chars` 并根据 `COUNTS` 预留模型数组；TXT 结果使用连续缓冲区和 `std::to_chars` 格式化后一次写入。

## 单元计算与并行装配

- 单元刚度、单元位移、应变应力计算全部使用 `6x6`、`6x1`、`3x6`、`3x3`、`2x4` 等固定尺寸 Eigen 类型，避免单元循环中的动态矩阵分配，并允许编译器展开和向量化小矩阵运算。
- 读取模型后会一次性预计算每个单元的节点坐标、六个全局自由度和结果索引；刚度装配、位移提取和后处理共同复用，不再重复查询节点哈希表。
- 刚度矩阵采用统一的 `6x6` 自由度循环装配。OpenMP 模式下每个线程写入独立的 Triplet 数组，最后按线程顺序合并，避免共享 `vector` 的锁竞争。
- 单元刚度、单元位移提取、应变应力和安全校核均可并行执行。二维对称应力张量的主应力使用解析公式计算，不再为每个单元调用通用特征值求解器。
- 少于 2048 个单元时自动串行执行；更大模型默认使用不超过 8 个线程。可以在启动前设置 `FEM_THREADS` 覆盖线程数，例如：

```text
FEM_THREADS=4
```

性能日志中的“单元并行线程数”和各个细分阶段可用于比较不同线程数。当前程序一次启动只求解一个模型；预计算的自由度映射在本次求解内复用。如果后续改成长驻进程并对同一网格反复求解，可进一步把稀疏矩阵结构和求解器 `analyzePattern()` 结果提升为跨求解缓存。
