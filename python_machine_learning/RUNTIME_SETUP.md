# 通用机器学习运行环境

在机器学习分支启动 `RUN_PROGRAM.bat`，训练服务会探测已安装的各个隔离环境，
优先使用通过自检的 GPU，所有 GPU 不可用时使用 CPU。训练、验证、预测和续训共用所选设备。
训练页右上角显示设备、后端和 PyTorch 版本；鼠标悬停可查看探测失败原因。
本改动仅作用于神经网络训练，有限元求解器的 OpenCL GPU 开关继续独立控制。

## Release 完整包：解压即用

GNNv1.1 的 `*-full.exe` 自解压附件已包含 Python 本体、标准库及 CPU / CUDA / DirectML 三套环境。
运行附件并解压，进入程序目录双击 `RUN_PROGRAM.bat`，无需安装 Python、uv 或下载依赖。
程序包中的 Python 使用相对路径隔离加载，可移动到其他目录；此方式不同于直接复制开发用虚拟环境。
完整包不包含个人训练数据或预训练权重；需要迁移时请另行备份整个 `storage/`。
请下载完整附件，GitHub 自动生成的源码 ZIP / tar.gz 不含运行环境。

GPU 仍需要兼容的操作系统和显卡驱动。DirectML 支持范围和性能限制见下文。
发布详情见 [GNNv1.1 中英双语说明](../docs/RELEASE_NOTES_GNNv1.1.md)。

## 从源码在新电脑安装

适用于 Windows x64。先安装 uv（`winget install --id astral-sh.uv -e`），重新打开 PowerShell，
在机器学习分支根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ml.ps1
```

脚本通过 uv 下载 Python 和所需 wheel，默认安装 CPU 与 DirectML；CPU 必须安装成功，
DirectML 安装或自检失败会保留 CPU 使用能力。首次需要网络和足够磁盘空间，之后启动无需联网下载。
NVIDIA 用户可运行 `scripts/setup-ml.ps1 -WithCuda` 额外安装当前 CUDA 构建；
只需 CPU 可运行 `scripts/setup-ml.ps1 -CpuOnly`。
`-CpuOnly` 只控制安装范围，不移除已有 GPU 环境，也不改变运行时的 GPU 优先策略。

以下说明针对开发用虚拟环境；完整 Release 包已将解释器和标准库一并便携化。
不要将不同版的 torch 安装进同一个环境，也不要直接复制其他电脑的开发用 `.venv` 作为安装方式。
Python 虚拟环境引用本机解释器路径，换电脑应重新运行安装脚本，并复制需要的整个 `storage/`。
现有 `.venv` 和训练数据不会被默认安装过程覆盖。

## 后端与限制

| 环境 | 已安装组合 | 作用 |
| --- | --- | --- |
| `.venv` | Python 3.14 / torch 2.14.1+cu130 | 现有 NVIDIA CUDA 环境，需要兼容驱动和 GPU |
| `.venv-cpu` | Python 3.14 / torch 2.14.1+cpu | 独立 CPU 保底，不依赖 CUDA 或显卡驱动 |
| `.venv-directml` | Python 3.12 / torch-directml 0.2.5.dev240914 / torch 2.4.1 | Windows DirectX 12 兼容的 AMD、Intel、NVIDIA 等 GPU |

DirectML 使用 Microsoft 当前发布的预览包，因此固定旧版 torch，并独立使用 NumPy 1.26。
CPU/CUDA 环境不因此降级。DirectML 的部分 `index_add` 图聚合会由框架回退 CPU，
其余受支持运算在所选 GPU 执行；无法保证比纯 CPU 快。驱动、算子支持和可用内存均影响能否使用 GPU。
只用硬件名称判断不足以保证训练正常，因此自动选择必须通过真实训练自检。
现有数据与检查点应来自可信来源，尤其 DirectML 环境使用较早的 PyTorch 版本。

启动器也识别用户另外配置的 `.venv-rocm`、`.venv-xpu`，支持兼容构建中的 ROCm / Intel XPU；
设备模块还识别 MPS，但这不代表整个 Windows 应用已移植到 macOS。
这些可选后端未在本机实测，安装脚本不会下载硬件专用的 ROCm / XPU 构建。
AMD 的原生 ROCm 有独立的系统、Python 和显卡支持矩阵；本次 Windows AMD 通用路径使用 DirectML。

选择顺序为 CUDA → ROCm → XPU → DirectML → MPS → CPU。
每种后端按设备序号依次检查，首个适配器失败仍会尝试后续适配器。
每次自检在独立进程中运行，有超时保护；缺包、导入失败、驱动不兼容、算子错误或自检进程崩溃均可继续尝试。
这不是按速度跑分的策略，不保证选择电脑上最快的一块 GPU。
训练开始后出现新的内存不足或设备故障会报告失败，可从最近完整检查点恢复，不会静默重跑优化步。

## 自检、指定设备与检查点

从 `python_machine_learning/` 运行：

```powershell
.\.venv-cpu\Scripts\python.exe check_runtime.py --backend cpu
.\.venv\Scripts\python.exe check_runtime.py --backend cuda
.\.venv-directml\Scripts\python.exe check_runtime.py --backend directml
```

这些命令使用合成小图，检查真实 MeshSizingNetwork、图聚合、损失、反向传播、梯度裁剪、AdamW、
CPU 张量序列化以及模型和优化器恢复后的下一训练步。不会修改用户模型。
不同后端的新检查点均保存为 CPU 张量；读取旧 CUDA 检查点也使用 CPU 映射，再加载到当前设备。
跨后端或版本续训保留模型、优化器、轮次与数据位置，不承诺浮点轨迹逐位一致。

调试时可在启动程序前设置 `$env:FEM_ML_DEVICE='cpu'`，或指定 `cuda`、`directml` 等后端。
删除此环境变量即恢复自动模式。明确指定后端时不可用会报错，不会擅自换后端。
`FEM_ML_PYTHON` 可追加一个自定义 Python 环境作为候选，仍按全局后端优先级探测。

## 本机验证（2026-10-21）

- CPU 版 PyTorch、CUDA / RTX 4070 Laptop、DirectML / RTX 4070 Laptop、DirectML / Intel UHD 核显均通过图网络训练与恢复自检。
- 临时工况跨环境顺序续训通过：CPU 第 8 步 → CUDA 第 10 步 → DirectML 第 12 步 → CPU 第 14 步。
- CPU 环境的训练、模型管理、数据管理、随机生成和设备选择回归测试通过；原有 Node.js 测试通过。
- 安装脚本已实际运行，重新执行复用已安装包，不覆盖现有 CUDA 环境。
- 本机没有 AMD 显卡，AMD 真机性能和驱动兼容性尚未验证。支持范围依据 DirectML 官方文档，自检失败时使用 CPU。

回归命令：

```powershell
.\.venv-cpu\Scripts\python.exe -m unittest -v test_training test_model_management test_dataset_management test_random_geometry test_device_runtime
.\.venv-cpu\Scripts\python.exe test_runtime_transfer.py
```

第二条需要本机同时有可用 CUDA 和 DirectML 环境。前一条不需要 GPU；可先设置 `FEM_ML_DEVICE=cpu`。

官方依据：[PyTorch 安装说明](https://pytorch.org/get-started/locally/)、
[Microsoft DirectML / PyTorch](https://learn.microsoft.com/en-us/windows/ai/directml/pytorch-windows)、
[torch-directml 发布包](https://pypi.org/project/torch-directml/)、
[AMD Windows 支持矩阵](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/windows/windows_compatibility.html)。
