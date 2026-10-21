# GNNv1.1 — 通用 GPU / CPU 与免配置完整运行包 / Universal GPU / CPU and Self-contained Runtime

发布分支 / Release branch: `machine-learning`

对比版本 / Compared with: [GNNv1.0](https://github.com/Sakihandser/2d-finite-element-teaching-tool/releases/tag/GNNv1.0)

完整差异 / Full diff: [GNNv1.0...GNNv1.1](https://github.com/Sakihandser/2d-finite-element-teaching-tool/compare/GNNv1.0...GNNv1.1)

## 中文更新说明

GNNv1.1 解决上一版“界面新建训练必须使用兼容 NVIDIA CUDA 环境”和“下载后还需手动安装 Python 依赖”两个问题。
本次保留原有多尺度图神经网络、训练数据生成和有限元验算流程，新增自动设备选择、跨后端续训及完整便携运行环境。

### 与 GNNv1.0 的直接对比

| 项目 | GNNv1.0 | GNNv1.1 |
| --- | --- | --- |
| 从界面新建训练 | 固定请求 CUDA；CUDA 不可用时拒绝开始 | 自动使用通过自检的 GPU；无可用 GPU 时使用 CPU |
| NVIDIA 显卡 | 依赖兼容的 CUDA 版 PyTorch | 保留原 CUDA 环境；不可用时继续尝试其他后端或 CPU |
| AMD / Intel 等显卡 | 没有 GPU 训练接入 | Windows DirectML 接入兼容显卡，具体设备须通过实际训练自检 |
| CPU 训练 | 底层和测试有 CPU 路径，界面入口不自动使用 | 无独显、驱动不兼容或 GPU 后端不可用时仍可训练和预测 |
| 发行附件 | 包含 Node.js 和求解器，需要自行配置 Python / PyTorch | 同时包含 Python 本体、CPU / CUDA / DirectML 环境及依赖 |
| 环境隔离 | 单一 `.venv` CUDA 环境 | 三套隔离环境，不覆盖彼此所需的 PyTorch / NumPy 版本 |
| 检查点 | 在训练设备上序列化网络和优化器张量 | 新检查点统一保存 CPU 张量，支持跨后端读取和续训 |
| 设备显示 | CUDA 信息或 CUDA 不可用提示 | 显示实际设备、后端及 PyTorch 版本，可查看探测诊断 |

### 自动选择设备与故障回退

- 启动训练服务时，按 CUDA → ROCm → Intel XPU → DirectML → MPS → CPU 的顺序探测已安装环境。发行包预装 CUDA、DirectML 和 CPU；其余为用户另行配置环境时的识别入口，不代表本发行包支持所有平台。
- 先检查所有 GPU 候选，再尝试 CPU，避免某个环境中的 CPU 路径遮挡另一套环境中的 GPU。
- 不只检查显卡名称或驱动标志：通过实际 `MeshSizingNetwork` 前向计算、损失、反向传播、梯度裁剪、AdamW 更新、检查点写入与恢复后的下一步计算进行验证。
- 单个 GPU 不支持网络算子时，继续尝试后续适配器和其他后端；缺包、导入失败、驱动不兼容、自检失败及探测进程超时或崩溃均会进入后续候选。
- 训练、验证、预测和恢复训练共用所选后端。默认策略保证优先使用可用 GPU，不是多显卡速度跑分，也不承诺选择最快的显卡。
- 训练开始后新发生的显存不足或设备故障会报告失败，保留最近完整检查点供恢复；不会静默重复已经执行的优化步。
- 有限元求解器的 OpenCL GPU 计算开关仍独立控制；此处自动选择针对 GNN。

### 完整便携运行包：无需另装 Python 或下载依赖

本次附件为 `2d-finite-element-teaching-tool-windows-x64-GNNv1.1-full.exe`，是自解压发行包。
下载后运行附件，选择解压位置，完成后进入生成的程序目录，双击 `RUN_PROGRAM.bat`。
首次进入“神经网络训练”页面需要完成本机后端自检，请等待状态显示设备名称。
首次从机械硬盘或受实时扫描影响的目录加载大型库可能需要较长时间；已延长探测及连接时限，避免误判 CPU 不可用。

完整包包含：

- Node.js 24.21.0、Windows x64 原生有限元求解器及其运行库。
- PyTorch 所需的 Microsoft Visual C++ Release CRT 运行库，随各 Python 解释器本地部署，无需用户另装 VC 运行库。
- `.venv-cpu`：Python 3.14.5、PyTorch `2.14.1+cpu`、NumPy、SciPy、Shapely。
- `.venv`：Python 3.14.5、现有 PyTorch `2.14.1+cu130` CUDA 环境及其依赖。
- `.venv-directml`：Python 3.12.13、`torch-directml 0.2.5.dev240914`、PyTorch `2.4.1`、TorchVision `0.19.1`、NumPy `1.26.4`、SciPy 和 Shapely。
- 对应源码、使用文档、环境依赖清单和第三方许可声明。

发行包携带 Python 本体和标准库，而不只是复制引用开发电脑路径的 `pyvenv.cfg`。
各解释器使用相对于自身目录的路径，隔离本机 Python 注册表配置、`PYTHONHOME` 和 `PYTHONPATH`。
隔离环境内显式使用 UTF-8 通信，保留中文模型名、路径和错误提示。
无需安装 Python、uv、pip、完整 CUDA Toolkit 或 cuDNN，也无需激活环境；解压完成后启动程序不需要联网下载包。
GPU 加速仍需要操作系统自带或用户已安装的兼容显卡驱动；本包不安装或更新显卡驱动。

**请下载此 Release 的完整附件。GitHub 自动生成的 “Source code (zip/tar.gz)” 只有源码，不包含上述完整运行环境和 Node.js 可执行文件。**
完整包体积较大，解压时应预留足够空间，且不能直接在压缩包内部启动程序。
不包含开发者的个人训练数据、训练记录、预训练权重、日志或仅供本地阅读的上游参考源码。
第三方环境保留应用所需代码、动态库和许可文件，不包含构建扩展所用的开发头文件、静态库和第三方测试套件。

### DirectML 兼容性及性能边界

- 面向 Windows x64 和 DirectX 12 兼容的 AMD、Intel、NVIDIA 等显卡；并非所有型号和驱动都能通过本网络自检。
- DirectML 使用 Microsoft 当前发布的预览包，要求较早版本的 PyTorch，因此放在独立 Python 3.12 环境中，CPU / CUDA 环境不随之降级。
- 修复粗图传播中零宽度边特征的拼接方式，并处理无图边情况，避开 DirectML 不支持的空张量拼接路径，保持网络输入含义。
- 部分图聚合运算会由 DirectML 回退 CPU，形成混合执行，不能保证比纯 CPU 快。
- 本机已验证 DirectML 在 NVIDIA RTX 4070 Laptop 和 Intel UHD 核显上运行实际网络；没有 AMD 真机，因此未验证 AMD 的实际速度或具体驱动组合。
- Windows AMD 通用路径使用 DirectML；不宣称本包包含 AMD 原生 ROCm，也不宣称支持全部 AMD 显卡。原生 ROCm 另有系统、Python 及显卡支持矩阵。

### 模型、优化器和训练进度迁移

- 新检查点中的网络和优化器张量统一转换为 CPU 张量，避免将 CUDA / DirectML 私有设备标签写入便携检查点。
- 读取时先映射到 CPU，再恢复到当前运行后端；保留模型参数、AdamW 状态、工况列表、轮次、数据顺序、游标和统计信息。
- 兼容读取原有检查点；GPU 随机状态仅在兼容后端恢复。跨设备、PyTorch 版本和显卡型号的浮点运算不保证逐位一致。
- 保留训练、模型管理、检查点分支、随机数据生成、几何分组验证和预测网格验算功能；本次没有更换 GNN 架构，也没有发布新的训练权重。

升级建议：先在旧程序中保存并暂停训练，备份整个 `python_machine_learning/storage/`，将新版解压到新目录后复制该目录。
完整恢复或导出模型仍需要检查点所引用的训练数据，不能只迁移裸权重。

### 验证与适用范围

- 当前代码快照的 **104 项 Node.js / JavaScript 测试和 37 项 Python 测试全部通过**。

- 机器学习回归测试覆盖 CPU 训练、精确中途恢复、模型导入导出、数据管理、生成器和设备回退；前端 / Node.js 测试覆盖原生求解、生成器、双语界面和便携解释器选择。
- 已验证 CPU、CUDA / RTX 4070 Laptop、DirectML / RTX 4070 Laptop、DirectML / Intel UHD 的真实网络训练与优化器恢复。
- 同一临时工况成功按 CPU 第 8 步 → CUDA 第 10 步 → DirectML 第 12 步 → CPU 第 14 步顺序迁移续训。
- 便携目录以无开发工具 PATH、无效外部 `PYTHONHOME` / `PYTHONPATH` 验证，解释器、标准库与第三方包均从发行目录加载；发布前执行独立目录启动与完整性检查。
- 预测的目标误差仍只是条件输入，不代表已达到该精度。请继续使用有限元求解及误差估计验算；本次不新增跨几何泛化精度承诺。

## English release notes

GNNv1.1 removes two limitations of GNNv1.0: the new-training interface required a compatible NVIDIA CUDA environment, and the downloadable application required a separate Python dependency installation.
This release retains the existing multiscale graph network, data generation and finite element verification workflows while adding automatic backend selection, cross-backend recovery and a complete portable runtime.

### Changes compared with GNNv1.0

| Area | GNNv1.0 | GNNv1.1 |
| --- | --- | --- |
| Starting training from the interface | Hardcoded CUDA request; rejected when CUDA was unavailable | Use a GPU that passes actual training checks; otherwise use CPU |
| NVIDIA GPUs | Required a compatible CUDA PyTorch installation | Preserve CUDA; try other available backends or CPU when it fails |
| AMD / Intel and other GPUs | No GPU training integration | Windows DirectML support for compatible devices that pass the network probe |
| CPU training | CPU paths existed in the model/tests but were not selected by the interface | Training and prediction remain available without a usable GPU |
| Downloadable application | Node.js and solver included; Python dependencies installed separately | Python itself and CPU / CUDA / DirectML environments included |
| Dependency isolation | One CUDA `.venv` | Separate environments retain their required PyTorch / NumPy versions |
| Checkpoints | Network and optimizer tensors serialized on the training device | New checkpoint tensors serialized on CPU for portable loading and recovery |
| Device status | CUDA details or a CUDA-unavailable warning | Actual device, backend, PyTorch version and probe diagnostics |

### Automatic selection and fallback

- Probe installed environments in CUDA → ROCm → Intel XPU → DirectML → MPS → CPU order. This Windows distribution preinstalls CUDA, DirectML and CPU. The other entries recognize separately configured environments and do not imply that all platforms are supported by this package.
- Try all GPU candidates before CPU, so a CPU path in one environment does not hide a working GPU in another.
- Validate the actual `MeshSizingNetwork`, loss, backward propagation, gradient clipping, AdamW update, checkpoint serialization and the next step after optimizer recovery. A device name or driver flag alone is insufficient.
- Try subsequent adapters and backends when an adapter fails. Missing dependencies, import failures, incompatible drivers, unsupported operations, probe timeouts and crashed probe processes can fall back to another environment.
- Training, validation, prediction and restored runs share the selected backend. Selection prefers a usable GPU; it does not benchmark adapters or promise the fastest device.
- A new out-of-memory or device failure during an active run is reported. Restore the last complete checkpoint; the application does not silently repeat optimizer steps.
- The finite element solver's OpenCL GPU setting remains independent of GNN device selection.

### Self-contained download: no separate Python or dependency setup

Download `2d-finite-element-teaching-tool-windows-x64-GNNv1.1-full.exe`, run the self-extracting archive, choose an extraction location, then open the extracted application directory and double-click `RUN_PROGRAM.bat`.
The first connection to the neural-network training page performs local backend checks; wait for the device status to appear.
Cold starts on mechanical disks or directories affected by real-time scanning can take longer. Probe and connection timeouts allow for slow native-library loading rather than prematurely rejecting CPU fallback.

The complete package contains:

- Node.js 24.21.0, the Windows x64 native finite element solver and its runtime libraries.
- Microsoft Visual C++ release CRT libraries required by PyTorch, deployed alongside each Python interpreter without a separate VC runtime installation.
- `.venv-cpu`: Python 3.14.5, PyTorch `2.14.1+cpu`, NumPy, SciPy and Shapely.
- `.venv`: Python 3.14.5, the existing PyTorch `2.14.1+cu130` CUDA environment and its dependencies.
- `.venv-directml`: Python 3.12.13, `torch-directml 0.2.5.dev240914`, PyTorch `2.4.1`, TorchVision `0.19.1`, NumPy `1.26.4`, SciPy and Shapely.
- Application source, documentation, installed-package inventories and third-party license notices.

The application includes Python executables and standard libraries rather than merely copying a virtual environment that references the developer's machine.
Each interpreter uses paths relative to its own directory and ignores external Python registry configuration, `PYTHONHOME` and `PYTHONPATH`.
Portable runtimes explicitly use UTF-8 protocol streams so Chinese model names, paths and diagnostics remain intact despite environment isolation.
No separate Python, uv, pip, full CUDA Toolkit, cuDNN or environment activation is required. Once extracted, startup does not download dependencies.
GPU acceleration still requires an existing compatible display driver. The archive does not install or update drivers.

**Use the complete attached asset. GitHub's automatically generated “Source code (zip/tar.gz)” downloads contain source only and omit these complete runtimes and the Node.js executable.**
Allow sufficient disk space and fully extract before launching.
Developer datasets, training records, pretrained weights, logs and upstream reference sources retained only for local reading are excluded.
Third-party environments retain application code, dynamic libraries and license notices; extension-development headers, static libraries and third-party test suites are omitted.

### DirectML compatibility and performance

- The Windows x64 DirectML path supports compatible DirectX 12 GPUs from AMD, Intel, NVIDIA and other vendors, subject to actual network checks. Not every device/driver combination is guaranteed.
- Microsoft's currently published preview package requires an older PyTorch build. It is isolated in Python 3.12 without downgrading CPU or CUDA environments.
- Coarse propagation avoids concatenating zero-width edge features, and graphs without edges have an explicit path, preserving network input semantics while avoiding unsupported DirectML empty-tensor operations.
- Some indexed graph aggregation operations fall back to CPU. This is mixed execution and is not guaranteed to outperform CPU-only training.
- Real network training has been checked on DirectML with an NVIDIA RTX 4070 Laptop and Intel UHD integrated graphics. AMD hardware was unavailable, so AMD performance and specific driver combinations remain unverified.
- DirectML is the general AMD path in this Windows package. Native AMD ROCm is not bundled; its own operating-system, Python and GPU compatibility matrix still applies.

### Checkpoint and training-state portability

- New checkpoints convert network and optimizer tensors to CPU before saving, avoiding device-specific CUDA / DirectML serialization tags.
- Load on CPU first, then restore to the selected backend while retaining model parameters, AdamW state, case lists, epochs, data order, cursor and statistics.
- Existing checkpoints remain readable. GPU random state is restored only on a compatible backend. Cross-device, cross-version and cross-GPU floating-point trajectories are not guaranteed to be bitwise identical.
- Existing training, checkpoint branching, model management, random data generation, geometry-based validation isolation and predicted-mesh verification workflows remain available. This release does not replace the GNN architecture or provide new trained weights.

For upgrades, save and pause the old application, back up the entire `python_machine_learning/storage/` directory, extract this release to a new directory and copy the backup there.
Complete restoration and model export still require the datasets referenced by checkpoints; copying bare weights is insufficient.

### Validation and scope

- **All 104 Node.js / JavaScript tests and 37 Python tests passed** for this source snapshot.

- Machine-learning regression checks cover CPU training, exact mid-run recovery, model packages, dataset management, generation and device fallback. Frontend / Node.js checks cover native solves, generation, localization and portable interpreter selection.
- Actual graph training and optimizer recovery passed on CPU, CUDA / RTX 4070 Laptop, DirectML / RTX 4070 Laptop and DirectML / Intel UHD.
- A disposable case resumed sequentially from CPU step 8 to CUDA step 10, DirectML step 12 and CPU step 14.
- Portable interpreters were checked with a development-tool-free PATH and invalid external `PYTHONHOME` / `PYTHONPATH`; Python and dependencies load from the distribution directory. Relocated startup and archive integrity are checked before publication.
- Requested prediction error remains a conditioning input, not a verified accuracy guarantee. Verify meshes with the finite element solver and error estimator. This release makes no additional cross-geometry generalization claim.

## Documentation / 文档

- [Runtime setup and support limits / 运行环境与支持边界](https://github.com/Sakihandser/2d-finite-element-teaching-tool/blob/GNNv1.1/python_machine_learning/RUNTIME_SETUP.md)
- [GNN workflow and model management / GNN 使用与模型管理](https://github.com/Sakihandser/2d-finite-element-teaching-tool/blob/GNNv1.1/python_machine_learning/README.md)
- [Microsoft DirectML / PyTorch](https://learn.microsoft.com/en-us/windows/ai/directml/pytorch-windows)
- [PyTorch installation reference / PyTorch 安装参考](https://pytorch.org/get-started/locally/)
- [AMD native ROCm support matrix / AMD 原生 ROCm 支持矩阵](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/windows/windows_compatibility.html)
