# 随机数据生成参考代码

`fea-diffusion/` 是已下载到本机的上游随机生成源代码，固定提交
`a19d0980268edfc1d3893acc55f211479e7cfd07`：
[namanxkumar/fea-diffusion](https://github.com/namanxkumar/fea-diffusion)。

该提交未声明开源许可证，原始参考目录已被 `.gitignore` 排除，不参与程序运行。
接入本程序的独立实现位于同级上层的 `random_geometry.py`、`generation-core.cjs` 等文件。

重新获取参考代码可在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-fea-diffusion-reference.ps1
```

脚本只下载固定提交的九个参考文件，并写入 SHA256 清单，不执行下载的代码。
使用说明见 [随机训练模型生成器](../../docs/RANDOM_TRAINING_DATA.md)。
