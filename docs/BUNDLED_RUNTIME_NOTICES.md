# Bundled runtime notices / 随包运行库说明

The GNNv1.1 full Release archive redistributes complete application runtimes.
The project's MIT license applies to original project code, not to these third-party components.
The existing Triangle distribution restrictions in the root `LICENSE` continue to apply.

GNNv1.1 完整附件包含第三方运行环境。项目 MIT 许可仅覆盖原创代码，
各第三方组件保留其自己的许可；根目录 `LICENSE` 中 Triangle 的分发限制继续适用。

- Python: each `.venv*` runtime contains `LICENSE.txt`; the complete standard library is bundled.
- Python packages: original package notices and `*.dist-info` metadata are retained under each runtime's `Lib/site-packages/`. `PACKAGES.txt` lists the installed environment.
- PyTorch and bundled accelerator libraries: retain the original PyTorch package's license files and third-party notices, including applicable CUDA component notices. GPU drivers are not redistributed.
- DirectML / TorchVision / NumPy / SciPy / Shapely and their dependencies retain their package license notices.
- Node.js: `node-v24.21.0-win-x64/LICENSE`.
- Triangle: `src/vendor/triangle-wasm/THIRD_PARTY_NOTICES.txt` and root `LICENSE`.
- The self-extracting archive uses the official 7-Zip 26.04 SFX module by Igor Pavlov. Its license is in `docs/third-party/7ZIP-LICENSE.txt`. Source: [official 7-Zip 26.04 release](https://github.com/ip7z/7zip/releases/tag/26.04), [7-Zip source repository](https://github.com/ip7z/7zip). The SFX module is unmodified.

Personal training data, developer caches and upstream reference sources retained only for local reading are not redistributed.
