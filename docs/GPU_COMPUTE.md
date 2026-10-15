# GPU 辅助力学计算

## 代码审查结论

| 阶段 | 入口 | 当前路径与本次调整 |
| --- | --- | --- |
| 节点布置 | `src/core/analysis-node-placement.js` | JavaScript：几何边界种子、区域内候选点、孔洞过滤、节点去重与分类，继续 CPU。 |
| 网格划分 | `src/core/analysis-mesh.js` | Triangle/WASM：PSLG 约束三角剖分、孔洞及边界恢复与覆盖检查，继续 CPU。 |
| 自适应细化 | `src/core/adaptive-mesh.js` | JavaScript：应力恢复、误差估计、标记及拓扑细化，继续 CPU；每轮调用 C++ 求解时使用相同后端选择规则。 |
| TRI3 单元刚度 | `计算力学程序计算核心/main.cpp`、`KeCalculation.cpp` | 新增可选 OpenCL FP64 批量计算。CPU 原公式与 OpenMP 回退保留。 |
| 全局装配、约束、线性求解 | `main.cpp` | 继续 CPU Triplet 装配和 Eigen::SimplicialLDLT 直接求解。 |
| 应变应力 | `StressStrainCalculation.cpp` | 新增可选 OpenCL FP64 批量计算，仍使用原平面应力公式和单位厚度。 |
| 强度校核、导出 | `securityCheck.cpp`、二进制/TXT 导出 | 继续现有 CPU 路径及数据协议。 |

绘图已有的 WebGL GPU 加速与本次新增的力学计算后端是两个独立功能。不能把 GPU 绘图等同于 GPU 求解。

## 自动选择与回退

计算页面新增 **计算设置 → 使用 GPU 加速**，默认不勾选。开启时显示提醒：建议单元数量超过 200 万个再开启；这是一项使用建议，不是实测得到的交叉点，也不限制小模型开启。未勾选时服务器明确使用 CPU，勾选后明确尝试 GPU，不受下面命令行自动阈值影响。界面选择按每次请求传递，不修改服务器全局环境；自适应各轮沿用开始计算时的选择。重新加载页面时恢复默认关闭。

以下环境变量用于直接运行 native 求解器及性能测试。命令行默认 `FEM_COMPUTE=auto`（不设置等价）：**没有经过实测验证的交叉点时，继续 CPU**。已撤销此前未经验证的 131072 单元门槛，避免自适应细化到大网格后反而变慢。当前 i9-13900HX + RTX 4070 Laptop GPU 的规模扫描结果见 [GPU 基准报告](GPU_BENCHMARK.md)。

其他硬件测得稳定交叉点后，可设置正整数 `FEM_GPU_MIN_ELEMENTS`；`auto` 会在达到该单元数时尝试 GPU，低于它继续 CPU。空值表示没有经过验证的阈值，非正整数、溢出或非法字符串继续 CPU 并记录原因。`FEM_COMPUTE=gpu` 可以绕过阈值执行测试。阈值依赖硬件、后端实现和进程生命周期，不能将一台机器的数字直接当作通用阈值。

GPU 要求：Windows 显卡驱动提供系统 `OpenCL.dll`、可用 GPU 设备、硬件双精度和 OpenCL C 1.2 内核编译支持。只枚举 GPU，不把 OpenCL CPU 设备当作显卡。CPU 计算机不需要安装 OpenCL/CUDA SDK；exe 动态加载系统 OpenCL，缺失时正常回退，不产生启动时 DLL 依赖。

设备枚举、内核编译、显存分配、传输或执行报错，以及非有限值或抽样 CPU 对照检查失败，都会禁用本次 GPU 后端并重新运行失败阶段的完整 CPU 循环。GPU 结果检查完成后才一次性提交，避免使用部分输出。后处理失败时，已经验证成功的 GPU 刚度结果可继续使用，应变应力回退到 CPU。

FP64 设备能力依据 [Khronos clGetDeviceInfo](https://registry.khronos.org/OpenCL/specs/unified/refpages/man/html/clGetDeviceInfo.html) 查询；保留双精度，不以单精度替代原数值精度。CPU/GPU 的运算顺序仍可能导致舍入差异，结果不要求逐位相同。

## 手动控制

直接运行 native 求解器或基准脚本时可以设置；正常界面计算由勾选框覆盖 `FEM_COMPUTE`：

```powershell
# 自动选择（默认）
$env:FEM_COMPUTE = 'auto'
& '.\计算力学程序计算核心\x64\Release\计算力学程序计算核心.exe'
```

`FEM_COMPUTE=cpu` 始终走原 CPU 实现，适合性能基线与严格旧 TXT 基准比较。`FEM_COMPUTE=gpu` 忽略规模阈值，尝试 GPU，但仍允许自动回退。`FEM_GPU_MIN_ELEMENTS` 仅在 `auto` 模式下有效。可选 `FEM_GPU_DEVICE=NVIDIA` 等区分大小写的设备名称子串用于指定显卡；没有匹配的兼容设备就回退。未指定时选择计算单元数最多的兼容 GPU；该选择不保证是所有设备中最快的。

每次性能日志记录 GPU 状态、回退原因、刚度计算和应变应力计算分别使用的后端，并记录 GPU 初始化阶段耗时。二进制 stdout 协议保持不变，诊断通过 stderr 输出。

## 验证与性能限制

已在 Intel UHD + NVIDIA RTX 4070 Laptop GPU 的 Windows 机器上编译 Release/x64，并验证：

- CPU 小模型与旧二进制/TXT 夹具。
- 自动小模型 CPU 选择、指定不存在 GPU 时的 CPU 回退。
- 混合材料、非均匀坐标、约束及双向载荷的 16928 单元模型，跨越每批 16384 单元的边界。
- 131072 单元模型的默认 CPU 路径、显式设置阈值后的 GPU 自动选择和边界行为。
- 全部节点位移、应变应力和安全码与 CPU 对照；结果数值采用相对容差 `1e-8`，应力绝对容差 `1e-5 Pa`，安全码完全一致。

实际计时显示 **RTX 4070 上上述模型的 GPU 路径更慢**。一次 131072 单元运行中，CPU 单元刚度和应变应力各约 2.5 ms，GPU 对应约 26 ms 和 11 ms，额外 GPU 初始化约 749 ms；CPU LDLT 数值分解约 945 ms，仍占主要时间。具体结果随驱动缓存、温度、并行负载与设备变化。这次实现验证了可选 GPU 计算及 CPU 回退能力，不能据此声称整体提速。

预热后交替顺序各运行五次，131072 单元模型的完整进程/IPC 耗时中位数为 CPU **1278.4 ms**、GPU **2127.2 ms**。在这台机器上建议设置 `FEM_COMPUTE=cpu`。完整 Node 测试集 53 项通过，GPU 专项验证使用 `FEM_TEST_REQUIRE_GPU=1`，没有把 GPU 不可用的跳过结果当作实际 GPU 验证。

以上是最初的单规模验证；后续规模扫描、常驻 GPU 上下文及实际自适应网格序列的结果以 [GPU_BENCHMARK.md](GPU_BENCHMARK.md) 为准。当前自适应每一轮都启动新的 native 进程，因此不会复用 GPU 上下文或 LDLT 分解；网格改变时也不能直接复用上一轮数值分解。

要进一步获得明显加速，应优先优化主要瓶颈：保持求解进程及 GPU 上下文常驻、复用稀疏结构/分解，以及独立验证 GPU 稀疏求解器与预条件方法。几何布点和 Triangle 的约束拓扑算法不能仅通过“检测 GPU”迁移；替换它们需要重新验证边界、孔洞、材料界面和网格质量。

运行验证：

```powershell
.\node-v24.21.0-win-x64\node.exe --test tests/gpu-compute.test.js tests/calculation-ipc.test.js
# 有兼容 GPU 的开发机可要求测试必须真正执行 GPU
$env:FEM_TEST_REQUIRE_GPU = '1'
# 可选：预热后各跑五次并报告完整进程/IPC时间中位数
$env:FEM_GPU_BENCHMARK = '1'
.\node-v24.21.0-win-x64\node.exe --test tests/gpu-compute.test.js
```

## 编译与许可证

Visual Studio 工程已包含 `GpuElementBackend.cpp/.h`，无需链接 OpenCL 导入库或安装 CUDA。`vendor/opencl/CL` 收录 Khronos OpenCL-Headers `v2024.10.24` 所需三个头文件，来自 [Khronos 官方仓库](https://github.com/KhronosGroup/OpenCL-Headers/tree/v2024.10.24)，许可证见 `vendor/opencl/LICENSE`（Apache-2.0）。头文件仅用于编译。
