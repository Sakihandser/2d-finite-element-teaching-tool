# 更新日志 / Changelog

## 2026-10-21 — Automatic GPU / CPU machine-learning runtimes

- GNNv1.1 bundles complete, isolated Python runtimes with relative import paths for offline, relocatable startup. Added a portable build script and detailed bilingual release notes comparing GNNv1.0.

- Added independent CPU and Windows DirectML environments without replacing the existing CUDA build. Added a repeatable dependency setup script.
- Probe the actual graph network, backward pass, AdamW and checkpoint recovery before selecting a GPU; try other available backends or CPU on failure. Show the selected backend in the training dashboard.
- Avoid zero-width edge-feature concatenation unsupported by DirectML, and store new network/optimizer checkpoints as CPU tensors for cross-backend recovery.
- Verified CPU, CUDA, DirectML on NVIDIA and Intel hardware, and CPU → CUDA → DirectML → CPU continued training. AMD hardware was not available; DirectML compatibility is documented with CPU fallback.

## 2026-10-20 — Generator defaults and timestamp seeds

- Set default refinement rounds to 7, per-round time limit to 30 seconds, and total reference-node cap to 30000 in both the UI and backend.
- Initialize seeds from the computer's local 14-digit timestamp (YYYYMMDDHHmmss), with a button to refresh the seed to the current second.
- Clarify that the reference-node cap applies to the entire refined mesh; retain the separate initial-node budget of 400.

## 2026-10-20 — Generator computation limits and strict automatic imports

- Moved refinement rounds, per-round timeout and reference-node cap into the main panel; added a total reference-case timeout and raised configurable limits. Lock batch settings while generation runs.
- Added explicit automatic-import destinations: training, validation, or seeded geometry-based splitting.
- Require achieved ZZ error to meet the requested target before any automatic import, including requests from older clients. Keep unmet references in history and report duplicate split conflicts.
- Bound native solves by the remaining case budget and preserve the last successfully solved mesh when that budget expires. Added real-solver rollback, routing and quality-gate coverage.

## 2026-10-20 — Generated history management

- Added physical deletion beside each historical case preview, plus deletion of the selected batch, all history, or all currently assigned history across every batch.
- Show file counts and sizes before confirmation and reject stale deletion lists. Preserve independent training-library copies and model checkpoints.
- Assign unregistered historical reference models to training or validation through the existing three-mesh importer and geometry-split checks. Detect deleted training copies and allow reassignment.
- Added temporary-store coverage for exact case-file matching, bulk scopes, checkpoint preservation, stale confirmations, unsafe paths, assignment failures, and operation locks.

## 2026-10-20 — Training dataset preview and physical deletion

- Added case-name/checkbox previews of stored geometry, materials, constraints and loads, with reference and input coarse-mesh views independent from the active drawing model.
- Added single and batch dataset deletion, with exact file counts, sizes and dependencies across historical checkpoints in the confirmation dialog.
- Permanently remove selected dataset directories, clear deleted selections and preview caches, and retain checkpoint weights, source JSONs and generation batch artifacts. Resuming and full model export require the deleted dependencies to be restored.
- Recheck deletion manifests and training locks before removal; added disposable-store deletion tests and scene-independent curved-preview coverage.

## 2026-10-20 — Random training model generation (machine-learning branch)

- Added a training-page generator for merged random primitives, conforming material partitions, holes, stable random supports, and point/distributed/body loads.
- Reuse the existing Triangle, C++ TRI3 solver and ZZ refinement to produce reference scenes and actual achieved-error labels, with optional automatic training import and strict target filtering.
- Added seeded geometry/physics, geometry-based validation grouping, frozen material snapshots, process isolation, node/time limits, stop-after-case, persisted manifests, preview and JSON downloads.
- Downloaded fea-diffusion generation sources for local reference at a pinned commit. New runtime code is independently implemented; upstream has no declared license and its sources are excluded from distribution.
- Added geometry, native solver, reference rollback, batch persistence and localization regression coverage. See `docs/RANDOM_TRAINING_DATA.md`.

## 2026-10-20 — Neural mesh training (machine-learning branch)

- Added a CUDA multiscale graph network that predicts local mesh sizes from geometry, materials, supports and prescribed loads, with Triangle-based constrained node generation.
- Added a training dashboard for JSON datasets, independent-case and learning counters, loss curves, new runs, save/pause/resume, and prediction download/application.
- Persist model, optimizer, data cursor/order, random states and training statistics in versioned checkpoints; retain previous generations and recover across process restarts.
- Keep achieved ZZ error and stopping reason with each reference mesh, reject train/validation geometry overlap, and expose the absence of independent validation.
- Verified GPU training on the supplied crack case and documented a prediction that did not meet its requested error, alongside recovery and regression tests. See `python_machine_learning/README.md`.

## 2026-10-15 — Configurable adaptive time limit

- Added a maximum time per round in seconds, editable after enabling adaptive meshing; the default remains 10 seconds.
- Automatic adaptation, Refine Once, native solver timeouts, and refinement worker timeouts use the selected limit and keep the last successful result on timeout.
- Added validation and regression coverage for custom durations, timeout propagation, and control availability.

## 2026-10-13 — Adaptive time protection

- Stop adaptive refinement once a round reaches 10 seconds, keeping the last successful mesh and result.
- Terminate adaptive native solves after 10 seconds and restore the previous solved mesh on timeout; ordinary solves keep their existing 120-second limit.
- Run refinement in a dedicated Web Worker with a 10-second timeout so runaway Triangle refinement can be cancelled without blocking the UI.

## 2026-10-13 — Adaptive boundary material fix

- Preserved constrained Triangle region attributes during element classification so refinement near curved holes and material interfaces cannot overwrite solid elements with air or another material.
- Added adaptive material/area validation before native solves and element-specific diagnostics for invalid ZZ inputs.

## 2026-10-13 — Adaptive controls

- Changed the default adaptive refinement limit to 6 steps.
- Enabling adaptive mode clears the existing analysis mesh and places fresh seed nodes; automatic adaptive calculations rebuild from a fresh seed.
- Added Refine Once to refine the current mesh by one step and solve the resulting mesh, with existing failure recovery and size protections.

## 2026-10-13 — Calculation settings

- Added a default-off GPU acceleration checkbox. Enabling it shows a recommendation to wait until more than two million elements; each request selects CPU/GPU explicitly, with CPU fallback and a consistent choice across adaptive rounds.
- Increased the ordinary default analysis-node limit to 20,000, adaptive refinement steps to 10, and tightened the default relative-error target to 0.02 (2%).

## 2026-10-13 — GPU compute crossover measurements

- Swept 2,048–991,232 elements with five paired CPU/GPU solves at each size, checked a retained GPU context, and benchmarked nine real ZZ/Triangle adaptive mesh snapshots. No GPU crossover was found on i9-13900HX + RTX 4070 Laptop GPU with the current element-only OpenCL backend.
- Removed the unmeasured 131,072-element automatic switch. Default auto mode retains CPU when no validated crossover exists; `FEM_GPU_MIN_ELEMENTS` supports a measured threshold on other hardware, while forced GPU mode and CPU fallback remain available.
- Added reproducible benchmarks, raw per-run timings and [measurement details](docs/GPU_BENCHMARK.md).

## 2026-10-13 — Adaptive mesh refinement

- Replaced the point-force patch's coarse central cutoff with a continuous size field and explicit center refinement. The center is finer than its surrounding ring while background refinement continues. Triangle memory now grows beyond its former fixed 16 MB limit, with refreshed IO views; validated during a 320,000-triangle mesh operation.
- Combined adaptive density selection with the existing Triangle WASM refinement engine. Preserves a valid ordinary mesh, replaces maximum-error-only marking with bulk/background selection, and skips locally saturated point-force patches while refining other regions. An eight-round native C++ point-force regression completes without premature small-element failure.
- Improved adaptive triangle connections with constrained local diagonal flips after every refinement and before the initial solve. Added a native C++ elliptical-slit regression: minimum angle improves from 2.27° with the preceding fixed connections to 12.59°, while the tip stress concentration and closed hole are preserved.
- Adaptive mode now ignores the ordinary node limit, uses an independent coarse initial mesh, disables the node-limit input, and migrates meshes from the former capped workflow. Refinement stops according to error and iteration count.
- Added optional ZZ stress-recovery refinement adapted from MFEM 4.10 Example 21 for the existing plane-stress TRI3 solver.
- Added conforming shared-edge local refinement, material interface separation, boundary/load provenance, bounded iteration history, and restoration of the last solved mesh on failure.
- Retained relevant MFEM reference code and license notices; removed the unused downloaded library files.
- Verified local mesh topology, load preservation, estimator integration and native C++ adaptive cantilever solves.

## v1.1.0 — 2026-10-13 — 参数化几何绘制与 GPU 渲染优化

### 新增

- 绘图页面新增规则图形入口，支持矩形、等腰三角形、圆形和椭圆形。
- 参数窗口支持精确输入尺寸、旋转角度及质心坐标，修改参数时实时预览。
- 拖动预览图形的质心即可放置，支持现有吸附设置；确认创建后转为可继续编辑的边界，取消或按 Escape 可放弃预览。
- 圆与椭圆使用精确的有理二次曲线边界，支持场景保存、导入和后续网格划分。
- 新界面提供中文和英文文案。

### 性能优化

- 绘图、计算和结果页面的网格、分析节点、变形图及结果云图优先使用 WebGL，向浏览器请求高性能 GPU。
- 缓存 GPU 顶点及颜色缓冲区，平移、缩放和调整变形倍率时复用数据。
- WebGL 不可用、初始化失败或上下文丢失时自动回退到 Canvas 2D；上下文恢复后可重新启用 GPU。
- 优化结果写回、范围及视图边界缓存，合并鼠标和滚轮触发的重绘，停止隐藏页面的动画。
- 保留原有数值求解过程；实际使用的 GPU 由浏览器、驱动和系统设置决定。

### 验证

- 27 项自动化测试通过，涵盖网格、计算通信、载荷显示、语言切换、规则图形、GPU 渲染和结果性能。
- 使用 20,000 个三角形验证主要页面及结果模式的 WebGL 渲染和 Canvas 2D 回退。
- 增加 32,768 个三角形的浏览器基准页面，支持上下文丢失及恢复验证。该页面测量 JavaScript 绘制提交耗时，不代表完整 GPU 帧耗时或整机帧率。

v1.1.0 Windows 便携 ZIP 包含这些新增功能及运行依赖，解压后双击 `RUN_PROGRAM.bat` 启动。已有 v1.0.0 ZIP 保留为历史版本。

### English summary

- Add parameter-based rectangles, isosceles triangles, circles and ellipses with precise dimensions, rotation, centroid coordinates, live previews and centroid dragging.
- Use exact rational quadratic boundaries for circles and ellipses, integrated with scene import/export and meshing.
- Prefer WebGL for meshes, analysis nodes, deformation and result clouds; cache GPU buffers and automatically fall back to Canvas 2D when needed.
- Reduce CPU work in result mapping, view bounds and redraw scheduling without changing the numerical solver.
- Pass 27 automated tests and verify rendering with 20,000 triangles. Add a browser benchmark and context-loss recovery checks.
- The v1.1.0 Windows portable ZIP includes these updates and runtime dependencies. Extract it and run `RUN_PROGRAM.bat`.
