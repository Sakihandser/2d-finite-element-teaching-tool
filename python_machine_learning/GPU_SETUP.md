# GPU 训练环境

> 本文件保留 2026-10-20 的 CUDA 安装记录。当前程序已支持自动选择 GPU / CPU，
> 新安装请使用 [通用机器学习运行环境](RUNTIME_SETUP.md)，以下“尚未实现”仅描述当时进度。

本目录使用已有的 `.venv`，已配置 Windows x64、Python 3.14.5、PyTorch 2.14.1+cu130。
本次仅配置环境并进行合成数据自检，有限元模型的数据接口与正式图神经网络尚未实现。

## 已验证结果（2026-10-20）

- GPU：NVIDIA GeForce RTX 4070 Laptop GPU，8 GiB 显存。
- 驱动：610.60；PyTorch 使用的 CUDA 运行时：13.0。
- `torch.cuda.is_available()`：`True`。
- CUDA 矩阵计算、训练前向/反向传播、参数更新、图消息聚合反向传播：通过。
- 合成数据训练 60 步，损失由约 4.0101 降到 0.00642。
- 模型和 AdamW 优化器保存/恢复后，下一训练步与连续训练结果一致：通过。
- 原有 Lightning 2.6.6、TorchMetrics 1.9.0、Metric Learning 2.9.0 导入：通过。
- `pip check`：`No broken requirements found.`。

这些是小规模环境自检，不代表已测定完整有限元训练数据的显存需求或训练速度。
本次运行曾提示缺少 Triton 时无法统计 Triton 内核的 FLOP；上述 CUDA 训练检查均已通过。

## 使用与检查

在本目录打开 PowerShell，无需先激活虚拟环境，直接执行：

```powershell
.\.venv\Scripts\python.exe .\check_gpu.py
```

成功时输出 `status: PASS`，并在本目录写入 `gpu-check-result.json`。
检查内容包括 CUDA 矩阵计算、GPU 上的前向/反向传播与参数更新、图消息聚合的反向传播，
以及模型和优化器保存后恢复，验证恢复后的下一训练步与连续训练一致。
测试检查点仅存于临时目录，结束后自动移除。

编辑器应选择本目录 `.venv\Scripts\python.exe` 作为 Python 解释器。
正式训练时，模型和参与计算的张量都需要移到 `cuda` 设备。

## 安装记录与复现

- `requirements-gpu.txt`：固定 CUDA 版 PyTorch 及官方安装源。
- `environment-before-cuda.txt`：修改前的完整依赖快照。
- `environment-gpu-lock.txt`：安装后的完整依赖版本及 CUDA 源，可用于复现整个环境。
- `pytorch-cuda-install.log`：安装记录。
- `gpu-check-result.json`：最近一次成功自检的结果。

在已有虚拟环境安装对应版本：

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\requirements-gpu.txt
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe .\check_gpu.py
```

官方参考：[Windows 安装说明](https://pytorch.org/get-started/locally/)、
[CUDA 13.0 安装源](https://download.pytorch.org/whl/cu130/torch/)。

本次 pip 直接下载未能正常推进，随后从同一官方源下载并续传完整 wheel，
校验 SHA-256 后，在现有依赖均已满足的情况下通过本地 wheel 安装。
缓存的安装包也可复用：

```powershell
$wheelPath = Join-Path $env:LOCALAPPDATA 'pip\Cache\codex-cuda-setup\torch-2.14.1+cu130-cp314-cp314-win_amd64.whl'
.\.venv\Scripts\python.exe -m pip install $wheelPath
```

## 下载校验

官方 Windows/Python 3.14 wheel：`torch-2.14.1+cu130-cp314-cp314-win_amd64.whl`。

- 文件大小：1,998,854,405 字节。
- SHA-256 已核对，与官方响应头一致：`e25757e423be3c107a36d7495fa5aeb021b9ab506457cd7c7e068505f0283ae0`。
- 下载缓存位置：`%LOCALAPPDATA%\pip\Cache\codex-cuda-setup\`。
